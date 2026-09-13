/**
 * The contract between a speech-to-speech model and the workflow.
 *
 * The model never replies to the caller directly. After each caller turn it is
 * made to call `report_caller_turn`, and the arguments are the only way what it
 * understood reaches the state machine.
 *
 * Unlike structured outputs, realtime function calls are NOT schema-enforced.
 * Tested live, gpt-realtime-mini returned `"vehicle_movable": "no"` — a string —
 * for a boolean field. So arguments are normalised defensively here, and then
 * pass through the same slot validation as every other provider's output.
 */

import {
  EMPTY_EXTRACTION,
  EXTRACTION_JSON_SCHEMA,
  parseExtraction,
  type ExtractionResult,
} from '@towai/shared';

export const REPORT_TOOL_NAME = 'report_caller_turn';

/** The function tool, built from the same schema every other provider uses. */
export const REPORT_CALLER_TURN_TOOL = {
  type: 'function' as const,
  name: REPORT_TOOL_NAME,
  description:
    "Report what the caller said in their latest turn, and the details it contains. " +
    'Always call this after the caller speaks. Never reply to the caller in words.',
  parameters: {
    ...EXTRACTION_JSON_SCHEMA,
    required: ['heard', ...EXTRACTION_JSON_SCHEMA.required],
    properties: {
      heard: {
        type: 'string',
        description:
          "The caller's words in their latest turn, as close to verbatim as possible. Do not invent words the caller did not say.",
      },
      ...EXTRACTION_JSON_SCHEMA.properties,
    },
  },
};

const INTENTS = new Set<string>(EXTRACTION_JSON_SCHEMA.properties.intent.enum);
const FAQ_TOPICS = new Set<string>(
  (EXTRACTION_JSON_SCHEMA.properties.faqTopic.enum as readonly (string | null)[]).filter(
    (v): v is string => v !== null,
  ),
);
const SLOT_KEYS = Object.keys(EXTRACTION_JSON_SCHEMA.properties.slots.properties);

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', 'yes', 'y'].includes(v)) return true;
    if (['false', 'no', 'n'].includes(v)) return false;
  }
  return null;
}

export interface RealtimeCallerTurn {
  /** What the model says the caller said. Model-reported, not a transcript. */
  heard: string;
  extraction: ExtractionResult;
}

/**
 * Turns raw function-call arguments into a valid extraction.
 * Returns an `unclear` turn — never throws — for anything unusable, so a
 * misbehaving model costs one re-ask rather than the call.
 */
export function normaliseCallerTurn(rawArguments: string | null | undefined): RealtimeCallerTurn {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArguments ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    args = parsed as Record<string, unknown>;
  } catch {
    return { heard: '', extraction: EMPTY_EXTRACTION };
  }

  const rawSlots =
    args.slots && typeof args.slots === 'object' && !Array.isArray(args.slots)
      ? (args.slots as Record<string, unknown>)
      : // Tolerate a model that flattens the slots onto the top level.
        args;

  const slots: Record<string, string | boolean | null> = {};
  for (const key of SLOT_KEYS) {
    slots[key] = key === 'vehicleMovable' ? asBoolean(rawSlots[key]) : asText(rawSlots[key]);
  }

  const intent = typeof args.intent === 'string' && INTENTS.has(args.intent) ? args.intent : 'unclear';
  const faqTopic =
    typeof args.faqTopic === 'string' && FAQ_TOPICS.has(args.faqTopic) ? args.faqTopic : null;

  return {
    heard: asText(args.heard) ?? '',
    extraction: parseExtraction({
      intent,
      slots,
      faqQuestion: asText(args.faqQuestion),
      faqTopic,
      outOfScopeRequest: asText(args.outOfScopeRequest),
    }),
  };
}
