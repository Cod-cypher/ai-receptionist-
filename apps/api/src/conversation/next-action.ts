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
  type RequirementId,
  type SlotKey,
} from '@towai/shared';

import { assessLocation, type LocationAssessment } from './location';
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
}

export interface NextActionOptions {
  emergencyNumber?: string;
  knownAreas?: readonly string[];
}

/** Detail requests before a vague location is accepted as the best available. */
export const MAX_LOCATION_DETAIL_ATTEMPTS = 2;

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

/** A location the caller could not narrow down further counts as settled. */
export function locationSettled(ctx: ConversationContext, location: LocationAssessment): boolean {
  if (location.status === 'complete') return true;
  return location.status === 'partial' && (ctx.locationDetailAttempts ?? 0) >= MAX_LOCATION_DETAIL_ATTEMPTS;
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

  const plan = (action: NextAction, topic: Topic | null, ask: string, extra: Partial<NextActionPlan> = {}): NextActionPlan => {
    const later = topic ? ORDER.slice(ORDER.indexOf(topic) + 1).filter((t) => t !== 'details') : [];
    const doNotAsk =
      topic === 'details'
        ? ['destination' as Topic]
        : [...new Set<Topic>([...later, ...known, 'destination'])].filter((t) => t !== topic);
    return { action, topic, ask, doNotAsk, location, ...extra };
  };

  if (ctx.state === ConversationState.ENDED) {
    return {
      action: 'CLOSE',
      topic: null,
      ask: 'The call is finished. Thank the caller, say the towing team will contact them, and say goodbye. Do not say when.',
      doNotAsk: [...ORDER, 'destination'],
      location,
    };
  }

  if (ctx.safety && ctx.safety.issuedAtTurn === null) {
    return plan(
      'HANDLE_SAFETY',
      'safety',
      `The caller may be in danger (${ctx.safety.hazard}). Before anything else, check that everyone is safe and off the road, and tell them that if anyone is hurt or in danger they should call ${options.emergencyNumber ?? 'emergency services'} right now.`,
    );
  }

  const unsure = (Object.entries(ctx.fieldSources ?? {}) as Array<[SlotKey, string]>)
    .filter(([key, source]) => source === 'unsure' && ctx.values[key] !== undefined)
    .map(([key]) => key);
  if (unsure.length > 0) {
    return plan(
      'CLARIFY_FIELD',
      topicOfSlot(unsure[0]!),
      `You were not sure you heard this correctly: ${unsure.map((k) => `${SLOT_DEFS[k].label} "${show(ctx.values[k])}"`).join(', ')}. Ask the caller to confirm it or say it again.`,
      { clarify: unsure },
    );
  }

  for (const requirement of [...REQUIREMENTS].filter((r) => r.required).sort((a, b) => a.order - b.order)) {
    if (requirement.id === 'customerPhone') continue;
    if (!requirement.isSatisfied(ctx.values)) {
      return plan(ASK_ACTION[requirement.id], TOPIC_OF_REQUIREMENT[requirement.id], `Ask ${requirement.canonicalQuestion}.`);
    }
    if (requirement.id === 'location' && !locationSettled(ctx, location)) {
      const where = location.road ? ` on ${location.road}` : '';
      return plan(
        'ASK_LOCATION_DETAIL',
        'location',
        `"${ctx.values.location}" is not precise enough for a driver to find the vehicle. Ask where exactly${where}: the nearest exit, mile marker, cross street or landmark.`,
      );
    }
  }

  if (!ctx.phoneConfirmed) {
    return ctx.phoneNeedsCollection || !ctx.values.customerPhone
      ? plan('ASK_CALLBACK_NUMBER', 'callback_number', 'Ask for the best phone number to reach them.')
      : plan(
          'CONFIRM_CALLBACK_NUMBER',
          'callback_number',
          `Ask whether ${ctx.values.customerPhone}, the number they are calling from, is the best number to reach them.`,
        );
  }

  const summary = readBack(ctx);
  const confirmationCurrent =
    ctx.pendingConfirmation?.kind === 'details' && ctx.pendingConfirmation.fieldVersion === (ctx.fieldVersion ?? 0);
  if (confirmationCurrent) {
    return plan(
      'AWAIT_CONFIRMATION',
      'details',
      'You have read the details back. Wait for the caller to say whether they are right. Only when they clearly confirm, call complete_request with callerConfirmed true. If they correct something, save it first.',
      { summary },
    );
  }

  return plan(
    'CONFIRM_DETAILS',
    'details',
    'Everything needed is saved. Read these details back in one natural sentence, ask if they are correct, then stop and wait for the answer.',
    { summary },
  );
}
