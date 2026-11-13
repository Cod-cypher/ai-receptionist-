/**
 * Jev first, the rules whenever Jev has nothing.
 *
 * Every judgment is asked of both: the primary judge (Jev) and the fallback
 * (the rules, which answer at once). Where Jev answers, its answer is used and
 * the rules only fill in what it left out. Where it fails or times out, the
 * rules' answer is used whole. So a call takes the same paths whether Jev is
 * fast, slow or not there; before this, several behaviours simply did not
 * happen on a turn where Jev was late.
 *
 * A circuit breaker keeps a slow Jev from costing every save its timeout. On
 * 13 Nov it timed out turn after turn, and each tool call waited 800 ms for
 * nothing. After `FAILURES_TO_OPEN` failures in a row it is not asked for
 * `OPEN_FOR_MS`; then one request is let through to see whether it is back,
 * and an answer closes the breaker. One breaker for the whole process: Jev is
 * one service, and an outage is the same outage on every call.
 */

import { Logger } from '@nestjs/common';

import type { CallJudge, CallJudgments, SpeechContext } from './judgment.interface';

export const FAILURES_TO_OPEN = 3;
export const OPEN_FOR_MS = 60_000;

export interface ResilientJudgeOptions {
  /** Failures in a row (no answer, or an error) that open the breaker. Default 3. */
  failuresToOpen?: number;
  /** How long the primary is not asked once the breaker opens. Default 60 s. */
  openForMs?: number;
  /** For tests. */
  now?: () => number;
  logger?: Pick<Logger, 'log' | 'warn'>;
}

type Breaker = 'closed' | 'open' | 'probing';

/** A judgment, or null when there was none or the judge threw. */
async function settled(call: () => Promise<CallJudgments | null>): Promise<CallJudgments | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

/** The primary's judgments, with whatever it left out taken from the fallback's. */
function merged(primary: CallJudgments, fallback: CallJudgments | null): CallJudgments {
  if (!fallback) return primary;
  const answered = Object.fromEntries(Object.entries(primary).filter(([, judgment]) => judgment !== undefined)) as CallJudgments;
  return { ...fallback, ...answered };
}

export class ResilientJudge implements CallJudge {
  private readonly failuresToOpen: number;
  private readonly openForMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'log' | 'warn'>;

  private breaker: Breaker = 'closed';
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly primary: CallJudge,
    private readonly fallback: CallJudge,
    options: ResilientJudgeOptions = {},
  ) {
    this.failuresToOpen = options.failuresToOpen ?? FAILURES_TO_OPEN;
    this.openForMs = options.openForMs ?? OPEN_FOR_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? new Logger('CallJudge');
  }

  /** Whether the primary is being skipped right now. */
  get skipping(): boolean {
    return this.breaker !== 'closed';
  }

  judgeLocation(text: string, knownAreas: readonly string[]): Promise<CallJudgments | null> {
    return this.judge((judge) => judge.judgeLocation(text, knownAreas));
  }

  judgeService(said: string, about: { problem?: string; location?: string }): Promise<CallJudgments | null> {
    return this.judge((judge) => judge.judgeService(said, about));
  }

  judgeSpeech(spoken: string, about: SpeechContext): Promise<CallJudgments | null> {
    return this.judge((judge) => judge.judgeSpeech(spoken, about));
  }

  judgeOverlap(spoken: string, receptionistSaid: string): Promise<CallJudgments | null> {
    return this.judge((judge) => judge.judgeOverlap(spoken, receptionistSaid));
  }

  judgeReply(callerSaid: string, reply: string): Promise<CallJudgments | null> {
    return this.judge((judge) => judge.judgeReply(callerSaid, reply));
  }

  private async judge(ask: (judge: CallJudge) => Promise<CallJudgments | null>): Promise<CallJudgments | null> {
    // Started first: the rules answer at once, and are there to fall back on or to fill in from.
    const fallback = settled(() => ask(this.fallback));
    const admitted = this.admit();
    // While the breaker is open the primary is not asked: a location is then judged at once by the rules.
    if (!admitted) return fallback;

    const primary = await settled(() => ask(this.primary));
    if (!primary) {
      this.failed(admitted === 'probe');
      return fallback;
    }
    this.succeeded();
    return merged(primary, await fallback);
  }

  /** Whether to ask the primary: always while closed; once the open time has passed, one probe at a time. */
  private admit(): 'ask' | 'probe' | null {
    if (this.breaker === 'closed') return 'ask';
    if (this.breaker === 'probing' || this.now() - this.openedAt < this.openForMs) return null;
    this.breaker = 'probing';
    return 'probe';
  }

  private failed(probe: boolean): void {
    if (probe && this.breaker === 'probing') {
      // Still down. Opened again without a word: the log already says it is down.
      this.breaker = 'open';
      this.openedAt = this.now();
      return;
    }
    // A request sent before the breaker opened, answering late: the breaker already knows.
    if (this.breaker !== 'closed') return;
    this.failures += 1;
    if (this.failures < this.failuresToOpen) return;
    this.breaker = 'open';
    this.openedAt = this.now();
    this.logger.warn(
      `The judge failed ${this.failures} times in a row: the rules judge alone, and it is tried again every ${Math.round(this.openForMs / 1000)} s.`,
    );
  }

  private succeeded(): void {
    this.failures = 0;
    if (this.breaker === 'closed') return;
    this.breaker = 'closed';
    this.logger.log('The judge is answering again: it judges first, the rules fill in.');
  }
}
