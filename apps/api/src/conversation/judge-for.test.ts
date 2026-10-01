import { describe, expect, it, vi } from 'vitest';

import type { CallJudge, CallJudgments } from '../integrations/judgment/judgment.interface';
import { NoopJudge } from '../integrations/judgment/noop.judge';
import { judgeFor, judgeForTraced, pendingQuestion } from './judge-for';
import { initialContext, type ConversationContext } from './types';

const LOCATION: CallJudgments = { location: { text: 'I-95, exit 42', status: 'complete', confidence: 0.9, probabilities: {} } };
const RISK: CallJudgments = { risk: { text: 'help me now', danger: 0.1, hazard: 'none', hazardProbability: 0, urgent: 0.95 } };
const SERVICE: CallJudgments = { service: { text: "won't start", service: 'jump_start', confidence: 0.5, alternatives: ['jump_start', 'tow'] } };

function judge(overrides: Partial<CallJudge> = {}): CallJudge {
  return {
    judgeLocation: vi.fn(async () => LOCATION),
    judgeService: vi.fn(async () => SERVICE),
    judgeSpeech: vi.fn(async () => RISK),
    judgeOverlap: vi.fn(async () => null),
    judgeReply: vi.fn(async () => null),
    ...overrides,
  };
}

const READ_BACK_PENDING: ConversationContext = {
  ...initialContext({ customerPhone: '+18174098408', serviceType: 'towing', location: 'I-95 near exit 42', vehicleType: 'semi truck' }),
  fieldVersion: 3,
  pendingConfirmation: { kind: 'details', fieldVersion: 3, callerTurn: 4 },
};

describe('judgeFor', () => {
  it('judges the location an update will save, refined onto the road already given', async () => {
    const j = judge();
    const ctx = initialContext({ location: 'I-95' });

    const judgments = await judgeFor(j, ctx, { kind: 'update', slots: { location: 'exit 42', customerName: 'Mike' } }, { knownAreas: ['Dallas'] });

    expect(j.judgeLocation).toHaveBeenCalledWith('I-95, exit 42', ['Dallas']);
    expect(j.judgeService).not.toHaveBeenCalled();
    expect(j.judgeSpeech).not.toHaveBeenCalled();
    expect(judgments).toEqual(LOCATION);
  });

  it('judges nothing for an update without a location', async () => {
    const j = judge();

    expect(await judgeFor(j, initialContext(), { kind: 'update', slots: { customerName: 'Mike' } })).toEqual({});
    expect(j.judgeLocation).not.toHaveBeenCalled();
  });

  it('judges a problem saved as the help needed, with what is known of the vehicle and the place', async () => {
    const j = judge();
    const ctx = initialContext({ vehicleCondition: 'engine died' });

    const judgments = await judgeFor(j, ctx, { kind: 'update', slots: { serviceType: "won't start", location: 'I-88, mile marker 23' } });

    expect(j.judgeService).toHaveBeenCalledWith("won't start", { problem: 'engine died', location: 'I-88, mile marker 23' });
    // Both are asked side by side, and both answers come back.
    expect(judgments).toEqual({ ...LOCATION, ...SERVICE });
  });

  it.each(['tow', 'I need a jump start', 'locked out of my car', 'flat tire'])('leaves "%s" alone: it already names the help', async (said) => {
    const j = judge();
    await judgeFor(j, initialContext(), { kind: 'update', slots: { serviceType: said } });
    expect(j.judgeService).not.toHaveBeenCalled();
  });

  it('judges a spoken line with what is known, and for the help needed while that is not saved', async () => {
    const j = judge();

    const judgments = await judgeFor(j, initialContext({ location: 'I-95' }), { kind: 'caller_speech', text: ' help me now ' });

    expect(j.judgeSpeech).toHaveBeenCalledWith('help me now', { location: 'I-95', serviceMissing: true });
    expect(judgments).toBe(RISK);

    await judgeFor(j, initialContext({ serviceType: 'tow', vehicleCondition: 'blowout' }), { kind: 'caller_speech', text: 'hurry' });
    expect(j.judgeSpeech).toHaveBeenLastCalledWith('hurry', { problem: 'blowout' });
  });

  it('adds the question the caller is answering while a read-back is pending', async () => {
    const j = judge();

    await judgeFor(j, READ_BACK_PENDING, { kind: 'caller_speech', text: "Yep, that's it." });

    expect(j.judgeSpeech).toHaveBeenCalledWith("Yep, that's it.", {
      location: 'I-95 near exit 42',
      pending: {
        kind: 'details',
        question: 'Are these details correct?',
        readBack: expect.arrayContaining([
          { label: 'Location', value: 'I-95 near exit 42' },
          { label: 'Callback number', value: '+18174098408' },
        ]),
      },
    });
  });

  it('asks about the callback number while that question is pending', () => {
    const ctx: ConversationContext = { ...initialContext({ customerPhone: '+18174098408' }), pendingConfirmation: { kind: 'callback_number', fieldVersion: 0, callerTurn: 1 } };
    expect(pendingQuestion(ctx)).toEqual({ kind: 'callback_number', question: expect.stringContaining('+18174098408') });
  });

  it('asks no confirmation question when none is pending, or the read-back is stale', () => {
    expect(pendingQuestion(initialContext())).toBeUndefined();
    expect(pendingQuestion({ ...READ_BACK_PENDING, fieldVersion: 4 })).toBeUndefined();
  });

  it.each([
    { kind: 'state' } as const,
    { kind: 'silence' } as const,
    { kind: 'complete', callerConfirmed: true } as const,
    { kind: 'judgment', text: 'hi', judgments: {} } as const,
  ])(
    'judges nothing for %j',
    async (op) => {
      const j = judge();
      expect(await judgeFor(j, initialContext(), op)).toEqual({});
      expect(j.judgeLocation).not.toHaveBeenCalled();
      expect(j.judgeSpeech).not.toHaveBeenCalled();
    },
  );

  it('decides by the rules when the judge has nothing to say or fails', async () => {
    const silent = judge({ judgeLocation: vi.fn(async () => null) });
    expect(await judgeFor(silent, initialContext(), { kind: 'update', slots: { location: 'I-95' } })).toEqual({});

    const broken = judge({ judgeSpeech: vi.fn(async () => Promise.reject(new Error('boom'))) });
    expect(await judgeFor(broken, initialContext(), { kind: 'caller_speech', text: 'hi' })).toEqual({});
  });
});

describe('judgeForTraced', () => {
  it('lists each question put to the judge, how long it took and what it found', async () => {
    const traced = await judgeForTraced(judge(), initialContext({}), { kind: 'update', slots: { location: 'I-95, exit 42', vehicleCondition: "won't start", serviceType: "won't start" } });
    expect(traced.asked.map((a) => a.about).sort()).toEqual(['location', 'service']);
    const location = traced.asked.find((a) => a.about === 'location')!;
    expect(location.text).toBe('I-95, exit 42');
    expect(location.ms).toBeGreaterThanOrEqual(0);
    expect(location.found).toEqual(['location complete (0.90)']);
  });

  it('lists a question that came back with nothing, so the trail shows the rules decided alone', async () => {
    const traced = await judgeForTraced(judge({ judgeSpeech: vi.fn(async () => null) }), initialContext({}), { kind: 'caller_speech', text: 'Hello?' });
    expect(traced.asked).toEqual([expect.objectContaining({ about: 'speech', text: 'Hello?', found: [] })]);
  });

  it('lists nothing when there is no judge, only rules', async () => {
    const traced = await judgeForTraced(new NoopJudge(), initialContext({}), { kind: 'caller_speech', text: 'Hello?' });
    expect(traced.asked).toEqual([]);
  });
});
