/**
 * The intake as facts and permitted actions, for a receptionist that runs its
 * own conversation.
 *
 * `reduce()` answers "what should be said next". The realtime pipeline's model
 * decides that itself, so it needs something different: what is known, what is
 * missing, and whether an action is allowed. Every operation here is pure, uses
 * the same slot validation and the same `finish()` as the state machine, and
 * returns effects for `CallSessionService` to execute — so a lead or callback is
 * created exactly as on every other pipeline.
 */

import {
  CallEventType,
  ConversationState,
  outstandingRequirements,
  validateSlots,
  type FaqTopic,
  type RequirementId,
  type SlotKey,
  type SlotValues,
} from '@towai/shared';

import { resolveFaq } from './faq-resolver';
import { mergeSlots } from './slot-merge';
import { buildSummary, finish } from './state-machine';
import type { ConversationContext, Effect, FlowConfig, SummaryLine } from './types';

export type IntakeStatus = 'collecting' | 'awaiting_confirmation' | 'submitted' | 'ended';

export interface IntakeSnapshot {
  status: IntakeStatus;
  collected: SlotValues;
  /** Required details still missing, in the order a receptionist would usually ask. */
  missing: RequirementId[];
  phoneConfirmed: boolean;
  callbackRaised: boolean;
}

export type IntakeOperation =
  | {
      kind: 'update';
      slots: Partial<Record<SlotKey, unknown>>;
      /** True: the number they are calling from is right. False: they want another. */
      callerIdConfirmed?: boolean | null;
    }
  | { kind: 'state' }
  | { kind: 'business_info'; topic: FaqTopic | null; question: string }
  | { kind: 'complete'; callerConfirmed: boolean }
  | { kind: 'callback'; reason: string }
  | { kind: 'end'; reason?: string }
  | { kind: 'silence' }
  | { kind: 'caller_speech'; text: string };

export interface IntakeResult {
  context: ConversationContext;
  effects: Effect[];
  /** Returned to the model as the tool result. Facts only, never a script. */
  output: Record<string, unknown>;
  /** The call is over; the receptionist should say goodbye. */
  ended: boolean;
}

const log = (event: CallEventType, payload?: Record<string, unknown>): Effect =>
  payload ? { type: 'LOG_EVENT', event, payload } : { type: 'LOG_EVENT', event };

function missingRequirements(ctx: ConversationContext): RequirementId[] {
  const missing = outstandingRequirements(ctx.values);
  if (!ctx.phoneConfirmed && !missing.includes('customerPhone')) missing.push('customerPhone');
  return missing;
}

export function describeIntake(ctx: ConversationContext): IntakeSnapshot {
  const missing = missingRequirements(ctx);
  let status: IntakeStatus = 'collecting';
  if (ctx.state === ConversationState.ENDED) status = ctx.leadCreated ? 'submitted' : 'ended';
  else if (missing.length === 0 && isSummaryCurrent(ctx)) status = 'awaiting_confirmation';

  return {
    status,
    collected: { ...ctx.values },
    missing,
    phoneConfirmed: ctx.phoneConfirmed,
    callbackRaised: ctx.callbackRaised,
  };
}

function isSummaryCurrent(ctx: ConversationContext): boolean {
  return ctx.summaryVersion !== undefined && ctx.summaryVersion === (ctx.fieldVersion ?? 0);
}

function ended(ctx: ConversationContext, effects: Effect[], extra: Record<string, unknown>): IntakeResult {
  return {
    context: ctx,
    effects,
    output: { ...extra, callEnded: true, state: describeIntake(ctx) },
    ended: true,
  };
}

/** Finishes the call through the state machine's own terminal transition. */
function finishCall(ctx: ConversationContext, reason?: string): IntakeResult {
  const decision = finish(ctx, { spoken: true, reason });
  const leadCreated = decision.effects.some((e) => e.type === 'CREATE_LEAD');
  const context = { ...decision.context, leadCreated: ctx.leadCreated || leadCreated };
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
  options: { defaultRegionPrefix?: string } = {},
): IntakeResult {
  if (ctx.state === ConversationState.ENDED && op.kind !== 'state') {
    return ended(ctx, [], { note: 'This call has already been completed.' });
  }

  switch (op.kind) {
    case 'state':
      return { context: ctx, effects: [], output: { state: describeIntake(ctx) }, ended: false };

    case 'update':
      return update(ctx, op, options.defaultRegionPrefix);

    case 'business_info':
      return businessInfo(ctx, op.topic, op.question, config);

    case 'complete':
      return complete(ctx, op.callerConfirmed);

    case 'callback':
      return callback(ctx, op.reason);

    case 'end':
      return finishCall(ctx, op.reason);

    case 'silence':
      return silence(ctx, config);

    case 'caller_speech':
      return callerSpeech(ctx, op.text, config);
  }
}

function update(
  ctx: ConversationContext,
  op: Extract<IntakeOperation, { kind: 'update' }>,
  defaultRegionPrefix?: string,
): IntakeResult {
  const { accepted, rejected } = validateSlots(op.slots, { defaultRegionPrefix });
  const merged = mergeSlots(ctx, accepted, rejected);
  const effects = [...merged.effects];
  let next = merged.context;

  if (op.callerIdConfirmed === true && !next.phoneConfirmed) {
    next = { ...next, phoneConfirmed: true, phoneNeedsCollection: false };
    effects.push(
      log(CallEventType.FIELD_EXTRACTED, {
        field: 'customerPhone',
        value: next.values.customerPhone,
        source: 'caller_id_confirmed',
      }),
    );
  } else if (op.callerIdConfirmed === false && !merged.changed.includes('customerPhone')) {
    next = { ...next, phoneConfirmed: false, phoneNeedsCollection: true };
  }

  return {
    context: next,
    effects,
    output: {
      saved: Object.fromEntries(merged.changed.map((key) => [key, next.values[key]])),
      rejected: rejected.map((r) => ({ field: r.key, reason: r.reason })),
      state: describeIntake(next),
    },
    ended: false,
  };
}

function businessInfo(
  ctx: ConversationContext,
  topic: FaqTopic | null,
  question: string,
  config: FlowConfig,
): IntakeResult {
  const resolution = resolveFaq(topic, question, config.facts);

  if (resolution.resolved) {
    return {
      context: { ...ctx, faqCount: ctx.faqCount + 1 },
      effects: [log(CallEventType.FAQ_ANSWERED, { question })],
      output: {
        answered: true,
        fact: resolution.fact,
        rule: 'Answer using only this fact. Add nothing to it.',
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
      rule: 'You cannot answer this. Say you cannot confirm it on this call and that the towing team will follow up about it. Do not guess.',
      callbackRaised: true,
    },
  };
}

function complete(ctx: ConversationContext, callerConfirmed: boolean): IntakeResult {
  const missing = missingRequirements(ctx);
  if (missing.length > 0) {
    return {
      context: ctx,
      effects: [],
      output: { success: false, missing, state: describeIntake(ctx) },
      ended: false,
    };
  }

  // A confirmation only counts for the exact details that were read back.
  if (!callerConfirmed || !isSummaryCurrent(ctx)) {
    const summarised: ConversationContext = {
      ...ctx,
      state: ConversationState.CONFIRM_INFORMATION,
      summaryVersion: ctx.fieldVersion ?? 0,
    };
    const summary: SummaryLine[] = buildSummary(ctx.values);
    return {
      context: summarised,
      effects:
        ctx.state === ConversationState.CONFIRM_INFORMATION
          ? []
          : [log(CallEventType.STATE_CHANGED, { to: ConversationState.CONFIRM_INFORMATION })],
      output: {
        success: false,
        needsConfirmation: true,
        summary: [...summary, { label: 'Callback number', value: ctx.values.customerPhone ?? '' }],
        rule: 'Read these details back to the caller and ask if they are correct. If they say yes, call complete_request again with callerConfirmed true. If anything changes, save it first.',
      },
      ended: false,
    };
  }

  return finishCall(ctx);
}

function callback(ctx: ConversationContext, reason: string): IntakeResult {
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
    effects: [
      { type: 'CREATE_CALLBACK', reason },
      log(CallEventType.CALLBACK_CREATED, { reason }),
    ],
    output: { callbackRaised: true },
    ended: false,
  };
}

function silence(ctx: ConversationContext, config: FlowConfig): IntakeResult {
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

function callerSpeech(ctx: ConversationContext, text: string, config: FlowConfig): IntakeResult {
  const next = { ...ctx, silenceStreak: 0, turnCount: ctx.turnCount + 1 };
  const effects = [log(CallEventType.CUSTOMER_SPEECH, { transcript: text })];

  if (next.turnCount >= config.maxTurns) {
    const result = finishCall(next, 'Call ran long without completing intake.');
    return { ...result, effects: [...effects, ...result.effects] };
  }

  return { context: next, effects, output: {}, ended: false };
}
