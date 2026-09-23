import { describe, expect, it, vi } from 'vitest';

import type { CallJudge, CallJudgments } from '../integrations/judgment/judgment.interface';
import { judgeFor } from './judge-for';
import { initialContext } from './types';

const LOCATION: CallJudgments = { location: { text: 'I-95, exit 42', status: 'complete', confidence: 0.9, probabilities: {} } };
const RISK: CallJudgments = { risk: { text: 'help me now', danger: 0.1, hazard: 'none', hazardProbability: 0, urgent: 0.95 } };

function judge(overrides: Partial<CallJudge> = {}): CallJudge {
  return {
    judgeLocation: vi.fn(async () => LOCATION),
    judgeSpeech: vi.fn(async () => RISK),
    ...overrides,
  };
}

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
