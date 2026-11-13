import { type Mock, describe, expect, it, vi } from 'vitest';

import type { CallJudge, CallJudgments } from './judgment.interface';
import { FAILURES_TO_OPEN, OPEN_FOR_MS, ResilientJudge } from './resilient.judge';

const MOVE = { text: 'Are you there?', callerTurn: -1, move: 'line_check' as const, confidence: 0.92 };
const RULES_MOVE = { ...MOVE, confidence: 0.8 };
const CONFIRMATION = { text: 'Are you there?', callerTurn: -1, confirms: 0.05, corrects: 0.05 };
const RISK = { text: 'Are you there?', danger: 0.02, hazard: 'none' as const, hazardProbability: 0, urgent: 0.1 };

type Mocked = { [K in keyof CallJudge]: Mock<CallJudge[K]> };

/** A judge whose every method answers `judgments`. */
function judgeAnswering(judgments: CallJudgments | null): Mocked {
  return {
    judgeLocation: vi.fn<CallJudge['judgeLocation']>(async () => judgments),
    judgeService: vi.fn<CallJudge['judgeService']>(async () => judgments),
    judgeSpeech: vi.fn<CallJudge['judgeSpeech']>(async () => judgments),
    judgeOverlap: vi.fn<CallJudge['judgeOverlap']>(async () => judgments),
    judgeReply: vi.fn<CallJudge['judgeReply']>(async () => judgments),
  };
}

function setUp(primary: Mocked, fallback: Mocked = judgeAnswering({ move: RULES_MOVE })) {
  let now = 1_000_000;
  const logger = { log: vi.fn(), warn: vi.fn() };
  const judge = new ResilientJudge(primary, fallback, { now: () => now, logger });
  return {
    judge,
    logger,
    fallback,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const ask = (judge: CallJudge) => judge.judgeSpeech('Are you there?', {});

describe('ResilientJudge', () => {
  it("uses the primary's answer, with what it left out taken from the fallback's", async () => {
    const primary = judgeAnswering({ move: MOVE, risk: RISK, confirmation: undefined });
    const { judge, fallback } = setUp(primary, judgeAnswering({ move: RULES_MOVE, confirmation: CONFIRMATION }));

    expect(await ask(judge)).toEqual({ move: MOVE, risk: RISK, confirmation: CONFIRMATION });
    expect(primary.judgeSpeech).toHaveBeenCalledWith('Are you there?', {});
    expect(fallback.judgeSpeech).toHaveBeenCalledWith('Are you there?', {});
  });

  it('uses the fallback when the primary has no answer', async () => {
    const { judge } = setUp(judgeAnswering(null));
    expect(await ask(judge)).toEqual({ move: RULES_MOVE });
  });

  it('uses the fallback when the primary throws', async () => {
    const primary = judgeAnswering(null);
    primary.judgeReply.mockRejectedValueOnce(new Error('socket hang up'));
    const { judge } = setUp(primary);
    expect(await judge.judgeReply('Are you there?', 'Where are you?')).toEqual({ move: RULES_MOVE });
  });

  it('asks every method of both judges, with the same arguments', async () => {
    const primary = judgeAnswering({ move: MOVE });
    const { judge, fallback } = setUp(primary);
    await judge.judgeLocation('I-95', ['Dallas']);
    await judge.judgeService("won't start", { location: 'I-95' });
    await judge.judgeOverlap('Okay.', 'Where are you?');
    await judge.judgeReply('Are you there?', 'Yes.');
    for (const one of [primary, fallback]) {
      expect(one.judgeLocation).toHaveBeenCalledWith('I-95', ['Dallas']);
      expect(one.judgeService).toHaveBeenCalledWith("won't start", { location: 'I-95' });
      expect(one.judgeOverlap).toHaveBeenCalledWith('Okay.', 'Where are you?');
      expect(one.judgeReply).toHaveBeenCalledWith('Are you there?', 'Yes.');
    }
  });

  it('survives a fallback that throws', async () => {
    const fallback = judgeAnswering(null);
    fallback.judgeSpeech.mockRejectedValueOnce(new Error('bug'));
    const { judge } = setUp(judgeAnswering({ move: MOVE }), fallback);
    expect(await ask(judge)).toEqual({ move: MOVE });
  });

  describe('circuit breaker', () => {
    it(`stops asking the primary after ${FAILURES_TO_OPEN} failures in a row, and says so once`, async () => {
      const primary = judgeAnswering(null);
      const { judge, logger } = setUp(primary);

      for (let i = 0; i < FAILURES_TO_OPEN; i++) await ask(judge);
      expect(primary.judgeSpeech).toHaveBeenCalledTimes(FAILURES_TO_OPEN);
      expect(judge.skipping).toBe(true);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      expect(await ask(judge)).toEqual({ move: RULES_MOVE });
      await judge.judgeOverlap('Okay.', 'Where are you?');
      expect(primary.judgeSpeech).toHaveBeenCalledTimes(FAILURES_TO_OPEN);
      expect(primary.judgeOverlap).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('answers a location at once while open, instead of waiting out a slow primary', async () => {
      const primary = judgeAnswering(null);
      const { judge } = setUp(primary, judgeAnswering(null));
      for (let i = 0; i < FAILURES_TO_OPEN; i++) await judge.judgeLocation('I-95', []);

      expect(await judge.judgeLocation('I-95, exit 42', [])).toBeNull();
      expect(primary.judgeLocation).toHaveBeenCalledTimes(FAILURES_TO_OPEN);
    });

    it('counts only failures in a row: an answer in between starts the count again', async () => {
      const primary = judgeAnswering(null);
      const { judge } = setUp(primary);
      await ask(judge);
      await ask(judge);
      primary.judgeSpeech.mockResolvedValueOnce({ move: MOVE });
      await ask(judge);
      await ask(judge);
      await ask(judge);
      expect(judge.skipping).toBe(false);
      await ask(judge);
      expect(judge.skipping).toBe(true);
    });

    it(`tries the primary once after ${OPEN_FOR_MS / 1000} s, and stays open while it still fails`, async () => {
      const primary = judgeAnswering(null);
      const { judge, logger, advance } = setUp(primary);
      for (let i = 0; i < FAILURES_TO_OPEN; i++) await ask(judge);

      advance(OPEN_FOR_MS - 1);
      await ask(judge);
      expect(primary.judgeSpeech).toHaveBeenCalledTimes(FAILURES_TO_OPEN);

      advance(1);
      await ask(judge);
      expect(primary.judgeSpeech).toHaveBeenCalledTimes(FAILURES_TO_OPEN + 1);
      expect(judge.skipping).toBe(true);

      // Open for another full spell from the failed probe.
      await ask(judge);
      advance(OPEN_FOR_MS - 1);
      await ask(judge);
      expect(primary.judgeSpeech).toHaveBeenCalledTimes(FAILURES_TO_OPEN + 1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('lets one probe through at a time', async () => {
      const primary = judgeAnswering(null);
      const { judge, advance } = setUp(primary);
      for (let i = 0; i < FAILURES_TO_OPEN; i++) await ask(judge);
      advance(OPEN_FOR_MS);

      let answer: (judgments: CallJudgments | null) => void = () => {};
      primary.judgeSpeech.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      const probe = ask(judge);
      // Asked while the probe is out: the rules answer, at once.
      expect(await ask(judge)).toEqual({ move: RULES_MOVE });
      expect(primary.judgeSpeech).toHaveBeenCalledTimes(FAILURES_TO_OPEN + 1);

      answer({ move: MOVE });
      expect(await probe).toEqual({ move: MOVE });
    });

    it('closes when the probe is answered, and says so once', async () => {
      const primary = judgeAnswering(null);
      const { judge, logger, advance } = setUp(primary);
      for (let i = 0; i < FAILURES_TO_OPEN; i++) await ask(judge);
      advance(OPEN_FOR_MS);

      primary.judgeSpeech.mockResolvedValue({ move: MOVE });
      expect(await ask(judge)).toEqual({ move: MOVE });
      expect(judge.skipping).toBe(false);
      expect(logger.log).toHaveBeenCalledTimes(1);

      expect(await ask(judge)).toEqual({ move: MOVE });
      expect(primary.judgeSpeech).toHaveBeenCalledTimes(FAILURES_TO_OPEN + 2);
      expect(logger.log).toHaveBeenCalledTimes(1);
    });

    it('takes a late answer to a request sent before it opened as the primary being back', async () => {
      const primary = judgeAnswering(null);
      const { judge } = setUp(primary);
      let answer: (judgments: CallJudgments | null) => void = () => {};
      primary.judgeSpeech.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      const slow = ask(judge);
      for (let i = 0; i < FAILURES_TO_OPEN; i++) await ask(judge);
      expect(judge.skipping).toBe(true);

      answer({ move: MOVE });
      await slow;
      expect(judge.skipping).toBe(false);
    });
  });
});
