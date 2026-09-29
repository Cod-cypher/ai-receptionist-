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

/** A question the receptionist has put to the caller and is waiting on. */
export interface PendingQuestion {
  kind: 'details' | 'callback_number';
  /** The question as the caller heard it, in plain words. */
  question: string;
  /** For a read-back: the details the caller is confirming. */
  readBack?: Array<{ label: string; value: string }>;
}

export interface ConfirmationJudgment {
  /** The caller's line this judgment is about. */
  text: string;
  /** The caller turn it was spoken on, so a judgment about an earlier line is never taken for the latest. */
  callerTurn: number;
  /** Probability the caller said the details (or the number) are right. */
  confirms: number;
  /** Probability the caller corrected something or asked for something different. */
  corrects: number;
}

export interface OverlapJudgment {
  text: string;
  /** Probability the caller's words answered or added to what the receptionist said, rather than only acknowledging it. */
  answers: number;
}

/** What the caller is doing with a line, as far as the reply to it is concerned. */
export type CallerMove = 'request' | 'line_check' | 'complaint' | 'question' | 'other';

export interface MoveJudgment {
  text: string;
  /** The caller turn it was spoken on; stamped by the caller of the judge. */
  callerTurn: number;
  move: CallerMove;
  confidence: number;
}

export type ServiceChoice = 'tow' | 'jump_start' | 'lockout' | 'flat_tire' | 'fuel_delivery' | 'winch_out' | 'unclear';

export interface ServiceJudgment {
  /** The words judged: what was saved as the service, or the line the caller spoke. */
  text: string;
  service: ServiceChoice;
  confidence: number;
  /**
   * The two most likely kinds of help, most likely first, when more than one
   * is plausible: "won't start" on a highway is a tow or a jump start. What
   * the receptionist offers the caller when the judge cannot tell.
   */
  alternatives: Array<Exclude<ServiceChoice, 'unclear'>>;
}

export interface CallJudgments {
  location?: LocationJudgment;
  risk?: RiskJudgment;
  confirmation?: ConfirmationJudgment;
  overlap?: OverlapJudgment;
  move?: MoveJudgment;
  service?: ServiceJudgment;
}

/** What is known when a caller line is judged. */
export interface SpeechContext {
  location?: string;
  /** The question the caller is being asked to confirm, if any. */
  pending?: PendingQuestion;
  /** The kind of help needed is not saved yet: judge it from this line. */
  serviceMissing?: boolean;
  /** What is wrong with the vehicle, as saved so far. */
  problem?: string;
}

export interface CallJudge {
  /** A location the caller gave: how precise it is, and whether it describes danger. */
  judgeLocation(text: string, knownAreas: readonly string[]): Promise<CallJudgments | null>;
  /** What was saved as the help the caller needs: which kind of help is it? */
  judgeService(said: string, about: { problem?: string; location?: string }): Promise<CallJudgments | null>;
  /**
   * A line the caller spoke: danger and urgency, what the caller is doing
   * with it, and, where it applies, whether it answers a pending question
   * and what help it asks for. Turn numbers are stamped by the caller.
   */
  judgeSpeech(spoken: string, about: SpeechContext): Promise<CallJudgments | null>;
  /** Words the caller said over the receptionist: an answer, or only an acknowledgement? */
  judgeOverlap(spoken: string, receptionistSaid: string): Promise<CallJudgments | null>;
}
