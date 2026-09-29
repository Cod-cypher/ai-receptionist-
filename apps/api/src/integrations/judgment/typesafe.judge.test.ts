import { describe, expect, it, vi } from 'vitest';

import { TypeSafeJudge } from './typesafe.judge';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

/** A TypeSafe API that answers every request with `body`. */
function api(body: unknown, status = 200) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return { fetch, sent };
}

const scored = (probabilities: Record<string, number>, confidence: number) => ({
  type: 'score',
  score: Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0),
  confidence,
  legend: {},
  probabilities,
});
const chosen = (probabilities: Record<string, number>) => {
  const [choice, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: 'choice', choice, confidence, probabilities };
};
const usage = { input_tokens: 40, output_tokens: 0 };

describe('TypeSafeJudge', () => {
  it('asks about a location and the danger in it in one request, and reads the precision level', async () => {
    const { fetch, sent } = api({
      model: 'jev-1.13.0',
      answers: { precision: scored({ '0': 0.05, '1': 0.85, '2': 0.1 }, 0.78), hazard: chosen({ none: 0.97, live_traffic: 0.03 }) },
      usage,
    });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeLocation('I-95', ['Dallas', 'Fort Worth']);

    expect(judgments).toEqual({
      location: { text: 'I-95', status: 'partial', confidence: 0.78, probabilities: { '0': 0.05, '1': 0.85, '2': 0.1 } },
      risk: { text: 'I-95', danger: expect.closeTo(0.03, 5), hazard: 'live_traffic', hazardProbability: 0.03, urgent: null },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(sent[0]!.headers.authorization).toBe('Bearer test-key');
    expect(sent[0]!.body.model).toBe('jev-latest');
    expect(sent[0]!.body.state).toMatchObject({ location: 'I-95', business_service_areas: ['Dallas', 'Fort Worth'] });
    expect(sent[0]!.body.questions.precision.type).toBe('score');
    expect(sent[0]!.body.questions.precision.criteria).toHaveLength(3);
    expect(sent[0]!.body.questions.hazard.type).toBe('choice');
    expect(Object.keys(sent[0]!.body.questions.hazard.criteria)).toContain('none');
  });

  it('calls a location precise when the top level has the most probability', async () => {
    const { fetch } = api({
      model: 'jev-1.13.0',
      answers: { precision: scored({ '0': 0.02, '1': 0.28, '2': 0.7 }, 0.55), hazard: chosen({ none: 1 }) },
      usage,
    });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeLocation('Liberty Market', []);

    expect(judgments?.location).toMatchObject({ status: 'complete', confidence: 0.55 });
  });

  it('reads danger as a whole from a spoken line, with the most likely kind and the urgency', async () => {
    // A crash with an injury: two true answers share the probability. Danger is their sum.
    const { fetch, sent } = api({
      model: 'jev-1.13.0',
      answers: {
        hazard: chosen({ none: 0.1, accident: 0.42, injury: 0.45, fire_or_fuel: 0.03 }),
        urgent: { type: 'noul', noul: 0.88 },
        move: chosen({ request: 0.9, other: 0.1 }),
        topic: chosen({ none: 0.97, other: 0.03 }),
      },
      usage,
    });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeSpeech('my leg is stuck and it hurts', { location: 'I-95' });

    expect(judgments).toEqual({
      risk: { text: 'my leg is stuck and it hurts', danger: expect.closeTo(0.9, 5), hazard: 'injury', hazardProbability: 0.45, urgent: 0.88 },
      move: { text: 'my leg is stuck and it hurts', callerTurn: -1, move: 'request', confidence: 0.9 },
    });
    expect(sent[0]!.body.state).toEqual({ caller_said: 'my leg is stuck and it hurts', location: 'I-95' });
    expect(Object.keys(sent[0]!.body.questions)).toEqual(['hazard', 'urgent', 'move', 'topic']);
  });

  it('knows a question about the price or the arrival time, in whatever words', async () => {
    const { fetch } = api({
      model: 'jev-1.13.0',
      answers: {
        hazard: chosen({ none: 1 }),
        urgent: { type: 'noul', noul: 0.2 },
        move: chosen({ question: 0.98, request: 0.02 }),
        topic: chosen({ price: 0.93, other: 0.07 }),
      },
      usage,
    });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeSpeech("What's the damage going to be?", {});

    expect(judgments?.move).toEqual({ text: "What's the damage going to be?", callerTurn: -1, move: 'question', confidence: 0.98, topic: 'price' });
  });

  it('judges whether a reply answered what the caller said', async () => {
    const { fetch, sent } = api({ model: 'jev-1.13.0', answers: { answered: { type: 'noul', noul: 0.04 } }, usage });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeReply('What will it cost me?', 'Is that all correct?');

    expect(judgments).toEqual({ reply: { text: 'What will it cost me?', reply: 'Is that all correct?', answered: 0.04 } });
    expect(sent[0]!.body.state).toEqual({ caller_said: 'What will it cost me?', receptionist_replied: 'Is that all correct?' });
  });

  it('hears a complaint about the call as a complaint', async () => {
    const { fetch } = api({
      model: 'jev-1.13.0',
      answers: {
        hazard: chosen({ none: 1 }),
        urgent: { type: 'noul', noul: 0.2 },
        move: chosen({ complaint: 0.94, question: 0.06 }),
        topic: chosen({ other: 0.5, none: 0.5 }),
      },
      usage,
    });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeSpeech('Why do you keep cutting me off?', {});

    expect(judgments?.move).toEqual({ text: 'Why do you keep cutting me off?', callerTurn: -1, move: 'complaint', confidence: 0.94 });
  });

  it('judges the help needed from a line, while none is saved, with the two likeliest kinds to offer', async () => {
    const { fetch, sent } = api({
      model: 'jev-1.13.0',
      answers: {
        hazard: chosen({ none: 1 }),
        urgent: { type: 'noul', noul: 0.3 },
        move: chosen({ request: 1 }),
        topic: chosen({ none: 1 }),
        service: chosen({ jump_start: 0.5, tow: 0.4, unclear: 0.06, lockout: 0.04 }),
      },
      usage,
    });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeSpeech("I turned the key but the car won't start", { location: 'side of the highway', serviceMissing: true });

    expect(judgments?.service).toEqual({
      text: "I turned the key but the car won't start",
      service: 'jump_start',
      confidence: 0.5,
      alternatives: ['jump_start', 'tow'],
    });
    expect(Object.keys(sent[0]!.body.questions)).toContain('service');
  });

  it('judges what was saved as the help needed, within the shorter limit a tool call can wait', async () => {
    const { fetch, sent } = api({ model: 'jev-1.13.0', answers: { service: chosen({ tow: 0.9, winch_out: 0.1 }) }, usage });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeService("it's stuck, it's not moving", { location: 'I-88, mile marker 23' });

    // An alternative below the floor is not worth offering.
    expect(judgments).toEqual({ service: { text: "it's stuck, it's not moving", service: 'tow', confidence: 0.9, alternatives: ['tow'] } });
    expect(sent[0]!.body.state).toEqual({ caller_said: "it's stuck, it's not moving", problem_described: null, location: 'I-88, mile marker 23' });
  });

  it('asks whether a line confirms or corrects the question the caller is being asked', async () => {
    const { fetch, sent } = api({
      model: 'jev-1.13.0',
      answers: {
        hazard: chosen({ none: 0.98, other_danger: 0.02 }),
        urgent: { type: 'noul', noul: 0.1 },
        move: chosen({ request: 0.95, other: 0.05 }),
        topic: chosen({ none: 1 }),
        confirms: { type: 'noul', noul: 0.93 },
        corrects: { type: 'noul', noul: 0.04 },
      },
      usage,
    });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeSpeech("Yep, that's it.", {
      location: 'I-95 near exit 42',
      pending: { kind: 'details', question: 'Are these details correct?', readBack: [{ label: 'Vehicle', value: 'Honda Civic' }] },
    });

    expect(judgments?.confirmation).toEqual({ text: "Yep, that's it.", callerTurn: -1, confirms: 0.93, corrects: 0.04 });
    expect(judgments?.risk?.danger).toBeCloseTo(0.02, 5);
    expect(sent[0]!.body.state).toEqual({
      caller_said: "Yep, that's it.",
      location: 'I-95 near exit 42',
      question_asked: 'Are these details correct?',
      details_read_back: ['Vehicle: Honda Civic'],
    });
    expect(Object.keys(sent[0]!.body.questions)).toEqual(['hazard', 'urgent', 'move', 'topic', 'confirms', 'corrects']);
  });

  it('asks whether words said over the receptionist answered it', async () => {
    const { fetch, sent } = api({ model: 'jev-1.13.0', answers: { answers: { type: 'noul', noul: 0.12 } }, usage });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeOverlap('Uh-huh.', 'So that is a Honda Civic at exit 12.');

    expect(judgments).toEqual({ overlap: { text: 'Uh-huh.', answers: 0.12 } });
    expect(sent[0]!.body.state).toEqual({ receptionist_said: 'So that is a Honda Civic at exit 12.', caller_said: 'Uh-huh.' });
  });

  it('returns nothing and warns once when TypeSafe is unavailable', async () => {
    const { fetch } = api({ error: 'overloaded' }, 529);
    const onWarning = vi.fn();
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch, onWarning });

    expect(await judge.judgeLocation('I-95', [])).toBeNull();
    expect(await judge.judgeSpeech('hello', {})).toBeNull();

    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]![0]).toContain('529');
    // No retries: a call cannot wait on a backoff.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns nothing when the answers are not what was asked', async () => {
    const { fetch } = api({ model: 'jev-1.13.0', answers: { precision: { type: 'noul', noul: 1 } }, usage });
    const onWarning = vi.fn();
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch, onWarning });

    expect(await judge.judgeLocation('I-95', [])).toBeNull();
    expect(onWarning.mock.calls[0]![0]).toContain('no score answer for "precision"');
  });
});
