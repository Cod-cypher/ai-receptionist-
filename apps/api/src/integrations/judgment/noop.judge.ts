/**
 * A judge that never judges: every decision falls to the intake's own rules.
 * For tests and the eval harness, which want the engine without any judge;
 * a running call without Jev uses `RulesJudge`.
 */

import type { CallJudge, CallJudgments } from './judgment.interface';

export class NoopJudge implements CallJudge {
  async judgeLocation(): Promise<CallJudgments | null> {
    return null;
  }

  async judgeService(): Promise<CallJudgments | null> {
    return null;
  }

  async judgeSpeech(): Promise<CallJudgments | null> {
    return null;
  }

  async judgeOverlap(): Promise<CallJudgments | null> {
    return null;
  }

  async judgeReply(): Promise<CallJudgments | null> {
    return null;
  }
}
