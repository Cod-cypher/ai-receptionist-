/**
 * Conversation states and call-event types.
 *
 * The state machine that consumes these lives in the API package
 * (`apps/api/src/conversation/state-machine.ts`). These types are shared so the
 * dashboard can render a call's state timeline without duplicating the enum.
 */

/**
 * States the receptionist can occupy during a call.
 *
 * The COLLECT_* states are named rather than a single generic "collecting"
 * state so a call's history reads clearly in the dashboard timeline. Which
 * COLLECT_* state applies is *derived* from the first unfilled required slot
 * (see `slots.ts`), never chosen by the model — that derivation is what lets a
 * single utterance fill three slots and skip three states.
 */
export const ConversationState = {
  /** Nothing said yet. The engine emits the greeting from this state. */
  GREETING: 'GREETING',
  /** Greeting delivered; waiting to learn why the customer called. */
  IDENTIFY_INTENT: 'IDENTIFY_INTENT',

  COLLECT_LOCATION: 'COLLECT_LOCATION',
  COLLECT_DESTINATION: 'COLLECT_DESTINATION',
  COLLECT_VEHICLE: 'COLLECT_VEHICLE',
  COLLECT_VEHICLE_CONDITION: 'COLLECT_VEHICLE_CONDITION',
  COLLECT_NAME: 'COLLECT_NAME',
  CONFIRM_PHONE: 'CONFIRM_PHONE',

  /** Reading the collected details back for confirmation. */
  CONFIRM_INFORMATION: 'CONFIRM_INFORMATION',
  /** Customer rejected the summary; re-collecting the disputed slot(s). */
  CORRECTING: 'CORRECTING',

  /** Answering a question from the business's configured knowledge. Transient. */
  ANSWER_FAQ: 'ANSWER_FAQ',
  /** Request is outside what the receptionist may handle; a callback is raised. */
  ESCALATE_CALLBACK: 'ESCALATE_CALLBACK',
  /** Provider failure or repeated non-understanding; degrade to a callback. */
  ERROR_FALLBACK: 'ERROR_FALLBACK',

  /** Lead / callback persisted; saying goodbye. */
  CLOSING: 'CLOSING',
  /** Terminal. */
  ENDED: 'ENDED',
} as const;

export type ConversationState =
  (typeof ConversationState)[keyof typeof ConversationState];

/** States after which no further customer turn is expected. */
export const TERMINAL_STATES: ReadonlySet<ConversationState> = new Set([
  ConversationState.ENDED,
]);

/**
 * The ordered collection states, keyed by the slot whose absence causes them.
 * Used to render a human-readable state for a pending slot.
 */
export const COLLECTION_STATE_BY_SLOT = {
  serviceType: ConversationState.IDENTIFY_INTENT,
  location: ConversationState.COLLECT_LOCATION,
  destination: ConversationState.COLLECT_DESTINATION,
  vehicle: ConversationState.COLLECT_VEHICLE,
  vehicleMovable: ConversationState.COLLECT_VEHICLE_CONDITION,
  vehicleCondition: ConversationState.COLLECT_VEHICLE_CONDITION,
  customerName: ConversationState.COLLECT_NAME,
  customerPhone: ConversationState.CONFIRM_PHONE,
  additionalNotes: ConversationState.CONFIRM_INFORMATION,
} as const;

/**
 * Every traceable thing that can happen during a call.
 *
 * Persisted to `call_events` with a monotonic sequence number and the call id as
 * correlation id. Production call debugging depends entirely on this stream, so
 * prefer adding an event over adding a log line.
 */
export const CallEventType = {
  CALL_STARTED: 'CALL_STARTED',
  AI_GREETING: 'AI_GREETING',
  CUSTOMER_SPEECH: 'CUSTOMER_SPEECH',
  CUSTOMER_SILENCE: 'CUSTOMER_SILENCE',
  SPEECH_RECOGNITION_FAILED: 'SPEECH_RECOGNITION_FAILED',
  AI_RESPONSE: 'AI_RESPONSE',
  AI_INTERRUPTED: 'AI_INTERRUPTED',
  FIELD_EXTRACTED: 'FIELD_EXTRACTED',
  FIELD_REJECTED: 'FIELD_REJECTED',
  FIELD_CORRECTED: 'FIELD_CORRECTED',
  /** A less specific restatement was ignored: "truck" after "semi truck". */
  FIELD_DOWNGRADE_IGNORED: 'FIELD_DOWNGRADE_IGNORED',
  /** The model claimed a confirmation the caller had not given. */
  CONFIRMATION_REJECTED: 'CONFIRMATION_REJECTED',
  /** The receptionist asked something other than the required action. */
  ACTION_DEVIATION: 'ACTION_DEVIATION',
  /** Token usage for the call. */
  AI_USAGE: 'AI_USAGE',
  STATE_CHANGED: 'STATE_CHANGED',
  FAQ_ANSWERED: 'FAQ_ANSWERED',
  GUARDRAIL_TRIPPED: 'GUARDRAIL_TRIPPED',
  LEAD_CREATED: 'LEAD_CREATED',
  CALLBACK_CREATED: 'CALLBACK_CREATED',
  WHATSAPP_QUEUED: 'WHATSAPP_QUEUED',
  WHATSAPP_SENT: 'WHATSAPP_SENT',
  WHATSAPP_FAILED: 'WHATSAPP_FAILED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  /** A caller line with no text in the transcript, and why: echo, a failed or late transcription, or the call ending first. */
  TRANSCRIPT_DROPPED: 'TRANSCRIPT_DROPPED',
  CALL_ENDED: 'CALL_ENDED',
} as const;

export type CallEventType = (typeof CallEventType)[keyof typeof CallEventType];

/** How a call finished, from the business's point of view. */
export const CallOutcome = {
  LEAD_CREATED: 'lead_created',
  CALLBACK_CREATED: 'callback_created',
  FAQ_ANSWERED: 'faq_answered',
  /** Customer hung up before enough information was collected. */
  ABANDONED: 'abandoned',
  ERROR: 'error',
} as const;

export type CallOutcome = (typeof CallOutcome)[keyof typeof CallOutcome];

export const CallStatus = {
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type CallStatus = (typeof CallStatus)[keyof typeof CallStatus];
