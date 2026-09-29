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

import type { CallJudgments, ConfirmationJudgment, ServiceJudgment } from '../integrations/judgment/judgment.interface';
import {
  ANSWERED_FLOOR,
  CONFIRMATION_FLOOR,
  CORRECTION_FLOOR,
  MOVE_CONFIDENCE_FLOOR,
  NAMES_A_SERVICE,
  SERVICE_CONFIDENCE_FLOOR,
  SERVICE_LABEL,
} from '../integrations/judgment/typesafe-questions';
import { resolveFaq } from './faq-resolver';
import { refineLocation, type LocationStatus } from './location';
import { determineNextAction, locationSettled, type NextAction, type NextActionOptions, type NextActionPlan, type Topic } from './next-action';
import { ETA_ANSWER, PRICE_ANSWER, askedAbout, type AskedAbout } from './ready-answers';
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
  /**
   * Something the caller just said that wants an answer before the required
   * action: a complaint about the call, a question, or a check of the line.
   */
  callerSaid?: { kind: 'complaint' | 'question' | 'line_check'; text: string };
  /**
   * The caller spoke over the read-back: this is as much of it as they
   * heard. With `readBack`, what is left of it to say.
   */
  readBackHeard?: string;
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
  | { kind: 'caller_speech'; text: string }
  /**
   * What the judge made of a caller line, arriving after the line itself.
   * The line is applied at once, by the rules, so the call never waits for
   * the judge; this folds the judgment in when it is ready.
   */
  | { kind: 'judgment'; text: string; judgments: CallJudgments }
  /**
   * The caller spoke over the read-back and it was stopped. `heard` is the
   * part that had played. Only the gateway knows this: it is what tracks
   * playback.
   */
  | { kind: 'read_back_cut'; heard: string };

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

/**
 * A complaint, question or line check from the caller's latest turn or the
 * one before it. Older than that and the conversation has moved on.
 */
function callerSaid(ctx: ConversationContext, turn: number | undefined): IntakeSnapshot['callerSaid'] {
  const judged = ctx.judgments?.move;
  if (!judged || turn === undefined || judged.confidence < MOVE_CONFIDENCE_FLOOR) return undefined;
  if (judged.move !== 'complaint' && judged.move !== 'question' && judged.move !== 'line_check') return undefined;
  // Only a line known to have gone unanswered. The judgment of a line arrives
  // after the reply to it has been asked for, and the model hears the caller
  // itself: reminded without knowing this, it answered the same question on
  // the caller's next turn, when they had said "yes" to something else.
  if (judged.answered === undefined || judged.answered >= ANSWERED_FLOOR) return undefined;
  if (turn - judged.callerTurn > 2 || turn < judged.callerTurn) return undefined;
  // Told once. On any later turn the model has had its chance to answer.
  if (judged.deliveredTurn !== undefined && judged.deliveredTurn !== turn) return undefined;
  return { kind: judged.move, text: judged.text };
}

/** What the caller has asked that the towing team must come back to them on. */
function withAsked(ctx: ConversationContext, asked: readonly AskedAbout[]): ConversationContext {
  const fresh = asked.filter((topic) => !ctx.callerAsked?.includes(topic));
  return fresh.length > 0 ? { ...ctx, callerAsked: [...(ctx.callerAsked ?? []), ...fresh] } : ctx;
}

export function describeIntake(
  ctx: ConversationContext,
  plan: NextActionPlan = determineNextAction(ctx),
  /** The caller's current turn, when known. */
  turn?: number,
): IntakeSnapshot {
  let status: IntakeStatus = 'collecting';
  if (ctx.state === ConversationState.ENDED) status = ctx.leadCreated ? 'submitted' : 'ended';
  else if (plan.action === 'AWAIT_CONFIRMATION') status = 'awaiting_confirmation';
  const said = status === 'collecting' || status === 'awaiting_confirmation' ? callerSaid(ctx, turn) : undefined;

  return {
    ...(said ? { callerSaid: said } : {}),
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
    ...(plan.summary && plan.action === 'AWAIT_CONFIRMATION' && ctx.pendingConfirmation?.cutAfter !== undefined
      ? { readBackHeard: ctx.pendingConfirmation.cutAfter }
      : {}),
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
    case 'AWAIT_CONFIRMATION': {
      // Told to finish a cut read-back: that holds for this caller turn, and no later one.
      const pending = ctx.pendingConfirmation;
      return pending?.cutAfter !== undefined && pending.resumeTurn === undefined
        ? { ...ctx, pendingConfirmation: { ...pending, resumeTurn: turn } }
        : ctx;
    }
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
    callerTurn: turn,
  };

  const step =
    ctx.state === ConversationState.ENDED && op.kind !== 'state'
      ? ended(ctx, [], { note: 'This call has already been completed.' })
      : run(ctx, op, config, options, turn, planOptions);

  const plan = determineNextAction(step.context, planOptions);
  // Only a plan the model actually receives counts as asked: tool results and
  // the per-turn state note. Transcripts, silence ticks and what the gateway
  // reports about playback are not sent to it.
  const delivered = op.kind !== 'caller_speech' && op.kind !== 'silence' && op.kind !== 'judgment' && op.kind !== 'read_back_cut';
  const state = describeIntake(step.context, plan, options.callerTurn);
  let context = delivered ? issue(step.context, plan, turn) : step.context;
  if (delivered && state.callerSaid && context.judgments?.move && context.judgments.move.deliveredTurn === undefined) {
    context = { ...context, judgments: { ...context.judgments, move: { ...context.judgments.move, deliveredTurn: turn } } };
  }

  return { context, effects: step.effects, output: { ...step.output, state }, ended: step.ended, plan };
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
function refuse(accepted: SlotValues, ctx: ConversationContext): Array<{ field: string; reason: string }> {
  const refused: Array<{ field: string; reason: string }> = [];

  // Seen on a real call: asked for the model of the Honda, the caller said
  // "it's twenty-twenty-two", and the lead went out as a Honda 2022. The year
  // is worth keeping; it is not the model.
  const year = accepted.vehicleModel?.match(/^(?:19|20)\d{2}$/)?.[0];
  if (year) {
    delete accepted.vehicleModel;
    const note = `Vehicle year: ${year}`;
    const notes = accepted.additionalNotes ?? ctx.values.additionalNotes;
    if (!notes?.includes(note)) accepted.additionalNotes = notes ? `${notes} ${note}.` : `${note}.`;
    refused.push({
      field: 'vehicleModel',
      reason: `${year} is the year, which has been noted. The model is still needed: ask for it, or for what kind of vehicle it is (car, SUV, pickup).`,
    });
  }

  // Seen on a real call: the notes were rewritten every turn with commentary
  // ("Caller feels they are being cut off"), and ended as "Caller confirmed
  // they are safe", which the lead's safety note already says.
  if (accepted.additionalNotes && COMMENTARY.test(accepted.additionalNotes)) {
    delete accepted.additionalNotes;
    if (year) accepted.additionalNotes = `Vehicle year: ${year}.`;
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
  if (!judgments || Object.values(judgments).every((judgment) => judgment === undefined)) return ctx;
  const { reply, ...rest } = judgments;
  let next: ConversationContext = Object.keys(rest).length > 0 ? { ...ctx, judgments: { ...ctx.judgments, ...rest } } : ctx;

  // A reply is judged against the line it replied to. A turn can have more
  // than one reply (a few words, a lookup, then the answer): answered by any
  // of them is answered.
  const move = next.judgments?.move;
  if (reply && move && move.text === reply.text) {
    next = { ...next, judgments: { ...next.judgments, move: { ...move, answered: Math.max(move.answered ?? 0, reply.answered) } } };
  }
  const topic = next.judgments?.move?.topic;
  return topic === 'eta' || topic === 'price' ? withAsked(next, [topic]) : next;
}

/** A line belongs to one caller turn; what was judged about it is only about that turn. */
function stamped(judgments: CallJudgments | undefined, turn: number): CallJudgments | undefined {
  if (!judgments) return judgments;
  return {
    ...judgments,
    ...(judgments.confirmation ? { confirmation: { ...judgments.confirmation, callerTurn: turn } } : {}),
    ...(judgments.move ? { move: { ...judgments.move, callerTurn: turn } } : {}),
  };
}

/**
 * The words that would be saved as the help the caller needs, when they
 * describe a problem ("won't start") rather than name a service ("a tow").
 * Those are the ones worth a judgment.
 */
export function previewProblemAsService(op: Extract<IntakeOperation, { kind: 'update' }>): string | undefined {
  const { accepted } = validateSlots({ serviceType: op.slots.serviceType });
  return accepted.serviceType && !NAMES_A_SERVICE.test(accepted.serviceType) ? accepted.serviceType : undefined;
}

/**
 * The caller said what is wrong, the model saved it as what they want. With
 * a judgment about those words: the problem is kept as the vehicle's
 * condition; the help is saved if the judge is sure of it, marked as inferred,
 * and otherwise left open, for the receptionist to offer the likeliest two.
 */
function problemAsService(
  accepted: SlotValues,
  ctx: ConversationContext,
  judged: ServiceJudgment | undefined,
): { inferred: boolean; refused: Array<{ field: string; reason: string }> } {
  const said = accepted.serviceType;
  if (!said || !judged || judged.text !== said || NAMES_A_SERVICE.test(said)) return { inferred: false, refused: [] };

  if (!accepted.vehicleCondition && !ctx.values.vehicleCondition) accepted.vehicleCondition = said;
  if (judged.service !== 'unclear' && judged.confidence >= SERVICE_CONFIDENCE_FLOOR) {
    accepted.serviceType = SERVICE_LABEL[judged.service];
    return { inferred: true, refused: [] };
  }
  delete accepted.serviceType;
  return {
    inferred: false,
    refused: [
      {
        field: 'serviceType',
        reason: `"${said}" is what is wrong with the vehicle, and was saved as that. What help they want is still open: do the required action.`,
      },
    ],
  };
}

/**
 * From a line the caller spoke, with no help saved yet: "it's stuck, it's not
 * moving" is a tow, and asking "what kind of help do you need?" a fourth time
 * is what the real call did. Saved only if the judge is sure, as inferred.
 */
function serviceFromSpeech(ctx: ConversationContext): { context: ConversationContext; effects: Effect[] } {
  const judged = ctx.judgments?.service;
  if (!judged || ctx.values.serviceType || judged.service === 'unclear' || judged.confidence < SERVICE_CONFIDENCE_FLOOR) {
    return { context: ctx, effects: [] };
  }
  const merged = mergeSlots(ctx, { serviceType: SERVICE_LABEL[judged.service] }, [], { preferSpecific: true });
  return {
    context: { ...merged.context, fieldSources: { ...(merged.context.fieldSources ?? {}), serviceType: 'inferred' } },
    effects: merged.effects,
  };
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
    case 'judgment':
      return foldJudgment(ctx, op.text, stamped(op.judgments, turn));
    case 'read_back_cut': {
      const pending = ctx.pendingConfirmation;
      const current = pending?.kind === 'details' && pending.fieldVersion === (ctx.fieldVersion ?? 0);
      const context = current ? { ...ctx, pendingConfirmation: { ...pending!, cutAfter: op.heard, resumeTurn: undefined } } : ctx;
      return { context, effects: [], output: {}, ended: false };
    }
  }
}

/** A judgment about a line already applied: danger, urgency and the help needed are read from it now. */
function foldJudgment(ctx: ConversationContext, text: string, judgments: CallJudgments | undefined): Step {
  let next = withJudgments(ctx, judgments);
  next = { ...next, ...assessRisk(next, text) };
  const service = serviceFromSpeech(next);
  return { context: service.context, effects: service.effects, output: {}, ended: false };
}

function update(
  ctx: ConversationContext,
  op: Extract<IntakeOperation, { kind: 'update' }>,
  turn: number,
  options: IntakeOptions,
): Step {
  const { accepted, rejected } = validateSlots(op.slots, { defaultRegionPrefix: options.defaultRegionPrefix });
  if (accepted.location) accepted.location = previewLocation(ctx, op, options.defaultRegionPrefix);
  const service = problemAsService(accepted, ctx, options.judgments?.service);
  const refused = [...refuse(accepted, ctx), ...service.refused];
  const inferred = service.inferred ? [...(op.inferred ?? []), 'serviceType' as const] : op.inferred;

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
    else if (inferred?.includes(key)) sources[key] = 'inferred';
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

  // How soon and how much: there is a ready answer, and the lead carries the
  // promise it makes. No callback is raised for these: the lead is followed
  // up anyway, and on a real call each repeat of the question raised another.
  const asked: AskedAbout[] = topic === 'eta' ? ['eta'] : topic === 'pricing' ? ['price'] : askedAbout(question);
  if (asked.length > 0) {
    return {
      context: withAsked(ctx, asked),
      effects: [log(CallEventType.FAQ_ANSWERED, { question, answered: false, noted: asked })],
      output: {
        answered: false,
        reason: resolution.reason,
        rule: `Say this, once, and then carry on from where you were: "${asked.map((a) => (a === 'eta' ? ETA_ANSWER : PRICE_ANSWER)).join(' ')}"`,
      },
      ended: false,
    };
  }

  const raised = callback(ctx, question);
  return {
    ...raised,
    output: {
      answered: false,
      reason: resolution.reason,
      rule: 'You cannot answer this. Say so in one short sentence, and that the towing team will go over it when they call. Do not guess. Then carry on from where you were.',
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
  if (callerConfirmed && current && turn > pending!.callerTurn && (!judged || isConfirmation(judged))) {
    return finishCall({ ...ctx, detailsConfirmed: true });
  }

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
  let next: ConversationContext = withJudgments({ ...ctx, silenceStreak: 0, turnCount: ctx.turnCount + 1 }, stamped(judgments, turn));
  next = withAsked(next, askedAbout(text));
  next = { ...next, ...assessRisk(next, text) };
  const service = serviceFromSpeech(next);
  next = service.context;
  const effects = [log(CallEventType.CUSTOMER_SPEECH, { transcript: text }), ...service.effects];

  if (next.turnCount >= config.maxTurns) {
    const result = finishCall(next, 'Call ran long without completing intake.');
    return { ...result, effects: [...effects, ...result.effects] };
  }

  return { context: next, effects, output: {}, ended: false };
}
