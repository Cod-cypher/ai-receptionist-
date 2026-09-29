/**
 * The conversation engine's internal contract.
 *
 * Nothing in this file imports NestJS, a database, or a provider SDK. The
 * reducer in `state-machine.ts` is a pure function over these types, which is
 * what makes the whole workflow testable without a phone, a model, or a socket.
 */

import type {
  BusinessFacts,
  CallEventType,
  CallOutcome,
  ConversationState,
  ExtractionResult,
  Requirement,
  RequirementId,
  SlotKey,
  SlotValues,
} from '@towai/shared';

/* -------------------------------------------------------------------------- */
/*  Context                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything the engine remembers about a call in progress.
 *
 * Serialised to Redis between turns, so it must stay JSON-safe: no Dates, no
 * class instances, no functions.
 */
export interface ConversationContext {
  state: ConversationState;
  values: SlotValues;

  /** Consecutive turns the customer said nothing intelligible. */
  unclearStreak: number;
  /** Consecutive no-input timeouts. */
  silenceStreak: number;
  /** How many times each requirement has been asked. Guards against loops. */
  askAttempts: Partial<Record<RequirementId, number>>;

  /** Total customer turns handled. Bounds runaway calls. */
  turnCount: number;
  /** FAQs answered so far; a caller who only wants FAQs never becomes a lead. */
  faqCount: number;

  /**
   * Set when the customer rejects the read-back summary. The next informative
   * utterance is treated as a correction rather than as new information.
   */
  awaitingCorrection: boolean;

  /**
   * The caller ID seeds `values.customerPhone`, so the phone requirement would
   * otherwise be satisfied the instant the call connects and never be confirmed.
   * Confirmation is tracked here rather than in the slot values.
   */
  phoneConfirmed: boolean;
  /** Set when the caller says the number they are calling from is not the best one. */
  phoneNeedsCollection: boolean;

  /** Populated when the call is heading for a callback rather than a lead. */
  escalationReason: string | null;

  /**
   * A callback request has already been created for this call. Without this, a
   * caller who asks something unanswerable and later hangs up produced two
   * identical callbacks — and two WhatsApp messages to the operator.
   */
  callbackRaised: boolean;

  /** True once a lead or callback has been emitted; makes FINALIZE idempotent. */
  finalised: boolean;

  /**
   * Bumped whenever a slot value changes. Optional so contexts saved before it
   * existed still load.
   */
  fieldVersion?: number;
  /**
   * The `fieldVersion` the caller last had read back to them (realtime pipeline).
   * A confirmation only counts when nothing has changed since.
   */
  summaryVersion?: number;
  /** A lead was created for this call (realtime pipeline). */
  leadCreated?: boolean;

  // Realtime pipeline only. All optional so contexts saved before they
  // existed still load.

  /** Where each saved value came from. Absent means stated by the caller. */
  fieldSources?: Partial<Record<SlotKey, FieldSource>>;
  /** Times the caller was asked to narrow down a partial location. */
  locationDetailAttempts?: number;
  /** The caller turn at which that was last asked, so one turn counts once. */
  locationDetailLastTurn?: number;
  urgency?: { level: 'high' | 'normal'; reasons: string[] };
  /** A hazard was detected; `issuedAtTurn` is when the caller was told what to do. */
  safety?: { hazard: string; issuedAtTurn: number | null };
  /**
   * A question whose answer must come from the caller, not the model. A
   * confirmation only counts once the caller has spoken after it was asked.
   */
  pendingConfirmation?: PendingConfirmation | null;
  /**
   * What the judge (TypeSafe Jev) made of the location and the caller's last
   * words. Each is tagged with the text it judged, so a stale one is ignored.
   */
  judgments?: import('../integrations/judgment/judgment.interface').CallJudgments;
  /**
   * How many caller turns each thing has been asked on, and the last of them.
   * What stops the receptionist asking the same thing for ever: on a real
   * call it asked the caller to confirm a location four times running, after
   * they had said "yep" and "yes".
   */
  asked?: Record<string, { count: number; turn: number }>;
  /** What the caller asked that they were told the towing team would come back to them on. */
  callerAsked?: Array<import('./ready-answers').AskedAbout>;
  /** The caller said yes to the read-back (realtime pipeline). Absent on a lead made when the call ended first. */
  detailsConfirmed?: boolean;
}

export type FieldSource = 'stated' | 'inferred' | 'caller_id' | 'unsure';

export interface PendingConfirmation {
  kind: 'callback_number' | 'details';
  /** The details it covers; any change since makes it stale. */
  fieldVersion: number;
  /** The caller turn it was asked at. */
  callerTurn: number;
  /**
   * The caller spoke before the read-back had finished; this is as much of
   * it as they heard. The rest is read once more, after what they said has
   * been answered.
   */
  cutAfter?: string;
  /** The caller turn on which the model was told to finish a cut read-back. It is told on that turn only. */
  resumeTurn?: number;
}

export function initialContext(seed?: Partial<SlotValues>): ConversationContext {
  return {
    state: 'GREETING',
    values: { ...seed },
    unclearStreak: 0,
    silenceStreak: 0,
    askAttempts: {},
    turnCount: 0,
    faqCount: 0,
    awaitingCorrection: false,
    phoneConfirmed: false,
    phoneNeedsCollection: false,
    escalationReason: null,
    callbackRaised: false,
    finalised: false,
  };
}

/* -------------------------------------------------------------------------- */
/*  Turn input                                                                */
/* -------------------------------------------------------------------------- */

export type TurnInput =
  /** The call has just connected; produce the greeting. */
  | { kind: 'START' }
  /** The customer said something and it has been extracted and validated. */
  | {
      kind: 'UTTERANCE';
      transcript: string;
      extraction: ExtractionResult;
      accepted: SlotValues;
      rejected: Array<{ key: SlotKey; reason: string }>;
    }
  /** No speech within the no-input window. */
  | { kind: 'SILENCE' }
  /** The customer hung up. */
  | { kind: 'HANGUP' }
  /** A provider failed in a way the turn cannot recover from. */
  | { kind: 'PROVIDER_ERROR'; message: string }
  /** The call has run past its configured maximum length. */
  | { kind: 'MAX_DURATION' };

/* -------------------------------------------------------------------------- */
/*  Directive — what to say                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The instruction handed to the language model for phrasing. The model chooses
 * words; it never chooses which directive it receives.
 */
/**
 * What the receptionist does after handling an interjection (an FAQ, an
 * apology). Carrying it on the directive means one spoken turn can answer a
 * question *and* return to intake, instead of stalling for a turn.
 */
export type Continuation =
  | { kind: 'ask'; requirement: Requirement }
  | { kind: 'summary'; summary: SummaryLine[] }
  | { kind: 'none' };

export type Directive =
  | { kind: 'GREET' }
  | { kind: 'ASK'; requirement: Requirement; attempt: number }
  /** The customer's answer did not fill the slot; ask again more concretely. */
  | { kind: 'REASK'; requirement: Requirement; attempt: number }
  /** They said the calling number is not the best one; take a different one. */
  | { kind: 'ASK_ALTERNATE_PHONE' }
  /** Speech arrived but meant nothing. */
  | { kind: 'DID_NOT_UNDERSTAND'; requirement: Requirement | null }
  /** Silence. */
  | { kind: 'PROMPT_AFTER_SILENCE'; requirement: Requirement | null }
  /** Answer drawn from configured business data, then continue intake. */
  | {
      kind: 'ANSWER_FAQ';
      question: string;
      /** The exact fact from configuration. The model may rephrase, not extend. */
      fact: string;
      then: Continuation;
    }
  /** Nothing configured covers the question; a callback is being raised. */
  | { kind: 'CANNOT_ANSWER'; question: string; then: Continuation }
  | { kind: 'CONFIRM_SUMMARY'; summary: SummaryLine[] }
  | { kind: 'ACKNOWLEDGE_CORRECTION'; requirement: Requirement | null }
  /** Out of scope, or repeated failure: promise a callback. */
  | { kind: 'ESCALATE'; reason: string }
  | { kind: 'CLOSE'; outcome: CallOutcome }
  /** Terminal, nothing more is said (customer already gone). */
  | { kind: 'SILENT_END' };

export interface SummaryLine {
  label: string;
  value: string;
}

/* -------------------------------------------------------------------------- */
/*  Effects — what to do                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Side effects the engine requests. The reducer only describes them; the
 * orchestrator performs them, which keeps the reducer pure and lets tests assert
 * on intent rather than on database rows.
 */
export type Effect =
  | { type: 'CREATE_LEAD' }
  | { type: 'CREATE_CALLBACK'; reason: string }
  | { type: 'END_CALL'; outcome: CallOutcome }
  | { type: 'LOG_EVENT'; event: CallEventType; payload?: Record<string, unknown> };

export interface TurnDecision {
  context: ConversationContext;
  directive: Directive;
  effects: Effect[];
}

/* -------------------------------------------------------------------------- */
/*  Engine configuration                                                      */
/* -------------------------------------------------------------------------- */

export interface FlowConfig {
  facts: BusinessFacts;
  /** The tenant's configured opening line, or null to use the default. */
  greeting: string | null;
  /** Fallback when the receptionist cannot help. */
  fallbackBehavior: 'callback' | 'emergency_contact';
  /** Re-asks for one requirement before giving up on it. */
  maxAskAttempts: number;
  /** Consecutive unintelligible turns before escalating. */
  maxUnclearStreak: number;
  /** Consecutive silences before ending the call. */
  maxSilenceStreak: number;
  /** Hard ceiling on customer turns. */
  maxTurns: number;
}

export const DEFAULT_FLOW_LIMITS = {
  maxAskAttempts: 3,
  maxUnclearStreak: 3,
  maxSilenceStreak: 2,
  maxTurns: 40,
} as const;
