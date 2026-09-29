/**
 * The intake as facts and permitted actions, for a receptionist that runs its
 * own conversation.
 *
 * `reduce()` answers "what should be said next" for the templated pipelines.
 * The realtime model phrases its own replies, so it gets something different:
 * what is known, what is missing, and — from the priority engine — the one
 * thing it must do next. Every operation is pure, uses the same slot
 * validation and the same `finish()` as the state machine, and returns effects
 * for `CallSessionService` to execute, so a lead or callback is created exactly
 * as on every other pipeline.
 *
 * Confirmations are the backend's call, not the model's: a "yes" only counts
 * when the caller has spoken since the question was put to them. On a real
 * call the model read the details back and confirmed them itself in the same
 * breath; the caller turn counter comes from the audio, which the model cannot
 * fake.
 */

import {
  CallEventType,
  ConversationState,
  REQUIREMENTS,
  outstandingRequirements,
  validateSlots,
  type FaqTopic,
  type RequirementId,
  type SlotKey,
  type SlotValues,
} from '@towai/shared';

import type { CallJudgments, ConfirmationJudgment } from '../integrations/judgment/judgment.interface';
import { CONFIRMATION_FLOOR, CORRECTION_FLOOR } from '../integrations/judgment/typesafe-questions';
import { resolveFaq } from './faq-resolver';
import { refineLocation, type LocationStatus } from './location';
import { determineNextAction, locationSettled, type NextAction, type NextActionOptions, type NextActionPlan, type Topic } from './next-action';
import { assessRisk } from './risk';
import { mergeSlots } from './slot-merge';
import { finish } from './state-machine';
import type { ConversationContext, Effect, FieldSource, FlowConfig, SummaryLine } from './types';

export type IntakeStatus = 'collecting' | 'awaiting_confirmation' | 'submitted' | 'ended';

export interface IntakeSnapshot {
  status: IntakeStatus;
  collected: SlotValues;
  /** Required details still missing or too vague, in the order they are needed. */
  missing: RequirementId[];
  locationStatus: LocationStatus;
  phoneConfirmed: boolean;
  urgent: boolean;
  callbackRaised: boolean;
  /** The one thing to do next, decided here rather than by the model. */
  nextAction: NextAction;
  ask: string;
  doNotAsk: Topic[];
  readBack?: SummaryLine[];
}

export type IntakeOperation =
  | {
      kind: 'update';
      slots: Partial<Record<SlotKey, unknown>>;
      /** True: the number they are calling from is right. False: they want another. */
      callerIdConfirmed?: boolean | null;
      /** Fields the model filled in rather than heard ("Ford" from "Mustang"). */
      inferred?: SlotKey[];
      /** Fields the model is not sure it heard correctly. */
      unsure?: SlotKey[];
    }
  | { kind: 'state' }
  | { kind: 'business_info'; topic: FaqTopic | null; question: string }
  | { kind: 'complete'; callerConfirmed: boolean }
  | { kind: 'callback'; reason: string }
  | { kind: 'end'; reason?: string }
  | { kind: 'silence' }
  | { kind: 'caller_speech'; text: string };

export interface IntakeOptions {
  defaultRegionPrefix?: string;
  /**
   * Caller turns so far, counted by the voice gateway from committed audio.
   * Falls back to the transcribed turns when absent (tests, non-voice callers).
   */
  callerTurn?: number;
  emergencyNumber?: string;
  knownAreas?: readonly string[];
  /**
   * What the judge made of this operation (see `judgeFor`), kept on the
   * context so later turns decide from it without asking again.
   */
  judgments?: CallJudgments;
}

export interface IntakeResult {
  context: ConversationContext;
  effects: Effect[];
  /** Returned to the model as the tool result. Facts only, never a script. */
  output: Record<string, unknown>;
  /** The call is over; the receptionist should say goodbye. */
  ended: boolean;
  /** What the receptionist must do now. */
  plan: NextActionPlan;
}

const log = (event: CallEventType, payload?: Record<string, unknown>): Effect =>
  payload ? { type: 'LOG_EVENT', event, payload } : { type: 'LOG_EVENT', event };

/** In requirement order; a vague location and an unconfirmed number count as missing. */
function missingRequirements(ctx: ConversationContext, plan: NextActionPlan): RequirementId[] {
  const outstanding = new Set(outstandingRequirements(ctx.values));
  return REQUIREMENTS.filter((r) => r.required)
    .sort((a, b) => a.order - b.order)
    .map((r) => r.id)
    .filter(
      (id) =>
        outstanding.has(id) ||
        (id === 'location' && !locationSettled(ctx, plan.location)) ||
        (id === 'customerPhone' && !ctx.phoneConfirmed),
    );
}

export function describeIntake(ctx: ConversationContext, plan: NextActionPlan = determineNextAction(ctx)): IntakeSnapshot {
  let status: IntakeStatus = 'collecting';
  if (ctx.state === ConversationState.ENDED) status = ctx.leadCreated ? 'submitted' : 'ended';
  else if (plan.action === 'AWAIT_CONFIRMATION') status = 'awaiting_confirmation';

  return {
    status,
    collected: { ...ctx.values },
    missing: missingRequirements(ctx, plan),
    locationStatus: plan.location.status,
    phoneConfirmed: ctx.phoneConfirmed,
    urgent: ctx.urgency?.level === 'high',
    callbackRaised: ctx.callbackRaised,
    nextAction: plan.action,
    ask: plan.ask,
    doNotAsk: plan.doNotAsk,
    ...(plan.summary ? { readBack: plan.summary } : {}),
  };
}

/**
 * Records that the model has been told to do `plan`: the question it is about
 * to ask, so the answer can be checked against it later.
 */
function issue(ctx: ConversationContext, plan: NextActionPlan, turn: number): ConversationContext {
  switch (plan.action) {
    case 'HANDLE_SAFETY':
      return ctx.safety && ctx.safety.issuedAtTurn === null ? { ...ctx, safety: { ...ctx.safety, issuedAtTurn: turn } } : ctx;
    case 'ASK_LOCATION_DETAIL':
      return ctx.locationDetailLastTurn === turn
        ? ctx
        : { ...ctx, locationDetailAttempts: (ctx.locationDetailAttempts ?? 0) + 1, locationDetailLastTurn: turn };
    case 'CONFIRM_CALLBACK_NUMBER':
      return ctx.pendingConfirmation?.kind === 'callback_number'
        ? ctx
        : withoutConfirmationJudgment({
            ...ctx,
            pendingConfirmation: { kind: 'callback_number', fieldVersion: ctx.fieldVersion ?? 0, callerTurn: turn },
          });
    case 'CONFIRM_DETAILS':
      return withoutConfirmationJudgment({
        ...ctx,
        state: ConversationState.CONFIRM_INFORMATION,
        pendingConfirmation: { kind: 'details', fieldVersion: ctx.fieldVersion ?? 0, callerTurn: turn },
      });
    default:
      return ctx;
  }
}

/** A new question is being put to the caller: what they said to the last one no longer answers it. */
function withoutConfirmationJudgment(ctx: ConversationContext): ConversationContext {
  if (!ctx.judgments?.confirmation) return ctx;
  const { confirmation: _dropped, ...rest } = ctx.judgments;
  return { ...ctx, judgments: rest };
}

/**
 * What the judge made of the caller's latest line, if it was about the
 * question now pending. `turn` is the caller's current turn: a judgment about
 * an earlier line is not taken for the answer, and a line whose transcript
 * has not arrived yet leaves the decision to the turn count, as before.
 */
function latestConfirmation(ctx: ConversationContext, turn: number): ConfirmationJudgment | null {
  const judged = ctx.judgments?.confirmation;
  return judged && judged.callerTurn === turn ? judged : null;
}

const isConfirmation = (judged: ConfirmationJudgment) => judged.confirms >= CONFIRMATION_FLOOR && judged.corrects < CORRECTION_FLOOR;

function notConfirmed(judged: ConfirmationJudgment, what: string): string {
  return judged.corrects >= CORRECTION_FLOOR
    ? `The caller's last words were "${judged.text}": they are correcting something or asking for something else. Deal with that first, then confirm again.`
    : `The caller's last words were "${judged.text}", which does not confirm ${what}. Wait for a clear yes.`;
}

interface Step {
  context: ConversationContext;
  effects: Effect[];
  output: Record<string, unknown>;
  ended: boolean;
}

function ended(ctx: ConversationContext, effects: Effect[], extra: Record<string, unknown>): Step {
  return { context: ctx, effects, output: { ...extra, callEnded: true }, ended: true };
}

/** Finishes the call through the state machine's own terminal transition. */
function finishCall(ctx: ConversationContext, reason?: string): Step {
  const decision = finish(ctx, { spoken: true, reason });
  const leadCreated = decision.effects.some((e) => e.type === 'CREATE_LEAD');
  const context = { ...decision.context, leadCreated: ctx.leadCreated || leadCreated, pendingConfirmation: null };
  const outcome = decision.effects.find((e) => e.type === 'END_CALL');
  return ended(context, decision.effects, {
    outcome: outcome?.type === 'END_CALL' ? outcome.outcome : null,
    leadCreated: context.leadCreated,
    callbackCreated: decision.effects.some((e) => e.type === 'CREATE_CALLBACK'),
  });
}

export function applyIntake(
  ctx: ConversationContext,
  op: IntakeOperation,
  config: FlowConfig,
  options: IntakeOptions = {},
): IntakeResult {
  const turn = options.callerTurn ?? ctx.turnCount;
  const planOptions: NextActionOptions = {
    emergencyNumber: options.emergencyNumber,
    knownAreas: options.knownAreas ?? config.facts.serviceAreas,
  };

  const step =
    ctx.state === ConversationState.ENDED && op.kind !== 'state'
      ? ended(ctx, [], { note: 'This call has already been completed.' })
      : run(ctx, op, config, options, turn, planOptions);

  const plan = determineNextAction(step.context, planOptions);
  // Only a plan the model actually receives counts as asked: tool results and
  // the per-turn state note. Transcripts and silence ticks are not sent to it.
  const delivered = op.kind !== 'caller_speech' && op.kind !== 'silence';

  return {
    context: delivered ? issue(step.context, plan, turn) : step.context,
    effects: step.effects,
    output: { ...step.output, state: describeIntake(step.context, plan) },
    ended: step.ended,
    plan,
  };
}

/**
 * The location text an update would save, after the same validation and
 * refinement `update()` applies. What the judge is asked about, so that its
 * judgment is about exactly the value that ends up in the context.
 */
export function previewLocation(
  ctx: ConversationContext,
  op: Extract<IntakeOperation, { kind: 'update' }>,
  defaultRegionPrefix?: string,
): string | undefined {
  const { accepted } = validateSlots(op.slots, { defaultRegionPrefix });
  return accepted.location ? refineLocation(ctx.values.location, accepted.location) : undefined;
}

/** A note that describes the caller, rather than passing on something they said. */
const COMMENTARY = /^(?:the\s+)?(?:caller|customer|client|user|they|he|she)\b/i;

/**
 * Values that are well-formed but do not belong where the model put them.
 * They are taken out of `accepted` and returned with the reason, which goes
 * back to the model in the tool result.
 */
function refuse(accepted: SlotValues): Array<{ field: string; reason: string }> {
  const refused: Array<{ field: string; reason: string }> = [];

  // Seen on a real call: the notes were rewritten every turn with commentary
  // ("Caller feels they are being cut off"), and ended as "Caller confirmed
  // they are safe", which the lead's safety note already says.
  if (accepted.additionalNotes && COMMENTARY.test(accepted.additionalNotes)) {
    delete accepted.additionalNotes;
    refused.push({
      field: 'additionalNotes',
      reason:
        'Notes are only for a message the caller asked you to pass on to the driver. This is your own observation: it was not saved. Do not save observations.',
    });
  }
  return refused;
}

/** Keeps a judgment on the context. A judgment about other text is harmless: nothing reads it. */
function withJudgments(ctx: ConversationContext, judgments: CallJudgments | undefined): ConversationContext {
  if (!judgments || (!judgments.location && !judgments.risk && !judgments.confirmation)) return ctx;
  return { ...ctx, judgments: { ...ctx.judgments, ...judgments } };
}

function run(
  ctx: ConversationContext,
  op: IntakeOperation,
  config: FlowConfig,
  options: IntakeOptions,
  turn: number,
  planOptions: NextActionOptions,
): Step {
  switch (op.kind) {
    case 'state':
      return { context: ctx, effects: [], output: {}, ended: false };
    case 'update':
      return update(ctx, op, turn, options);
    case 'business_info':
      return businessInfo(ctx, op.topic, op.question, config);
    case 'complete':
      return complete(ctx, op.callerConfirmed, turn, planOptions);
    case 'callback':
      return callback(ctx, op.reason);
    case 'end':
      return finishCall(ctx, op.reason);
    case 'silence':
      return silence(ctx, config);
    case 'caller_speech':
      return callerSpeech(ctx, op.text, config, turn, options.judgments);
  }
}

function update(
  ctx: ConversationContext,
  op: Extract<IntakeOperation, { kind: 'update' }>,
  turn: number,
  options: IntakeOptions,
): Step {
  const { accepted, rejected } = validateSlots(op.slots, { defaultRegionPrefix: options.defaultRegionPrefix });
  if (accepted.location) accepted.location = previewLocation(ctx, op, options.defaultRegionPrefix);
  const refused = refuse(accepted);

  const merged = mergeSlots(ctx, accepted, rejected, { preferSpecific: true });
  const effects = [...merged.effects];
  const rejectedOut: Array<{ field: string; reason: string }> = [
    ...rejected.map((r) => ({ field: r.key as string, reason: r.reason })),
    ...refused,
  ];
  let next = withJudgments(merged.context, options.judgments);

  // Where each value came from. Re-sending a value the model was unsure of,
  // without flagging it again, means the caller has now confirmed it.
  const sources: Partial<Record<SlotKey, FieldSource>> = { ...(next.fieldSources ?? {}) };
  for (const key of Object.keys(accepted) as SlotKey[]) {
    if (merged.ignored.includes(key)) continue;
    if (op.unsure?.includes(key)) sources[key] = 'unsure';
    else if (op.inferred?.includes(key)) sources[key] = 'inferred';
    else if (merged.changed.includes(key) || sources[key] === 'unsure') sources[key] = 'stated';
  }
  next = { ...next, fieldSources: sources };

  if (merged.changed.includes('customerPhone') && next.pendingConfirmation?.kind === 'callback_number') {
    next = { ...next, pendingConfirmation: null };
  }

  if (op.callerIdConfirmed === true && !next.phoneConfirmed) {
    const pending = next.pendingConfirmation;
    const judged = pending?.kind === 'callback_number' ? latestConfirmation(next, turn) : null;
    if (judged && !isConfirmation(judged)) {
      const reason = notConfirmed(judged, 'the number');
      effects.push(log(CallEventType.CONFIRMATION_REJECTED, { kind: 'callback_number', reason, judged: judged.text }));
      rejectedOut.push({ field: 'callerIdConfirmed', reason });
    } else if (pending?.kind === 'callback_number' && turn > pending.callerTurn) {
      next = {
        ...next,
        phoneConfirmed: true,
        phoneNeedsCollection: false,
        pendingConfirmation: null,
        fieldSources: { ...sources, customerPhone: 'caller_id' },
      };
      effects.push(
        log(CallEventType.FIELD_EXTRACTED, {
          field: 'customerPhone',
          value: next.values.customerPhone,
          source: 'caller_id_confirmed',
        }),
      );
    } else {
      const reason =
        pending?.kind === 'callback_number'
          ? 'The caller has not answered yet. Wait for their answer before saving it.'
          : 'You have not asked the caller about this number yet. Ask when it is the next action.';
      effects.push(log(CallEventType.CONFIRMATION_REJECTED, { kind: 'callback_number', reason }));
      rejectedOut.push({ field: 'callerIdConfirmed', reason });
    }
  } else if (op.callerIdConfirmed === false && !merged.changed.includes('customerPhone')) {
    next = { ...next, phoneConfirmed: false, phoneNeedsCollection: true, pendingConfirmation: null };
  }

  next = { ...next, ...assessRisk(next) };

  return {
    context: next,
    effects,
    output: {
      saved: Object.fromEntries(merged.changed.map((key) => [key, next.values[key]])),
      ...(merged.ignored.length > 0
        ? { keptMoreSpecific: Object.fromEntries(merged.ignored.map((key) => [key, next.values[key]])) }
        : {}),
      rejected: rejectedOut,
    },
    ended: false,
  };
}

function businessInfo(ctx: ConversationContext, topic: FaqTopic | null, question: string, config: FlowConfig): Step {
  const resolution = resolveFaq(topic, question, config.facts);

  if (resolution.resolved) {
    return {
      context: { ...ctx, faqCount: ctx.faqCount + 1 },
      effects: [log(CallEventType.FAQ_ANSWERED, { question })],
      output: { answered: true, fact: resolution.fact, rule: 'Answer using only this fact. Add nothing to it.' },
      ended: false,
    };
  }

  const raised = callback(ctx, question);
  return {
    ...raised,
    output: {
      answered: false,
      reason: resolution.reason,
      rule: 'You cannot answer this. Say you cannot confirm it on this call and that the towing team will follow up about it. Do not guess.',
      callbackRaised: true,
    },
  };
}

function complete(ctx: ConversationContext, callerConfirmed: boolean, turn: number, planOptions: NextActionOptions): Step {
  const plan = determineNextAction(ctx, planOptions);
  if (plan.action !== 'CONFIRM_DETAILS' && plan.action !== 'AWAIT_CONFIRMATION') {
    return { context: ctx, effects: [], output: { success: false, reason: 'Not everything needed is saved yet.' }, ended: false };
  }

  const pending = ctx.pendingConfirmation;
  const current = pending?.kind === 'details' && pending.fieldVersion === (ctx.fieldVersion ?? 0);
  const judged = current ? latestConfirmation(ctx, turn) : null;
  if (callerConfirmed && current && turn > pending!.callerTurn && (!judged || isConfirmation(judged))) return finishCall(ctx);

  if (callerConfirmed) {
    const reason = judged
      ? notConfirmed(judged, 'the details')
      : current
        ? 'The caller has not answered the read-back yet. Wait for them to confirm.'
        : 'These details have not been read back to the caller yet. Read them back first.';
    return {
      context: ctx,
      effects: [log(CallEventType.CONFIRMATION_REJECTED, { kind: 'details', reason })],
      output: { success: false, needsConfirmation: true, reason },
      ended: false,
    };
  }
  return { context: ctx, effects: [], output: { success: false, needsConfirmation: true }, ended: false };
}

function callback(ctx: ConversationContext, reason: string): Step {
  if (ctx.callbackRaised) {
    return {
      context: ctx,
      effects: [],
      output: { callbackRaised: true, note: 'A callback is already arranged for this call.' },
      ended: false,
    };
  }

  return {
    context: { ...ctx, callbackRaised: true, escalationReason: reason },
    effects: [{ type: 'CREATE_CALLBACK', reason }, log(CallEventType.CALLBACK_CREATED, { reason })],
    output: { callbackRaised: true },
    ended: false,
  };
}

function silence(ctx: ConversationContext, config: FlowConfig): Step {
  const silenceStreak = ctx.silenceStreak + 1;
  const counted = { ...ctx, silenceStreak };

  if (silenceStreak >= config.maxSilenceStreak) {
    const result = finishCall(counted, 'Caller went silent before intake finished.');
    return { ...result, effects: [log(CallEventType.CUSTOMER_SILENCE, { streak: silenceStreak }), ...result.effects] };
  }

  return {
    context: counted,
    effects: [log(CallEventType.CUSTOMER_SILENCE, { streak: silenceStreak })],
    output: { silenceStreak },
    ended: false,
  };
}

function callerSpeech(ctx: ConversationContext, text: string, config: FlowConfig, turn: number, judgments?: CallJudgments): Step {
  // The line belongs to the caller's turn `turn`; a confirmation is only an answer on that turn.
  const stamped = judgments?.confirmation ? { ...judgments, confirmation: { ...judgments.confirmation, callerTurn: turn } } : judgments;
  let next: ConversationContext = withJudgments({ ...ctx, silenceStreak: 0, turnCount: ctx.turnCount + 1 }, stamped);
  next = { ...next, ...assessRisk(next, text) };
  const effects = [log(CallEventType.CUSTOMER_SPEECH, { transcript: text })];

  if (next.turnCount >= config.maxTurns) {
    const result = finishCall(next, 'Call ran long without completing intake.');
    return { ...result, effects: [...effects, ...result.effects] };
  }

  return { context: next, effects, output: {}, ended: false };
}
