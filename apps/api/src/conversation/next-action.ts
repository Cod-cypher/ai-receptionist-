/**
 * The priority engine: what the receptionist must do next.
 *
 * The realtime model phrases this; it does not choose it. The order is the
 * existing requirement order from `REQUIREMENTS` (the business's intake order),
 * with three additions only code can judge reliably: safety advice comes
 * first, a detail the model was unsure it heard is checked straight away, and
 * a location too vague to dispatch to is narrowed down before anything else
 * is asked.
 *
 * `doNotAsk` names every topic that must wait: everything already known and
 * everything lower in the order. It is what stops "I-95" being followed by
 * "is this the best number to reach you?".
 */

import {
  ConversationState,
  REQUIREMENTS,
  SLOT_DEFS,
  type Requirement,
  type RequirementId,
  type SlotKey,
  type SlotValues,
} from '@towai/shared';

import { SERVICE_LABEL } from '../integrations/judgment/typesafe-questions';
import { assessLocation, type LocationAssessment } from './location';
import { HIGH_SPEED_ROAD_HAZARD } from './risk';
import { buildSummary } from './state-machine';
import type { ConversationContext, SummaryLine } from './types';

export type NextAction =
  | 'HANDLE_SAFETY'
  | 'CLARIFY_FIELD'
  | 'ASK_SERVICE_TYPE'
  | 'ASK_LOCATION'
  | 'ASK_LOCATION_DETAIL'
  | 'ASK_VEHICLE'
  | 'ASK_VEHICLE_MOVABLE'
  | 'ASK_CUSTOMER_NAME'
  | 'CONFIRM_CALLBACK_NUMBER'
  | 'ASK_CALLBACK_NUMBER'
  | 'CONFIRM_DETAILS'
  | 'AWAIT_CONFIRMATION'
  | 'CLOSE';

/** What a question is about. Used to spot a reply asking the wrong thing. */
export type Topic =
  | 'safety'
  | 'service'
  | 'location'
  | 'vehicle'
  | 'movable'
  | 'name'
  | 'callback_number'
  | 'details'
  | 'destination';

export interface NextActionPlan {
  action: NextAction;
  topic: Topic | null;
  /** What to ask, in plain words, for the model to phrase. */
  ask: string;
  /** Topics that must not be asked about now. */
  doNotAsk: Topic[];
  /** For CLARIFY_FIELD: the fields to check. */
  clarify?: SlotKey[];
  /** For CONFIRM_DETAILS / AWAIT_CONFIRMATION: what to read back. */
  summary?: SummaryLine[];
  location: LocationAssessment;
  /**
   * Why this action, for the call's event trail: the deciding reason first,
   * then what stood around it. Never sent to the model.
   */
  because: string[];
  /** Topics already settled: known, or given up on. A question about one is not "to wait", it is done. */
  settled: Topic[];
}

export interface NextActionOptions {
  emergencyNumber?: string;
  knownAreas?: readonly string[];
  /** The caller's current turn. Without it, a cut read-back is finished whenever it is next asked about. */
  callerTurn?: number;
}

/** Detail requests before a vague location is accepted as the best available. */
export const MAX_LOCATION_DETAIL_ATTEMPTS = 2;

/**
 * Caller turns on which the same thing may be asked before the receptionist
 * moves on without it. What is missing is then for the towing team to get
 * when they call: a caller asked the same thing a fourth time hangs up.
 */
export const MAX_ASKS = 3;
/** A value the model was not sure it heard is checked with the caller once. */
export const MAX_CLARIFICATIONS = 1;
/**
 * Caller turns spent waiting for a yes to the read-back before the call is
 * finished with the details unconfirmed. Questions get answered on those
 * turns; what does not happen is a fifth "were those details right?".
 */
export const MAX_CONFIRMATION_WAITS = 4;

/** What an ask is counted under. A value to check is counted with the value, so a new value is a new check. */
export function askKeys(plan: Pick<NextActionPlan, 'action' | 'clarify'>, values: SlotValues): string[] {
  if (plan.action === 'CLARIFY_FIELD') return (plan.clarify ?? []).map((key) => `CLARIFY_FIELD:${key}=${String(values[key])}`);
  return [plan.action];
}

/** Caller turns before this one on which `key` was asked. Asking again within a turn is the same ask. */
function askedBefore(ctx: ConversationContext, key: string, turn: number | undefined): number {
  const asked = ctx.asked?.[key];
  if (!asked) return 0;
  return turn !== undefined && asked.turn === turn ? asked.count - 1 : asked.count;
}

// Not "say you did not get it": a caller who asked about the weather was told
// "I'm not sure where the vehicle is", and one who said "It's a plane" was told
// "Sorry, I didn't catch that".
const ASK_AGAIN =
  'You have asked this before and do not have it yet. Do not repeat the same words. If they tried to answer and you could not use it, say briefly why, and ask in a different, simpler way, with an example or two of what you mean. If they talked about something else, answer that, then ask again in different words. Never say you did not hear them when you did. ';

const ORDER: Topic[] = ['safety', 'service', 'location', 'vehicle', 'movable', 'name', 'callback_number', 'details'];

const TOPIC_OF_REQUIREMENT: Record<RequirementId, Topic> = {
  serviceType: 'service',
  location: 'location',
  vehicle: 'vehicle',
  vehicleMovable: 'movable',
  customerName: 'name',
  customerPhone: 'callback_number',
};

const ASK_ACTION: Record<Exclude<RequirementId, 'customerPhone'>, NextAction> = {
  serviceType: 'ASK_SERVICE_TYPE',
  location: 'ASK_LOCATION',
  vehicle: 'ASK_VEHICLE',
  vehicleMovable: 'ASK_VEHICLE_MOVABLE',
  customerName: 'ASK_CUSTOMER_NAME',
};

export function topicOfSlot(key: SlotKey): Topic | null {
  switch (key) {
    case 'serviceType':
      return 'service';
    case 'location':
      return 'location';
    case 'destination':
      return 'destination';
    case 'vehicleMake':
    case 'vehicleModel':
    case 'vehicleType':
      return 'vehicle';
    case 'vehicleMovable':
    case 'vehicleCondition':
      return 'movable';
    case 'customerName':
      return 'name';
    case 'customerPhone':
      return 'callback_number';
    default:
      return null;
  }
}

const show = (value: unknown) => (typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value));

/** True once the caller has been asked to confirm the read-back on `MAX_CONFIRMATION_WAITS` turns without a yes. */
export function confirmationOverdue(ctx: ConversationContext, turn: number | undefined): boolean {
  const current = ctx.pendingConfirmation?.kind === 'details' && ctx.pendingConfirmation.fieldVersion === (ctx.fieldVersion ?? 0);
  return current && askedBefore(ctx, 'AWAIT_CONFIRMATION', turn) >= MAX_CONFIRMATION_WAITS;
}

/** A location the caller could not narrow down further counts as settled. */
export function locationSettled(ctx: ConversationContext, location: LocationAssessment): boolean {
  if (location.status === 'complete') return true;
  return location.status === 'partial' && (ctx.locationDetailAttempts ?? 0) >= MAX_LOCATION_DETAIL_ATTEMPTS;
}

/**
 * The caller has said what is wrong but not what they want done, and the
 * judge could not tell either. "What kind of help do you need?" has then
 * already failed once; the two likeliest kinds of help are offered instead.
 */
function offerOfHelp(ctx: ConversationContext): string | null {
  const judged = ctx.judgments?.service;
  if (!judged || judged.alternatives.length === 0) return null;
  const [first, second] = judged.alternatives.map((kind) => SERVICE_LABEL[kind]);
  const offer = second ? `a ${first} or a ${second}` : `a ${first}`;
  return `The caller has described the problem ("${judged.text}") but has not said what help they want. Do not ask what they need again: ask whether they need ${offer}.`;
}

/**
 * The question for a requirement, in the light of what is saved. "Can it
 * still move, or does it need to be towed?" to a caller who opened with "I
 * need a tow" sounds like not listening; what the dispatcher needs to know
 * then is whether it rolls.
 */
function questionFor(requirement: Requirement, ctx: ConversationContext): string {
  if (requirement.id === 'vehicleMovable' && /\btow/i.test(ctx.values.serviceType ?? '')) {
    return 'whether the vehicle can roll and steer, so it can be pulled onto the truck, or is stuck where it is';
  }
  return requirement.canonicalQuestion;
}

/** What is saved, in short, for the reasons on a plan. */
function savedFacts(ctx: ConversationContext): string {
  return (Object.entries(ctx.values) as Array<[SlotKey, unknown]>)
    .filter(([key, value]) => value !== undefined && value !== null && value !== '' && key !== 'location')
    .map(([key, value]) => `${key}=${show(value)}${ctx.fieldSources?.[key] && ctx.fieldSources[key] !== 'stated' ? ` (${ctx.fieldSources[key]})` : ''}`)
    .join(', ');
}

export function readBack(ctx: ConversationContext): SummaryLine[] {
  const lines = buildSummary(ctx.values);
  if (ctx.values.customerPhone) lines.push({ label: 'Callback number', value: ctx.values.customerPhone });
  return lines;
}

export function determineNextAction(ctx: ConversationContext, options: NextActionOptions = {}): NextActionPlan {
  const location = assessLocation(ctx, { knownAreas: options.knownAreas });

  const known = new Set<Topic>();
  for (const requirement of REQUIREMENTS) {
    if (requirement.id === 'customerPhone') continue;
    if (!requirement.isSatisfied(ctx.values)) continue;
    if (requirement.id === 'location' && !locationSettled(ctx, location)) continue;
    known.add(TOPIC_OF_REQUIREMENT[requirement.id]);
  }
  if (ctx.phoneConfirmed) known.add('callback_number');

  // What stood when the decision was made; the deciding reason goes in front.
  const facts: string[] = [];
  const saved = savedFacts(ctx);
  if (saved) facts.push(`saved: ${saved}`);
  if (ctx.values.location && location.status !== 'missing') {
    facts.push(
      `location "${ctx.values.location}": ${location.status}, ${location.reason}, detail asked ${ctx.locationDetailAttempts ?? 0}/${MAX_LOCATION_DETAIL_ATTEMPTS}`,
    );
  }

  const plan = (
    action: NextAction,
    topic: Topic | null,
    ask: string,
    why: string,
    extra: Partial<NextActionPlan> = {},
  ): NextActionPlan => {
    const later = topic ? ORDER.slice(ORDER.indexOf(topic) + 1).filter((t) => t !== 'details') : [];
    // At the read-back everything needed is known, so none of it is asked
    // again: once the backend takes a yes to the number itself, a reply
    // already asking "is this the best number?" is stopped.
    const doNotAsk =
      topic === 'details'
        ? [...new Set<Topic>([...known, 'destination'])]
        : [...new Set<Topic>([...later, ...known, 'destination'])].filter((t) => t !== topic);
    return { action, topic, ask, doNotAsk, location, because: [why, ...facts], settled: [...known], ...extra };
  };

  if (ctx.state === ConversationState.ENDED) {
    return {
      action: 'CLOSE',
      topic: null,
      ask: 'The call is finished. Thank the caller, say the towing team will contact them, and say goodbye. Do not say when.',
      doNotAsk: [...ORDER, 'destination'],
      location,
      because: ['the call has ended', ...facts],
      settled: [...ORDER],
    };
  }

  const turn = options.callerTurn;
  if (ctx.safety && ctx.safety.issuedAtTurn !== null && ctx.safety.issuedAtTurn !== turn) {
    facts.push(`safety advice for ${ctx.safety.hazard} given on turn ${ctx.safety.issuedAtTurn}`);
  }

  // Due for the whole caller turn on which it was issued, like every other
  // ask. It is issued when a plan is delivered, and the plan delivered before
  // the caller's words are saved is followed by another from the save: on
  // that second plan the intake moved on to the vehicle, and the advice was
  // never given, while the lead said it had been.
  const safetyDue = ctx.safety && (ctx.safety.issuedAtTurn === null || (turn !== undefined && ctx.safety.issuedAtTurn === turn));
  if (ctx.safety && safetyDue) {
    const number = options.emergencyNumber ?? 'emergency services';
    // A shoulder stop on a highway is the common case, and gets one short
    // sentence; a crash, an injury, fire or a live lane gets the full line.
    const ask =
      ctx.safety.hazard === HIGH_SPEED_ROAD_HAZARD
        ? `The caller is stopped on a high-speed road. Before anything else, in one short sentence: check that they are safely off the road and away from traffic, and say that if anyone is hurt they should call ${number} right now.`
        : `The caller may be in danger (${ctx.safety.hazard}). Before anything else, check that everyone is safe and off the road, and tell them that if anyone is hurt or in danger they should call ${number} right now.`;
    const due = ctx.safety.issuedAtTurn === null ? 'safety advice not given yet' : `safety advice due this turn (${turn})`;
    return plan('HANDLE_SAFETY', 'safety', ask, `${ctx.safety.hazard}: ${due}`);
  }
  // Checked with the caller once. After that the value stands, marked on the
  // lead as not clearly heard, unless the caller gives another.
  const unsure = (Object.entries(ctx.fieldSources ?? {}) as Array<[SlotKey, string]>)
    .filter(([key, source]) => source === 'unsure' && ctx.values[key] !== undefined)
    .map(([key]) => key)
    .filter((key) => askedBefore(ctx, `CLARIFY_FIELD:${key}=${String(ctx.values[key])}`, turn) < MAX_CLARIFICATIONS);
  if (unsure.length > 0) {
    return plan(
      'CLARIFY_FIELD',
      topicOfSlot(unsure[0]!),
      `You were not sure you heard this correctly: ${unsure.map((k) => `${SLOT_DEFS[k].label} "${show(ctx.values[k])}"`).join(', ')}. Ask the caller ONCE whether that is right. If they say yes, save it again without unsureFields and move on. If they say something else, save what they say.`,
      `not sure it heard ${unsure.map((k) => `${k} "${show(ctx.values[k])}"`).join(', ')} right; not checked with the caller yet`,
      { clarify: unsure },
    );
  }

  for (const requirement of [...REQUIREMENTS].filter((r) => r.required).sort((a, b) => a.order - b.order)) {
    if (requirement.id === 'customerPhone') continue;
    if (!requirement.isSatisfied(ctx.values)) {
      const times = askedBefore(ctx, ASK_ACTION[requirement.id], turn);
      // Asked on three turns and still not had: move on. It is not asked
      // about again, and the towing team gets it when they call.
      if (times >= MAX_ASKS) {
        known.add(TOPIC_OF_REQUIREMENT[requirement.id]);
        facts.push(`${requirement.id} asked ${MAX_ASKS} times without an answer: left for the towing team`);
        continue;
      }
      const offer = requirement.id === 'serviceType' ? offerOfHelp(ctx) : null;
      const ask = offer ?? `${times > 0 ? ASK_AGAIN : ''}Ask ${questionFor(requirement, ctx)}.`;
      const why = `${requirement.id} missing${times > 0 ? `, asked ${times}/${MAX_ASKS} already` : ''}${offer ? '; what help they want is unclear, so the likeliest are offered' : ''}`;
      return plan(ASK_ACTION[requirement.id], TOPIC_OF_REQUIREMENT[requirement.id], ask, why);
    }
    if (requirement.id === 'location' && !locationSettled(ctx, location)) {
      const where = location.road ? ` on ${location.road}` : '';
      return plan(
        'ASK_LOCATION_DETAIL',
        'location',
        `"${ctx.values.location}" is not precise enough for a driver to find the vehicle. Ask where exactly${where}: the nearest exit, mile marker, cross street or landmark.`,
        `location "${ctx.values.location}" not precise enough to drive to (${location.reason}); detail asked ${ctx.locationDetailAttempts ?? 0}/${MAX_LOCATION_DETAIL_ATTEMPTS}`,
      );
    }
  }

  const numberAction = ctx.phoneNeedsCollection || !ctx.values.customerPhone ? 'ASK_CALLBACK_NUMBER' : 'CONFIRM_CALLBACK_NUMBER';
  // Asked three times with no answer: the number they called from stands, unconfirmed, and the lead says so.
  const numberGivenUp = askedBefore(ctx, numberAction, turn) >= MAX_ASKS;
  if (numberGivenUp) {
    known.add('callback_number');
    if (!ctx.phoneConfirmed) facts.push(`callback number asked ${MAX_ASKS} times without a clear answer: the caller ID stands, unconfirmed`);
  }
  if (!ctx.phoneConfirmed && !numberGivenUp) {
    const source = ctx.phoneNeedsCollection ? 'the caller said not this number' : !ctx.values.customerPhone ? 'no number saved' : 'only the caller ID number, not confirmed';
    const timesAsked = askedBefore(ctx, numberAction, turn);
    const numberWhy = `everything before the number is settled; ${source}${timesAsked > 0 ? `, asked ${timesAsked}/${MAX_ASKS} already` : ''}`;
    if (numberAction === 'ASK_CALLBACK_NUMBER') {
      const ask =
        timesAsked > 0
          ? 'You have asked for the best number to reach them. If they gave one: call update_call_information with it in customerPhone. Only if they did not: ask once more, in different words.'
          : 'Ask for the best phone number to reach them.';
      return plan('ASK_CALLBACK_NUMBER', 'callback_number', ask, numberWhy);
    }
    // The number is not read out: a person says "the number you're calling
    // from", and the caller knows their own number. Asked again, the model is
    // told what the answer means: on a real call it heard "Yes." three times,
    // saved nothing, and asked again each time.
    const ask =
      timesAsked > 0
        ? 'You have asked whether the number they are calling from is the best one to reach them. If they said yes: call update_call_information with callerIdConfirmed true and nothing else. If they said no, or gave another number: call update_call_information with callerIdConfirmed false, and the number in customerPhone if they gave one. Only if they did not answer: ask once more, in different words. Do not read the number out.'
        : 'Ask whether the number they are calling from is the best one to reach them. Do not read the number out.';
    return plan('CONFIRM_CALLBACK_NUMBER', 'callback_number', ask, numberWhy);
  }

  const summary = readBack(ctx);
  const confirmationCurrent =
    ctx.pendingConfirmation?.kind === 'details' && ctx.pendingConfirmation.fieldVersion === (ctx.fieldVersion ?? 0);
  if (confirmationCurrent) {
    const pending = ctx.pendingConfirmation!;
    const thenConfirm =
      'Only when they clearly say yes, call complete_request with callerConfirmed true. If they correct something, save it first.';

    // The caller spoke over the read-back. What they said is answered first;
    // then they hear the details once, since they have not heard them all.
    const cut =
      pending.cutAfter !== undefined &&
      (pending.resumeTurn === undefined || options.callerTurn === undefined || pending.resumeTurn === options.callerTurn);
    if (cut) {
      const heard = pending.cutAfter ? `they heard only: "${pending.cutAfter}"` : 'they heard none of it';
      return plan(
        'AWAIT_CONFIRMATION',
        'details',
        `The caller spoke before you had finished reading the details back; ${heard}. Answer what the caller just said FIRST, in one short sentence. Then finish the read-back: do not start it again from the beginning. ${thenConfirm}`,
        `the caller spoke over the read-back; ${heard}, so it is finished this turn`,
        { summary },
      );
    }

    // Put on this very turn: the caller has not heard it yet. Told "they have
    // heard the details, do not read them again", the model would never read them.
    if (pending.cutAfter === undefined && options.callerTurn !== undefined && options.callerTurn === pending.callerTurn) {
      return plan(
        'CONFIRM_DETAILS',
        'details',
        'Everything needed is saved. Read the details back with the exact line given below, then stop and wait for the answer.',
        'the read-back was put on this turn and the caller has not answered it yet',
        { summary },
      );
    }

    // No summary: on a real call the details were in front of the model on
    // every turn of the wait, and it read them out three times while the
    // caller asked what it would cost.
    return plan(
      'AWAIT_CONFIRMATION',
      'details',
      'The caller has heard the details. Do NOT read them out again. If what the caller just said was a question or anything other than an answer, answer that first, in one short sentence, and do not go back over the details. ' +
        `Then ask once, in a few words, whether the details you read out were right. ${thenConfirm} Read the details again only if the caller asks to hear them: get them with get_call_state.`,
      `details read back on turn ${pending.callerTurn}; waiting for a clear yes, asked ${askedBefore(ctx, 'AWAIT_CONFIRMATION', turn)}/${MAX_CONFIRMATION_WAITS} times`,
    );
  }

  return plan(
    'CONFIRM_DETAILS',
    'details',
    'Everything needed is saved. Read the details back with the exact line given below, then stop and wait for the answer.',
    ctx.pendingConfirmation?.kind === 'details'
      ? 'the details changed since they were read back, so they are read back again'
      : 'everything required is saved and the callback number is settled',
    { summary },
  );
}
