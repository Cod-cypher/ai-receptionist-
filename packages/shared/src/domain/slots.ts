/**
 * The towing intake slot model.
 *
 * This file is the single source of truth for *what* the receptionist collects
 * and *in what order*. The state machine reads it; the model never sees it as
 * anything but a list of fields it may extract. Changing the intake flow means
 * editing this file, not editing a prompt.
 */

import { cleanText, titleCase } from '../util/text';
import { normalisePhone } from '../util/phone';
import { ConversationState } from './states';

/** Every field the receptionist may fill. */
export type SlotKey =
  | 'serviceType'
  | 'location'
  | 'destination'
  | 'vehicleMake'
  | 'vehicleModel'
  | 'vehicleType'
  | 'vehicleMovable'
  | 'vehicleCondition'
  | 'customerName'
  | 'customerPhone'
  | 'additionalNotes';

export interface SlotValues {
  serviceType?: string;
  location?: string;
  destination?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleType?: string;
  vehicleMovable?: boolean;
  vehicleCondition?: string;
  customerName?: string;
  customerPhone?: string;
  additionalNotes?: string;
}

export type SlotValue = string | boolean;

export type ValidationResult =
  | { ok: true; value: SlotValue }
  | { ok: false; reason: string };

export interface SlotDef {
  key: SlotKey;
  /** Human label used in the confirmation summary and the dashboard. */
  label: string;
  /**
   * Validates and normalises a raw value produced by the model.
   * Returning `{ ok: false }` means the value is discarded — the slot stays
   * unfilled and the customer will be asked again. The model is never trusted
   * to decide whether its own extraction is legal.
   */
  validate(raw: unknown, ctx?: SlotValidationContext): ValidationResult;
}

export interface SlotValidationContext {
  /** Used to normalise nationally-formatted phone numbers. */
  defaultRegionPrefix?: string;
}

const MAX = {
  serviceType: 120,
  location: 250,
  destination: 250,
  vehicleMake: 60,
  vehicleModel: 60,
  vehicleType: 40,
  vehicleCondition: 300,
  customerName: 100,
  additionalNotes: 1000,
} as const;

/** Free-text slot validator with cleaning, a length cap and optional casing. */
function textSlot(
  key: SlotKey,
  label: string,
  maxLength: number,
  transform?: (v: string) => string,
): SlotDef {
  return {
    key,
    label,
    validate(raw) {
      const cleaned = cleanText(raw, maxLength);
      if (cleaned === null) return { ok: false, reason: 'empty or placeholder' };
      return { ok: true, value: transform ? transform(cleaned) : cleaned };
    },
  };
}

export const SLOT_DEFS: Readonly<Record<SlotKey, SlotDef>> = {
  serviceType: textSlot('serviceType', 'Service', MAX.serviceType),
  location: textSlot('location', 'Location', MAX.location),
  destination: textSlot('destination', 'Destination', MAX.destination),
  vehicleMake: textSlot('vehicleMake', 'Vehicle make', MAX.vehicleMake, titleCase),
  vehicleModel: textSlot('vehicleModel', 'Vehicle model', MAX.vehicleModel, titleCase),
  vehicleType: textSlot('vehicleType', 'Vehicle type', MAX.vehicleType, titleCase),
  vehicleCondition: textSlot('vehicleCondition', 'Vehicle condition', MAX.vehicleCondition),
  additionalNotes: textSlot('additionalNotes', 'Additional notes', MAX.additionalNotes),

  customerName: {
    key: 'customerName',
    label: 'Customer name',
    validate(raw) {
      const cleaned = cleanText(raw, MAX.customerName);
      if (cleaned === null) return { ok: false, reason: 'empty or placeholder' };
      // A "name" longer than a handful of words is almost always the model
      // handing back the whole utterance. Better to re-ask than to WhatsApp the
      // operator a sentence in the Customer field.
      if (cleaned.split(' ').length > 5) {
        return { ok: false, reason: 'looks like a sentence, not a name' };
      }
      return { ok: true, value: titleCase(cleaned) };
    },
  },

  customerPhone: {
    key: 'customerPhone',
    label: 'Phone',
    validate(raw, ctx) {
      const normalised = normalisePhone(raw, ctx?.defaultRegionPrefix);
      if (normalised === null) return { ok: false, reason: 'not a valid phone number' };
      return { ok: true, value: normalised };
    },
  },

  vehicleMovable: {
    key: 'vehicleMovable',
    label: 'Vehicle movable',
    validate(raw) {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      // Tolerate the string forms a JSON-mode model occasionally emits, but
      // nothing looser than this — an ambiguous answer must stay unfilled.
      if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase();
        if (v === 'true' || v === 'yes') return { ok: true, value: true };
        if (v === 'false' || v === 'no') return { ok: true, value: false };
      }
      return { ok: false, reason: 'not a boolean' };
    },
  },
};

/* -------------------------------------------------------------------------- */
/*  Requirements                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A requirement is a question the receptionist may need to ask. It maps to one
 * or more slots, because some questions fill several fields at once ("a Toyota
 * Corolla" fills make and model) and some fields are interchangeable ("an SUV"
 * satisfies the vehicle requirement without a make or model).
 */
export type RequirementId =
  | 'serviceType'
  | 'location'
  | 'vehicle'
  | 'vehicleCondition'
  | 'vehicleMovable'
  | 'customerName'
  | 'customerPhone';

export interface Requirement {
  id: RequirementId;
  /** Ask order. Lower is asked first. */
  order: number;
  required: boolean;
  /** The state the conversation occupies while this requirement is pending. */
  state: ConversationState;
  /** Slots this requirement can be satisfied by. */
  slots: readonly SlotKey[];
  /**
   * The question's intent, in plain words. The model paraphrases this; it is
   * never spoken verbatim, and it is never chosen by the model.
   */
  canonicalQuestion: string;
  /** Fallback wording used when generation fails or trips a guardrail. */
  fallbackPhrasing: string;
  isSatisfied(values: SlotValues): boolean;
  /**
   * When true the value is pre-filled from call metadata and the customer is
   * asked to confirm rather than provide it.
   */
  confirmOnly?: boolean;
}

export const REQUIREMENTS: readonly Requirement[] = [
  {
    id: 'serviceType',
    order: 10,
    required: true,
    state: ConversationState.IDENTIFY_INTENT,
    slots: ['serviceType'],
    canonicalQuestion: 'what has happened / what kind of help they need',
    fallbackPhrasing: 'What kind of help do you need today?',
    isSatisfied: (v) => Boolean(v.serviceType),
  },
  {
    id: 'location',
    order: 20,
    required: true,
    state: ConversationState.COLLECT_LOCATION,
    slots: ['location'],
    canonicalQuestion: 'where the vehicle currently is',
    fallbackPhrasing: "What's your current location?",
    isSatisfied: (v) => Boolean(v.location),
  },
  {
    id: 'vehicle',
    order: 30,
    required: true,
    state: ConversationState.COLLECT_VEHICLE,
    slots: ['vehicleMake', 'vehicleModel', 'vehicleType'],
    canonicalQuestion: 'what vehicle it is (make and model, or at least the type)',
    fallbackPhrasing: 'What type of vehicle is it?',
    // Make+model is ideal, but a bare type ("a motorcycle", "a pickup") is
    // enough for a tow operator to send the right truck, which is the point.
    isSatisfied: (v) => Boolean((v.vehicleMake && v.vehicleModel) || v.vehicleType),
  },
  {
    // Asked, not only saved when offered. On two real calls (ba50602f and
    // fe228d39, 13 November) the caller said "You also didn't ask me what was
    // wrong with the car": the driver needs it to bring the right truck and
    // tools. Before movability, so that "it won't start" settles that too.
    id: 'vehicleCondition',
    order: 35,
    required: true,
    state: ConversationState.COLLECT_VEHICLE_CONDITION,
    slots: ['vehicleCondition'],
    canonicalQuestion: 'what is wrong with the vehicle',
    fallbackPhrasing: "What's wrong with the vehicle?",
    isSatisfied: (v) => Boolean(v.vehicleCondition?.trim()),
  },
  {
    id: 'vehicleMovable',
    order: 40,
    required: true,
    state: ConversationState.COLLECT_VEHICLE_CONDITION,
    slots: ['vehicleMovable'],
    canonicalQuestion: 'whether the vehicle can still move or needs to be towed',
    fallbackPhrasing: 'Is the vehicle able to move, or does it need to be towed?',
    isSatisfied: (v) => typeof v.vehicleMovable === 'boolean',
  },
  {
    id: 'customerName',
    order: 50,
    required: true,
    state: ConversationState.COLLECT_NAME,
    slots: ['customerName'],
    canonicalQuestion: 'their name',
    fallbackPhrasing: 'Can I get your name?',
    isSatisfied: (v) => Boolean(v.customerName),
  },
  {
    id: 'customerPhone',
    order: 60,
    required: true,
    state: ConversationState.CONFIRM_PHONE,
    slots: ['customerPhone'],
    canonicalQuestion: 'whether the number they are calling from is the best contact number',
    fallbackPhrasing: 'And is this the best number to reach you on?',
    isSatisfied: (v) => Boolean(v.customerPhone),
    confirmOnly: true,
  },
];

/** Optional slots. Collected opportunistically, never asked for on their own. */
export const OPTIONAL_SLOTS: readonly SlotKey[] = [
  'destination',
  'additionalNotes',
];

export const REQUIREMENTS_BY_ID: Readonly<Record<RequirementId, Requirement>> =
  Object.fromEntries(REQUIREMENTS.map((r) => [r.id, r])) as Record<
    RequirementId,
    Requirement
  >;

/**
 * The next requirement to ask about, or `null` when every required field is
 * filled. This single function is what makes out-of-order and multi-slot answers
 * work: it re-derives the next question from the data on every turn instead of
 * advancing a cursor.
 */
export function nextUnsatisfiedRequirement(values: SlotValues): Requirement | null {
  const pending = REQUIREMENTS.filter((r) => r.required && !r.isSatisfied(values)).sort(
    (a, b) => a.order - b.order,
  );
  return pending[0] ?? null;
}

/** True when every required slot is filled and the lead can be created. */
export function isIntakeComplete(values: SlotValues): boolean {
  return nextUnsatisfiedRequirement(values) === null;
}

/** Requirements still outstanding, in ask order. Used for logging and tests. */
export function outstandingRequirements(values: SlotValues): RequirementId[] {
  return REQUIREMENTS.filter((r) => r.required && !r.isSatisfied(values))
    .sort((a, b) => a.order - b.order)
    .map((r) => r.id);
}

/** What the towing team still has to ask the caller, in plain words. */
export const STILL_NEEDED: Readonly<Record<RequirementId, string>> = {
  serviceType: 'what help they need',
  location: 'the location',
  vehicle: 'the vehicle',
  vehicleCondition: 'what is wrong with the vehicle',
  vehicleMovable: 'whether it can move',
  customerName: 'their name',
  customerPhone: 'a phone number',
};

/**
 * Validates a batch of model-extracted values against the slot definitions.
 * Returns only what survived, plus a rejection list for the call event log.
 */
export function validateSlots(
  raw: Partial<Record<SlotKey, unknown>>,
  ctx?: SlotValidationContext,
): {
  accepted: SlotValues;
  rejected: Array<{ key: SlotKey; reason: string }>;
} {
  const accepted: SlotValues = {};
  const rejected: Array<{ key: SlotKey; reason: string }> = [];

  for (const [key, value] of Object.entries(raw) as Array<[SlotKey, unknown]>) {
    if (value === undefined || value === null) continue;

    const def = SLOT_DEFS[key];
    if (!def) {
      rejected.push({ key, reason: 'unknown slot' });
      continue;
    }

    const result = def.validate(value, ctx);
    if (result.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (accepted as any)[key] = result.value;
    } else {
      rejected.push({ key, reason: result.reason });
    }
  }

  return { accepted, rejected };
}

/**
 * Vehicle types that carry no dispatch information once the make and model are
 * known. "Toyota Corolla (Car)" tells the operator nothing they cannot see;
 * "Toyota Hilux (Pickup)" changes which truck they send.
 */
const GENERIC_VEHICLE_TYPES = new Set([
  'car',
  'vehicle',
  'sedan',
  'hatchback',
  'saloon',
  'auto',
  'automobile',
]);

/** A one-line description of the vehicle for summaries and notifications. */
export function describeVehicle(values: SlotValues): string | null {
  const parts = [values.vehicleMake, values.vehicleModel].filter(Boolean);

  if (parts.length > 0) {
    const base = parts.join(' ');
    const type = values.vehicleType?.trim();
    if (!type) return base;

    const lower = type.toLowerCase();
    if (GENERIC_VEHICLE_TYPES.has(lower) || base.toLowerCase().includes(lower)) {
      return base;
    }
    return `${base} (${type})`;
  }

  return values.vehicleType ?? null;
}
