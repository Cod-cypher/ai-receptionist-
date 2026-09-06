/**
 * The contract between the receptionist and whichever language model is behind
 * the `AiProvider` interface.
 *
 * Two properties matter and are enforced by the shape itself:
 *
 * 1. The model returns *observations only* — what it heard in this utterance.
 *    There is no field through which it can propose the next question, choose a
 *    state, or trigger an action. Those are the state machine's job.
 * 2. Every field is required-and-nullable rather than optional. OpenAI's strict
 *    JSON-schema mode rejects optional properties outright, and Anthropic's
 *    structured outputs are more reliable with an explicit null than with an
 *    absent key. One shape serves both adapters.
 */

import { z } from 'zod';

/**
 * What the customer was doing in their last utterance.
 *
 * This classifies the *speech act*, not the workflow. The state machine decides
 * what a given act means from the state it is in — "yes" means something
 * different in CONFIRM_PHONE than in CONFIRM_INFORMATION.
 */
export const CustomerIntentSchema = z.enum([
  /** Giving intake information (possibly several fields at once). */
  'provide_info',
  /** Asking something about the business: hours, coverage, services, price. */
  'faq',
  /** Affirmative: "yes", "that's right", "correct". */
  'confirm',
  /** Negative: "no", "that's wrong". */
  'deny',
  /** Asking for something the receptionist must not handle. */
  'out_of_scope',
  /** Speech was received but carried no usable meaning. */
  'unclear',
  /** Customer is trying to end the call. */
  'end_call',
]);

export type CustomerIntent = z.infer<typeof CustomerIntentSchema>;

/**
 * The subject of an FAQ question, as a closed set.
 *
 * Classifying is safe to delegate to the model; *answering* is not. The engine
 * maps this topic to a fact drawn from the business's stored configuration, and
 * raises a callback when the topic has nothing configured behind it. The model
 * therefore never decides whether it knows something.
 */
export const FaqTopicSchema = z.enum([
  'hours',
  'service_area',
  'services_offered',
  'pricing',
  'contact_details',
  'eta',
  'other',
]);

export type FaqTopic = z.infer<typeof FaqTopicSchema>;

/**
 * Slot observations. Null means "not mentioned in this utterance" — it never
 * means "the customer does not have one", and it never clears a stored value.
 */
export const ExtractedSlotsSchema = z.object({
  serviceType: z
    .string()
    .nullable()
    .describe(
      'The service needed, in the caller\'s own terms: "vehicle towing", "jump start", "flat tyre", "lockout", "fuel delivery". Null if not stated.',
    ),
  location: z
    .string()
    .nullable()
    .describe(
      'Where the vehicle is now. A landmark, road, intersection or address exactly as the caller described it. Do not invent detail they did not give.',
    ),
  destination: z
    .string()
    .nullable()
    .describe('Where the vehicle needs to be taken, if the caller said. Usually null.'),
  vehicleMake: z.string().nullable().describe('Manufacturer, e.g. Toyota, Honda, Suzuki.'),
  vehicleModel: z.string().nullable().describe('Model, e.g. Corolla, Civic, Mehran.'),
  vehicleType: z
    .string()
    .nullable()
    .describe('Category: car, SUV, van, pickup, truck, motorcycle, bus. Null if unclear.'),
  vehicleMovable: z
    .boolean()
    .nullable()
    .describe(
      'True if the vehicle can still be driven or rolled, false if it cannot move at all. Null unless the caller made this clear.',
    ),
  vehicleCondition: z
    .string()
    .nullable()
    .describe(
      'Any detail about what is wrong or the vehicle\'s state: "won\'t start", "flat tyre", "accident damage", "wheels locked".',
    ),
  customerName: z
    .string()
    .nullable()
    .describe('The caller\'s name only, with no surrounding words.'),
  customerPhone: z
    .string()
    .nullable()
    .describe(
      'A phone number only if the caller explicitly gave a different one to call them back on. Null when they simply confirmed the number they are calling from.',
    ),
  additionalNotes: z
    .string()
    .nullable()
    .describe(
      'Anything else the tow operator genuinely needs to know: passengers waiting, a child in the car, an unsafe roadside position, cargo. Null if nothing.',
    ),
});

export type ExtractedSlots = z.infer<typeof ExtractedSlotsSchema>;

export const ExtractionResultSchema = z.object({
  intent: CustomerIntentSchema,
  slots: ExtractedSlotsSchema,
  faqQuestion: z
    .string()
    .nullable()
    .describe(
      'When intent is "faq", the question restated plainly. Null otherwise.',
    ),
  faqTopic: FaqTopicSchema.nullable().describe(
    'When intent is "faq", which subject the question is about. Null otherwise.',
  ),
  outOfScopeRequest: z
    .string()
    .nullable()
    .describe(
      'When intent is "out_of_scope", a short description of what they asked for, to put on the callback request. Null otherwise.',
    ),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/** A safe, information-free result used when a provider call fails entirely. */
export const EMPTY_EXTRACTION: ExtractionResult = {
  intent: 'unclear',
  slots: {
    serviceType: null,
    location: null,
    destination: null,
    vehicleMake: null,
    vehicleModel: null,
    vehicleType: null,
    vehicleMovable: null,
    vehicleCondition: null,
    customerName: null,
    customerPhone: null,
    additionalNotes: null,
  },
  faqQuestion: null,
  faqTopic: null,
  outOfScopeRequest: null,
};

/**
 * Strips nulls so the result can be handed to `validateSlots`, which treats a
 * missing key as "not observed".
 */
export function compactSlots(slots: ExtractedSlots): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slots)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Wire schema                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The extraction schema as raw JSON Schema.
 *
 * Written by hand rather than generated from the Zod schema above, because the
 * two vendor SDKs disagree about which major version of Zod their helpers take,
 * and pinning the whole monorepo to one vendor's preference is a worse trade
 * than maintaining this. Both adapters send *this* object, so neither vendor can
 * drift from the other in what it is asked to extract; the Zod schema then
 * validates whatever comes back, so a provider that ignores the schema is
 * caught rather than trusted.
 *
 * `additionalProperties: false` plus a fully-populated `required` array is what
 * OpenAI's strict mode demands, and it costs Anthropic nothing.
 *
 * `extraction.test.ts` asserts the two definitions still describe the same shape.
 */
const nullableString = (description: string) => ({
  type: ['string', 'null'] as const,
  description,
});

export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'slots', 'faqQuestion', 'faqTopic', 'outOfScopeRequest'],
  properties: {
    intent: {
      type: 'string',
      enum: [
        'provide_info',
        'faq',
        'confirm',
        'deny',
        'out_of_scope',
        'unclear',
        'end_call',
      ],
      description: 'What the caller was doing in their last utterance.',
    },
    slots: {
      type: 'object',
      additionalProperties: false,
      required: [
        'serviceType',
        'location',
        'destination',
        'vehicleMake',
        'vehicleModel',
        'vehicleType',
        'vehicleMovable',
        'vehicleCondition',
        'customerName',
        'customerPhone',
        'additionalNotes',
      ],
      properties: {
        serviceType: nullableString(
          'The service needed, in the caller\u2019s own terms: "vehicle towing", "jump start", "flat tyre", "lockout", "fuel delivery". Null if not stated.',
        ),
        location: nullableString(
          'Where the vehicle is now. A landmark, road, intersection or address exactly as the caller described it. Do not invent detail they did not give.',
        ),
        destination: nullableString(
          'Where the vehicle needs to be taken, if the caller said. Usually null.',
        ),
        vehicleMake: nullableString('Manufacturer, e.g. Toyota, Honda, Suzuki.'),
        vehicleModel: nullableString('Model, e.g. Corolla, Civic, Mehran.'),
        vehicleType: nullableString(
          'Category: car, SUV, van, pickup, truck, motorcycle, bus. Null if unclear.',
        ),
        vehicleMovable: {
          type: ['boolean', 'null'],
          description:
            'True if the vehicle can still be driven or rolled, false if it cannot move at all. Null unless the caller made this clear.',
        },
        vehicleCondition: nullableString(
          'Any detail about what is wrong or the vehicle\u2019s state.',
        ),
        customerName: nullableString(
          'The caller\u2019s name only, with no surrounding words.',
        ),
        customerPhone: nullableString(
          'A phone number only if the caller explicitly gave a different one to call them back on. Null when they simply confirmed the number they are calling from.',
        ),
        additionalNotes: nullableString(
          'Anything else the tow operator genuinely needs to know. Null if nothing.',
        ),
      },
    },
    faqQuestion: nullableString(
      'When intent is "faq", the question restated plainly. Null otherwise.',
    ),
    faqTopic: {
      type: ['string', 'null'],
      enum: [
        'hours',
        'service_area',
        'services_offered',
        'pricing',
        'contact_details',
        'eta',
        'other',
        null,
      ],
      description: 'When intent is "faq", which subject the question is about.',
    },
    outOfScopeRequest: nullableString(
      'When intent is "out_of_scope", a short description of what they asked for. Null otherwise.',
    ),
  },
} as const;

/**
 * Validates raw provider output against the Zod schema.
 * Throws on anything that does not conform, so a misbehaving provider becomes a
 * handled failure rather than corrupt conversation state.
 */
export function parseExtraction(raw: unknown): ExtractionResult {
  return ExtractionResultSchema.parse(raw);
}
