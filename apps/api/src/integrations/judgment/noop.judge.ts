/** No judge configured: every decision falls to the rules. */

import type { CallJudge, CallJudgments } from './judgment.interface';

export class NoopJudge implements CallJudge {
  async judgeLocation(): Promise<CallJudgments | null> {
    return null;
  }

  async judgeSpeech(): Promise<CallJudgments | null> {
    return null;
  }

  async judgeOverlap(): Promise<CallJudgments | null> {
    return null;
  }
}
