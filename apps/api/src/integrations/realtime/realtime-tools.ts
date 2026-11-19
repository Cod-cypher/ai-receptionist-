/**
 * The backend tools the realtime receptionist may call.
 *
 * The model runs the conversation; these are its only way to change anything.
 * No tool takes a business, tenant or call id: the executor is bound to the
 * call the session belongs to, so the model cannot address another call or
 * another company's data however it is prompted.
 *
 * Realtime function arguments are not schema-enforced (live testing returned
 * `"no"` for a boolean), so arguments are coerced defensively here and then
 * validated by the backend like every other extraction.
 */

import {
  EXTRACTION_JSON_SCHEMA,
  type FaqTopic,
  type SlotKey,
} from '@towai/shared';

import type { IntakeOperation } from '../../conversation/intake';
import type {
  CallSessionService,
  IntakeOperationResult,
} from '../../call-session/call-session.service';

const SLOT_PROPERTIES = EXTRACTION_JSON_SCHEMA.properties.slots.properties;
const SLOT_KEYS = Object.keys(SLOT_PROPERTIES) as SlotKey[];
const FAQ_TOPICS = (EXTRACTION_JSON_SCHEMA.properties.faqTopic.enum as readonly (string | null)[]).filter(
  (v): v is string => v !== null,
);

export const TOOL = {
  UPDATE: 'update_call_information',
  STATE: 'get_call_state',
  BUSINESS: 'get_business_information',
  COMPLETE: 'complete_request',
  CALLBACK: 'request_callback',
  END: 'end_call',
} as const;

export const REALTIME_TOOLS = [
  {
    type: 'function' as const,
    name: TOOL.UPDATE,
    description:
      'Save details the caller has given, as soon as you hear them. Include every field they mentioned, and only those. ' +
      'Several fields at once is normal. A later value replaces an earlier one. Omitted fields are left as they are. ' +
      'Never call it when the caller gave no new detail (small talk, a question, a complaint), and never to send again what CALL STATE already has, ' +
      'except a detail you were unsure of that the caller has now confirmed: send that again without unsureFields.',
    parameters: {
      type: 'object',
      properties: {
        ...SLOT_PROPERTIES,
        // "I need a tow" is the service, said in passing before the details that
        // follow it; live runs saved the name, vehicle and road and left this out.
        serviceType: {
          ...SLOT_PROPERTIES.serviceType,
          description:
            "The help the caller needs, in their words: \"tow\", \"jump start\", \"lockout\", \"flat tire\", \"winch out\", \"accident recovery\". " +
            '"I need a tow", "can you tow me", or a breakdown with no other request all mean "tow". Always include it when the caller says why they are calling.',
        },
        // The shared description lists bare categories ("truck"), which led the
        // model to save "semi truck" as "truck" every time. The towing team
        // needs the qualifier: a semi takes a heavy-duty truck.
        vehicleType: {
          ...SLOT_PROPERTIES.vehicleType,
          description:
            "The kind of vehicle in the caller's own words, keeping every qualifier: \"semi truck\", \"box truck\", \"pickup\", \"SUV\", \"motorcycle\". Never shorten it.",
        },
        location: {
          ...SLOT_PROPERTIES.location,
          description:
            "Where the vehicle is, in the caller's words, including any exit, mile marker, cross street or landmark they gave. When they add detail later, send the full combined location.",
        },
        // "A Hyundai Sonata 2016": on a real call the year was dropped, and the
        // towing team would have wanted it.
        vehicleModel: {
          ...SLOT_PROPERTIES.vehicleModel,
          description:
            'The model the caller said, with the year if they gave one: "Sonata 2016", "Civic", "F-150". Never a year on its own: the year is not the model.',
        },
        vehicleCondition: {
          ...SLOT_PROPERTIES.vehicleCondition,
          description:
            "What is wrong with the vehicle, in the caller's exact words and US spelling: \"blowout\", \"won't start\", \"engine died\", \"flat tire\". Never paraphrase: a blowout is not a flat tire.",
        },
        // On a real call the model rewrote this field on every turn with its own
        // commentary ("Caller feels they are being cut off"): seven tool calls
        // that saved nothing, each costing the caller a slower reply.
        additionalNotes: {
          ...SLOT_PROPERTIES.additionalNotes,
          description:
            'Only a message the caller asked you to pass on to the driver or the towing team: "the gate code is 4412", "call when you arrive", "the keys are in the glovebox". ' +
            'Never your own observations about the caller or the call, never a summary, never how they feel. Most calls have none: leave it out.',
        },
        // On real calls the model sent the caller ID, already saved, on turns
        // of small talk ("Now let's talk about you."): a tool call that saved
        // nothing, and a slower reply, each time.
        customerPhone: {
          ...SLOT_PROPERTIES.customerPhone,
          description: 'A phone number the caller has just said aloud. Never the number they are calling from, and never one already in CALL STATE.',
        },
        callerIdConfirmed: {
          type: ['boolean', 'null'],
          description:
            'True only when the caller has just answered that the number they are calling from is the best one. False when they want a different number (put it in customerPhone once given).',
        },
        inferredFields: {
          type: 'array',
          items: { type: 'string', enum: SLOT_KEYS },
          description: 'Fields you filled in yourself rather than heard, e.g. vehicleMake "Ford" from "Mustang".',
        },
        unsureFields: {
          type: 'array',
          items: { type: 'string', enum: SLOT_KEYS },
          description: 'Fields you are not sure you heard correctly. The backend will have you check them.',
        },
      },
    },
  },
  {
    type: 'function' as const,
    name: TOOL.STATE,
    description: 'Get what has been saved for this call so far and which required details are still missing.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: TOOL.BUSINESS,
    description:
      'Look up information about the business before answering any question about it: hours, service areas, services, prices, contact details, arrival times, or anything else. Never answer such a question without calling this.',
    parameters: {
      type: 'object',
      required: ['question'],
      properties: {
        topic: { type: 'string', enum: FAQ_TOPICS, description: 'The subject of the question.' },
        question: { type: 'string', description: "The caller's question, restated plainly." },
      },
    },
  },
  {
    type: 'function' as const,
    name: TOOL.COMPLETE,
    description:
      'Submit the towing request once every required detail is saved. The first call returns the details to read back; call again with callerConfirmed true only after the caller has said the read-back is correct.',
    parameters: {
      type: 'object',
      required: ['callerConfirmed'],
      properties: {
        callerConfirmed: {
          type: 'boolean',
          description: 'True only if the caller has just confirmed the details you read back to them.',
        },
      },
    },
  },
  {
    type: 'function' as const,
    name: TOOL.CALLBACK,
    description:
      'Arrange for someone from the towing team to call the caller back: when they ask for a person, or want something you cannot do on this call.',
    parameters: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', description: 'What the caller needs, in a sentence.' } },
    },
  },
  {
    type: 'function' as const,
    name: TOOL.END,
    description:
      'The caller clearly wants to finish the call. Whatever was collected is kept and passed to the towing team.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why the call is ending, briefly.' } },
    },
  },
];

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', 'yes', 'y'].includes(v)) return true;
    if (['false', 'no', 'n'].includes(v)) return false;
  }
  return null;
}

/** Tool arguments to a backend operation. Null when the call cannot be understood. */
export function toIntakeOperation(name: string, rawArguments: string | null | undefined): IntakeOperation | null {
  let args: Record<string, unknown> = {};
  if (rawArguments && rawArguments.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawArguments);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      args = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  switch (name) {
    case TOOL.UPDATE: {
      const source =
        args.slots && typeof args.slots === 'object' && !Array.isArray(args.slots)
          ? { ...args, ...(args.slots as Record<string, unknown>) }
          : args;
      const slots: Partial<Record<SlotKey, unknown>> = {};
      for (const key of SLOT_KEYS) {
        const value = key === 'vehicleMovable' ? asBoolean(source[key]) : asText(source[key]);
        if (value !== null) slots[key] = value;
      }
      const fieldList = (value: unknown) =>
        Array.isArray(value) ? value.filter((k): k is SlotKey => typeof k === 'string' && SLOT_KEYS.includes(k as SlotKey)) : [];
      const inferred = fieldList(args.inferredFields);
      const unsure = fieldList(args.unsureFields);
      return {
        kind: 'update',
        slots,
        callerIdConfirmed: asBoolean(args.callerIdConfirmed),
        ...(inferred.length > 0 ? { inferred } : {}),
        ...(unsure.length > 0 ? { unsure } : {}),
      };
    }

    case TOOL.STATE:
      return { kind: 'state' };

    case TOOL.BUSINESS: {
      const question = asText(args.question);
      if (!question) return null;
      const topic = typeof args.topic === 'string' && FAQ_TOPICS.includes(args.topic) ? (args.topic as FaqTopic) : null;
      return { kind: 'business_info', topic, question };
    }

    case TOOL.COMPLETE:
      return { kind: 'complete', callerConfirmed: asBoolean(args.callerConfirmed) === true };

    case TOOL.CALLBACK:
      return { kind: 'callback', reason: asText(args.reason) ?? 'Caller asked to be called back.' };

    case TOOL.END:
      return { kind: 'end', reason: asText(args.reason) ?? undefined };

    default:
      return null;
  }
}

export type ToolExecutor = (name: string, rawArguments: string | null | undefined) => Promise<IntakeOperationResult>;

/** Binds the tools to one call. The ids come from the session, never the model. */
export function createToolExecutor(deps: {
  callSession: Pick<CallSessionService, 'applyIntakeOperation'>;
  businessId: string;
  callId: string;
  /** Caller turns so far, counted from the audio. Confirmations are checked against it. */
  callerTurn?: () => number;
  /** What the caller said on this turn, when known: a save can arrive before the judge has read the line. */
  callerSaid?: () => string | undefined;
}): ToolExecutor {
  return async (name, rawArguments) => {
    const op = toIntakeOperation(name, rawArguments);
    if (!op) {
      return {
        output: { error: `Could not use ${name} with those arguments. Check the tool description and try again.` },
        ended: false,
        outcome: null,
        plan: null,
      };
    }
    const callerSaid = op.kind === 'update' ? deps.callerSaid?.() : undefined;
    return deps.callSession.applyIntakeOperation(deps.businessId, deps.callId, op, {
      callerTurn: deps.callerTurn?.(),
      ...(callerSaid ? { callerSaid } : {}),
    });
  };
}
