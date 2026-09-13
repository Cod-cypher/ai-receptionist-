/**
 * The workflow. This reducer decides everything the model is not allowed to:
 * which question comes next, whether an answer counted, when the intake is
 * complete, when a lead is created, when a callback is raised, and when the
 * call ends.
 *
 * It is a pure function. Given the same context and input it returns the same
 * decision, with no I/O, no clock, and no randomness. Every behaviour in the
 * product's definition of done is therefore assertable in a unit test.
 */

import {
  CallEventType,
  CallOutcome,
  ConversationState,
  REQUIREMENTS_BY_ID,
  describeVehicle,
  isIntakeComplete,
  nextUnsatisfiedRequirement,
  type Requirement,
  type SlotKey,
  type SlotValues,
} from '@towai/shared';

import { resolveFaq } from './faq-resolver';
import { mergeSlots } from './slot-merge';
import {
  type ConversationContext,
  type Continuation,
  type Effect,
  type FlowConfig,
  type SummaryLine,
  type TurnDecision,
  type TurnInput,
} from './types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The requirement currently outstanding.
 *
 * Phone gets special handling: the caller ID pre-fills it, so the slot-level
 * check reports it satisfied from the first millisecond of the call. It is only
 * genuinely done once the caller has confirmed it, or given a different number.
 */
export function pendingRequirement(ctx: ConversationContext): Requirement | null {
  const bySlots = nextUnsatisfiedRequirement(ctx.values);
  if (bySlots) return bySlots;
  if (!ctx.phoneConfirmed) return REQUIREMENTS_BY_ID.customerPhone;
  return null;
}

export function intakeDone(ctx: ConversationContext): boolean {
  return isIntakeComplete(ctx.values) && ctx.phoneConfirmed;
}

/** The read-back summary. Only fields that were actually collected appear. */
export function buildSummary(values: SlotValues): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value) lines.push({ label, value });
  };

  push('Name', values.customerName);
  push('Service', values.serviceType);
  push('Location', values.location);
  push('Destination', values.destination);
  push('Vehicle', describeVehicle(values));
  if (typeof values.vehicleMovable === 'boolean') {
    lines.push({
      label: 'Vehicle movable',
      value: values.vehicleMovable ? 'yes' : 'no',
    });
  }
  push('Condition', values.vehicleCondition);
  push('Notes', values.additionalNotes);

  return lines;
}

/** Where to go once an interjection has been dealt with. */
function continuationFor(ctx: ConversationContext): Continuation {
  if (intakeDone(ctx)) return { kind: 'summary', summary: buildSummary(ctx.values) };
  const next = pendingRequirement(ctx);
  return next ? { kind: 'ask', requirement: next } : { kind: 'none' };
}

function stateForContinuation(cont: Continuation): ConversationState {
  if (cont.kind === 'summary') return ConversationState.CONFIRM_INFORMATION;
  if (cont.kind === 'ask') return cont.requirement.state;
  return ConversationState.CLOSING;
}

function log(event: CallEventType, payload?: Record<string, unknown>): Effect {
  return payload ? { type: 'LOG_EVENT', event, payload } : { type: 'LOG_EVENT', event };
}

/**
 * Whether enough was captured to be worth telling the operator about, even
 * though intake never finished. A bare caller ID is not; a caller ID plus a
 * location or a vehicle is something the operator can act on.
 */
function hasSalvageableInformation(values: SlotValues): boolean {
  return Boolean(
    values.location || values.serviceType || describeVehicle(values) || values.customerName,
  );
}

/* -------------------------------------------------------------------------- */
/*  Terminal transitions                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Finish the call, choosing the strongest record the collected data supports.
 *
 * Ordering matters: a complete intake becomes a lead even when the call ended
 * abruptly, because the operator would rather ring a complete lead than read an
 * abandoned-call row. Partial data becomes a callback for the same reason. This
 * is the "never miss a lead" promise expressed as code.
 */
export function finish(
  ctx: ConversationContext,
  opts: { spoken: boolean; reason?: string; preferCallback?: boolean },
): TurnDecision {
  if (ctx.finalised) {
    return {
      context: { ...ctx, state: ConversationState.ENDED },
      directive: { kind: 'SILENT_END' },
      effects: [{ type: 'END_CALL', outcome: CallOutcome.LEAD_CREATED }],
    };
  }

  const effects: Effect[] = [];
  let outcome: CallOutcome;

  const complete = isIntakeComplete(ctx.values);

  if (complete && !opts.preferCallback) {
    effects.push({ type: 'CREATE_LEAD' }, log(CallEventType.LEAD_CREATED));
    outcome = CallOutcome.LEAD_CREATED;
  } else if (opts.preferCallback || hasSalvageableInformation(ctx.values)) {
    const reason =
      opts.reason ?? ctx.escalationReason ?? 'Call ended before all details were collected.';
    if (complete) {
      // Both records: a real towing need plus an unanswered question.
      effects.push({ type: 'CREATE_LEAD' }, log(CallEventType.LEAD_CREATED));
    }
    // A passive ending (hang-up, silence, time limit) must not repeat a callback
    // the call already raised: the operator has a record to ring back on, and
    // a second identical WhatsApp reads as a system fault. An explicit new
    // escalation is a different request, so it still gets its own record.
    if (opts.preferCallback || !ctx.callbackRaised) {
      effects.push(
        { type: 'CREATE_CALLBACK', reason },
        log(CallEventType.CALLBACK_CREATED, { reason }),
      );
    }
    outcome = CallOutcome.CALLBACK_CREATED;
  } else if (ctx.callbackRaised) {
    outcome = CallOutcome.CALLBACK_CREATED;
  } else if (ctx.faqCount > 0) {
    outcome = CallOutcome.FAQ_ANSWERED;
  } else {
    outcome = CallOutcome.ABANDONED;
  }

  effects.push({ type: 'END_CALL', outcome });

  return {
    context: {
      ...ctx,
      state: ConversationState.ENDED,
      finalised: true,
      callbackRaised: ctx.callbackRaised || outcome === CallOutcome.CALLBACK_CREATED,
    },
    directive: opts.spoken ? { kind: 'CLOSE', outcome } : { kind: 'SILENT_END' },
    effects,
  };
}

/** Raise a callback and end the call, speaking a promise to ring back. */
function escalate(ctx: ConversationContext, reason: string): TurnDecision {
  const escalated: ConversationContext = {
    ...ctx,
    state: ConversationState.ESCALATE_CALLBACK,
    escalationReason: reason,
  };

  const closed = finish(escalated, { spoken: true, reason, preferCallback: true });

  return {
    ...closed,
    directive: { kind: 'ESCALATE', reason },
    effects: [
      log(CallEventType.STATE_CHANGED, { to: ConversationState.ESCALATE_CALLBACK }),
      ...closed.effects,
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  Reducer                                                                   */
/* -------------------------------------------------------------------------- */

export function reduce(
  ctx: ConversationContext,
  input: TurnInput,
  config: FlowConfig,
): TurnDecision {
  switch (input.kind) {
    case 'START':
      return start(ctx);
    case 'HANGUP':
      return finish(ctx, { spoken: false });
    case 'MAX_DURATION':
      return finish(ctx, {
        spoken: true,
        reason: 'Call reached the maximum length before intake finished.',
      });
    case 'PROVIDER_ERROR':
      return handleProviderError(ctx, input.message);
    case 'SILENCE':
      return handleSilence(ctx, config);
    case 'UTTERANCE':
      return handleUtterance(ctx, input, config);
    default: {
      const exhaustive: never = input;
      throw new Error(`Unhandled turn input: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function start(ctx: ConversationContext): TurnDecision {
  const next = pendingRequirement(ctx);
  return {
    context: { ...ctx, state: next?.state ?? ConversationState.CONFIRM_INFORMATION },
    directive: { kind: 'GREET' },
    effects: [log(CallEventType.AI_GREETING)],
  };
}

function handleProviderError(ctx: ConversationContext, message: string): TurnDecision {
  // A failed provider is our problem, not the caller's. Rather than loop on an
  // apology, take the callback route so the lead still reaches the operator.
  return escalate(
    { ...ctx, state: ConversationState.ERROR_FALLBACK },
    `The receptionist hit a technical problem during the call (${message}).`,
  );
}

function handleSilence(ctx: ConversationContext, config: FlowConfig): TurnDecision {
  const silenceStreak = ctx.silenceStreak + 1;

  if (silenceStreak >= config.maxSilenceStreak) {
    return finish(
      { ...ctx, silenceStreak },
      { spoken: true, reason: 'Caller went silent before intake finished.' },
    );
  }

  return {
    context: { ...ctx, silenceStreak },
    directive: { kind: 'PROMPT_AFTER_SILENCE', requirement: pendingRequirement(ctx) },
    effects: [log(CallEventType.CUSTOMER_SILENCE, { streak: silenceStreak })],
  };
}

function handleUtterance(
  ctx: ConversationContext,
  input: Extract<TurnInput, { kind: 'UTTERANCE' }>,
  config: FlowConfig,
): TurnDecision {
  const effects: Effect[] = [
    log(CallEventType.CUSTOMER_SPEECH, { transcript: input.transcript }),
  ];

  // ---- Merge observations -------------------------------------------------
  const merged = mergeSlots(ctx, input.accepted, input.rejected);
  const changed = merged.changed;
  effects.push(...merged.effects);

  let next: ConversationContext = {
    ...merged.context,
    silenceStreak: 0,
    turnCount: ctx.turnCount + 1,
  };

  // ---- Hard limits --------------------------------------------------------
  if (next.turnCount >= config.maxTurns) {
    return withEffects(
      effects,
      finish(next, { spoken: true, reason: 'Call ran long without completing intake.' }),
    );
  }

  // ---- Speech act ---------------------------------------------------------
  switch (input.extraction.intent) {
    case 'out_of_scope': {
      const reason =
        input.extraction.outOfScopeRequest ??
        'Caller asked for something the receptionist cannot handle.';
      return withEffects(effects, escalate(next, reason));
    }

    case 'end_call':
      return withEffects(effects, finish(next, { spoken: true }));

    case 'faq':
      return withEffects(effects, handleFaq(next, input, config));

    case 'deny':
      return withEffects(effects, handleDeny(next, config));

    case 'confirm':
      return withEffects(effects, handleConfirm(next, changed, config));

    case 'unclear': {
      const unclearStreak = next.unclearStreak + 1;
      next = { ...next, unclearStreak };

      // Something useful landed regardless of the label; treat it as progress.
      if (changed.length === 0) {
        if (unclearStreak >= config.maxUnclearStreak) {
          return withEffects(
            effects,
            escalate(
              next,
              'The receptionist could not understand the caller after several attempts.',
            ),
          );
        }

        return withEffects(effects, {
          context: next,
          directive: {
            kind: 'DID_NOT_UNDERSTAND',
            requirement: pendingRequirement(next),
          },
          effects: [],
        });
      }
      break;
    }

    case 'provide_info':
    default:
      break;
  }

  next = { ...next, unclearStreak: 0 };

  // ---- Correction loop ----------------------------------------------------
  if (next.awaitingCorrection) {
    if (changed.length === 0) {
      return withEffects(effects, {
        context: next,
        directive: { kind: 'ACKNOWLEDGE_CORRECTION', requirement: null },
        effects: [],
      });
    }
    next = { ...next, awaitingCorrection: false };
  }

  return withEffects(effects, advance(next, changed, config));
}

/**
 * Move the intake forward: ask for the next missing requirement, or read the
 * summary back when nothing is missing.
 */
function advance(
  ctx: ConversationContext,
  changed: SlotKey[],
  config: FlowConfig,
): TurnDecision {
  if (intakeDone(ctx)) {
    return {
      context: { ...ctx, state: ConversationState.CONFIRM_INFORMATION },
      directive: { kind: 'CONFIRM_SUMMARY', summary: buildSummary(ctx.values) },
      effects: [
        log(CallEventType.STATE_CHANGED, { to: ConversationState.CONFIRM_INFORMATION }),
      ],
    };
  }

  const requirement = pendingRequirement(ctx);
  if (!requirement) {
    // Unreachable while `intakeDone` and `pendingRequirement` agree, but a
    // stalled call is worse than a redundant branch.
    return finish(ctx, { spoken: true });
  }

  if (requirement.id === 'customerPhone' && ctx.phoneNeedsCollection) {
    return {
      context: { ...ctx, state: ConversationState.CONFIRM_PHONE },
      directive: { kind: 'ASK_ALTERNATE_PHONE' },
      effects: [],
    };
  }

  const attempts = (ctx.askAttempts[requirement.id] ?? 0) + 1;

  // The same question three times over is a conversation that is not going to
  // recover. Hand it to a human rather than trapping the caller in a loop.
  if (attempts > config.maxAskAttempts) {
    return escalate(
      ctx,
      `The receptionist could not collect the caller's ${requirement.id} after ` +
        `${config.maxAskAttempts} attempts.`,
    );
  }

  const askedBefore = (ctx.askAttempts[requirement.id] ?? 0) > 0;
  const madeProgress = changed.length > 0;

  return {
    context: {
      ...ctx,
      state: requirement.state,
      askAttempts: { ...ctx.askAttempts, [requirement.id]: attempts },
    },
    directive:
      askedBefore && !madeProgress
        ? { kind: 'REASK', requirement, attempt: attempts }
        : { kind: 'ASK', requirement, attempt: attempts },
    effects: [log(CallEventType.STATE_CHANGED, { to: requirement.state })],
  };
}

function handleFaq(
  ctx: ConversationContext,
  input: Extract<TurnInput, { kind: 'UTTERANCE' }>,
  config: FlowConfig,
): TurnDecision {
  const question = input.extraction.faqQuestion ?? input.transcript;
  const resolution = resolveFaq(input.extraction.faqTopic, question, config.facts);

  if (!resolution.resolved) {
    // Configured data does not cover it. Raise a callback, say so plainly, and
    // carry on with the intake rather than ending a call that is going fine.
    const withCallback: ConversationContext = {
      ...ctx,
      escalationReason: question,
      callbackRaised: true,
    };
    const then = continuationFor(withCallback);

    return {
      context: { ...withCallback, state: stateForContinuation(then) },
      directive: { kind: 'CANNOT_ANSWER', question, then },
      effects: [
        { type: 'CREATE_CALLBACK', reason: question },
        log(CallEventType.CALLBACK_CREATED, { reason: resolution.reason }),
      ],
    };
  }

  const answered: ConversationContext = { ...ctx, faqCount: ctx.faqCount + 1 };
  const then = continuationFor(answered);

  return {
    context: { ...answered, state: stateForContinuation(then) },
    directive: { kind: 'ANSWER_FAQ', question, fact: resolution.fact, then },
    effects: [log(CallEventType.FAQ_ANSWERED, { question })],
  };
}

function handleDeny(ctx: ConversationContext, config: FlowConfig): TurnDecision {
  // "No, that's not right" against the read-back summary.
  if (ctx.state === ConversationState.CONFIRM_INFORMATION) {
    return {
      context: { ...ctx, state: ConversationState.CORRECTING, awaitingCorrection: true },
      directive: { kind: 'ACKNOWLEDGE_CORRECTION', requirement: null },
      effects: [log(CallEventType.STATE_CHANGED, { to: ConversationState.CORRECTING })],
    };
  }

  // "No" to "is this the best number?" means take a different one.
  if (ctx.state === ConversationState.CONFIRM_PHONE && !ctx.phoneConfirmed) {
    return {
      context: { ...ctx, phoneNeedsCollection: true },
      directive: { kind: 'ASK_ALTERNATE_PHONE' },
      effects: [],
    };
  }

  // A bare "no" anywhere else carries no information; re-ask what is pending.
  const requirement = pendingRequirement(ctx);
  if (!requirement) return advance(ctx, [], config);

  return {
    context: ctx,
    directive: {
      kind: 'REASK',
      requirement,
      attempt: (ctx.askAttempts[requirement.id] ?? 0) + 1,
    },
    effects: [],
  };
}

function handleConfirm(
  ctx: ConversationContext,
  changed: SlotKey[],
  config: FlowConfig,
): TurnDecision {
  // "Yes" to the read-back summary is the signal to create the lead.
  if (ctx.state === ConversationState.CONFIRM_INFORMATION && intakeDone(ctx)) {
    return finish(ctx, { spoken: true });
  }

  // "Yes" to "is this the best number?" completes the phone requirement.
  if (ctx.state === ConversationState.CONFIRM_PHONE && !ctx.phoneConfirmed) {
    const confirmed: ConversationContext = { ...ctx, phoneConfirmed: true };
    const effects: Effect[] = [
      log(CallEventType.FIELD_EXTRACTED, {
        field: 'customerPhone',
        value: confirmed.values.customerPhone,
        source: 'caller_id_confirmed',
      }),
    ];
    return withEffects(effects, advance(confirmed, changed, config));
  }

  // An unattached "yes" — carry on with whatever is outstanding.
  return advance(ctx, changed, config);
}

function withEffects(prefix: Effect[], decision: TurnDecision): TurnDecision {
  return { ...decision, effects: [...prefix, ...decision.effects] };
}
