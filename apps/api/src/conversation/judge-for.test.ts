import { describe, expect, it, vi } from 'vitest';

import type { CallJudge, CallJudgments } from '../integrations/judgment/judgment.interface';
import { judgeFor, pendingQuestion } from './judge-for';
import { initialContext, type ConversationContext } from './types';

const LOCATION: CallJudgments = { location: { text: 'I-95, exit 42', status: 'complete', confidence: 0.9, probabilities: {} } };
const RISK: CallJudgments = { risk: { text: 'help me now', danger: 0.1, hazard: 'none', hazardProbability: 0, urgent: 0.95 } };

function judge(overrides: Partial<CallJudge> = {}): CallJudge {
  return {
    judgeLocation: vi.fn(async () => LOCATION),
    judgeSpeech: vi.fn(async () => RISK),
    judgeOverlap: vi.fn(async () => null),
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
    expect(j.judgeSpeech).not.toHaveBeenCalled();
    expect(judgments).toBe(LOCATION);
  });

  it('judges nothing for an update without a location', async () => {
    const j = judge();

    expect(await judgeFor(j, initialContext(), { kind: 'update', slots: { customerName: 'Mike' } })).toEqual({});
    expect(j.judgeLocation).not.toHaveBeenCalled();
  });

  it('judges a spoken line with the saved location as context', async () => {
    const j = judge();

    const judgments = await judgeFor(j, initialContext({ location: 'I-95' }), { kind: 'caller_speech', text: ' help me now ' });

    expect(j.judgeSpeech).toHaveBeenCalledWith('help me now', 'I-95');
    expect(judgments).toBe(RISK);
  });

  it('adds the question the caller is answering while a read-back is pending', async () => {
    const j = judge();

    await judgeFor(j, READ_BACK_PENDING, { kind: 'caller_speech', text: "Yep, that's it." });

    expect(j.judgeSpeech).toHaveBeenCalledWith("Yep, that's it.", 'I-95 near exit 42', {
      kind: 'details',
      question: 'Are these details correct?',
      readBack: expect.arrayContaining([
        { label: 'Location', value: 'I-95 near exit 42' },
        { label: 'Callback number', value: '+18174098408' },
      ]),
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

  it.each([{ kind: 'state' } as const, { kind: 'silence' } as const, { kind: 'complete', callerConfirmed: true } as const])(
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
