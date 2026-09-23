/**
 * A judge: something that reads what the caller said and returns typed
 * judgments the engine can act on, or `null` when it has none.
 *
 * Narrow on purpose. The judge is asked about one location or one spoken
 * line; it never sees the intake as a whole and has no way to choose what
 * happens next. `determineNextAction` keeps that job. Every judgment carries
 * the exact text it was made about, so a judgment made about an earlier
 * value is never applied to a newer one.
 */

import type { LocationStatus } from '../../conversation/location';

export const CALL_JUDGE = Symbol('CALL_JUDGE');

export type HazardChoice = 'none' | 'accident' | 'injury' | 'fire_or_fuel' | 'live_traffic' | 'other_danger';

export interface LocationJudgment {
  /** The location text this judgment is about. */
  text: string;
  /** `complete` lets the intake move on; anything less asks where exactly. */
  status: Exclude<LocationStatus, 'missing'>;
  /** 0-1: how concentrated the model's read was. */
  confidence: number;
  /** Probability of each precision level, keyed "0" | "1" | "2". */
  probabilities: Record<string, number>;
}

export interface RiskJudgment {
  /** The spoken line, or the location text, this judgment is about. */
  text: string;
  /**
   * Probability that the people there are in some danger: one minus the
   * probability of `none`. The gate, since a crash with an injury spreads
   * probability across two true answers and lowers either one's confidence.
   */
  danger: number;
  /** The most likely danger other than `none`; `none` when nothing else has any probability. */
  hazard: HazardChoice;
  /** Probability of `hazard` itself. */
  hazardProbability: number;
  /** Probability the caller is asking for help urgently; `null` when not asked. */
  urgent: number | null;
}

export interface CallJudgments {
  location?: LocationJudgment;
  risk?: RiskJudgment;
}

export interface CallJudge {
  /** A location the caller gave: how precise it is, and whether it describes danger. */
  judgeLocation(text: string, knownAreas: readonly string[]): Promise<CallJudgments | null>;
  /** A line the caller spoke: danger and urgency. */
  judgeSpeech(spoken: string, location: string | undefined): Promise<CallJudgments | null>;
}
