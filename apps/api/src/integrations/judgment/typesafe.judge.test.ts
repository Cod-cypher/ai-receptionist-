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
      answers: { hazard: chosen({ none: 0.1, accident: 0.42, injury: 0.45, fire_or_fuel: 0.03 }), urgent: { type: 'noul', noul: 0.88 } },
      usage,
    });
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch });

    const judgments = await judge.judgeSpeech('my leg is stuck and it hurts', 'I-95');

    expect(judgments).toEqual({
      risk: { text: 'my leg is stuck and it hurts', danger: expect.closeTo(0.9, 5), hazard: 'injury', hazardProbability: 0.45, urgent: 0.88 },
    });
    expect(sent[0]!.body.state).toEqual({ caller_said: 'my leg is stuck and it hurts', location: 'I-95' });
    expect(Object.keys(sent[0]!.body.questions)).toEqual(['hazard', 'urgent']);
  });

  it('returns nothing and warns once when TypeSafe is unavailable', async () => {
    const { fetch } = api({ error: 'overloaded' }, 529);
    const onWarning = vi.fn();
    const judge = new TypeSafeJudge({ apiKey: 'test-key', fetch, onWarning });

    expect(await judge.judgeLocation('I-95', [])).toBeNull();
    expect(await judge.judgeSpeech('hello', undefined)).toBeNull();

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
