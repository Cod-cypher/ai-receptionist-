import { describe, expect, it } from 'vitest';
import {
  EMPTY_EXTRACTION,
  EXTRACTION_JSON_SCHEMA,
  ExtractionResultSchema,
  compactSlots,
  parseExtraction,
} from './extraction';

/**
 * The JSON Schema is sent to the providers; the Zod schema validates what comes
 * back. If they drift apart, a provider would be asked for one shape and judged
 * against another, and the mismatch would only surface on a live call.
 */
describe('the wire schema and the validation schema agree', () => {
  it('describes the same top-level fields', () => {
    const jsonFields = Object.keys(EXTRACTION_JSON_SCHEMA.properties).sort();
    const zodFields = Object.keys(ExtractionResultSchema.shape).sort();
    expect(jsonFields).toEqual(zodFields);
  });

  it('describes the same slot fields', () => {
    const jsonSlots = Object.keys(EXTRACTION_JSON_SCHEMA.properties.slots.properties).sort();
    const zodSlots = Object.keys(ExtractionResultSchema.shape.slots.shape).sort();
    expect(jsonSlots).toEqual(zodSlots);
  });

  it('marks every field required, as strict mode demands', () => {
    expect([...EXTRACTION_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(EXTRACTION_JSON_SCHEMA.properties).sort(),
    );
    expect([...EXTRACTION_JSON_SCHEMA.properties.slots.required].sort()).toEqual(
      Object.keys(EXTRACTION_JSON_SCHEMA.properties.slots.properties).sort(),
    );
  });

  it('offers the same intent values', () => {
    expect([...EXTRACTION_JSON_SCHEMA.properties.intent.enum].sort()).toEqual(
      [...ExtractionResultSchema.shape.intent.options].sort(),
    );
  });

  it('validates the empty result the engine falls back to', () => {
    expect(() => parseExtraction(EMPTY_EXTRACTION)).not.toThrow();
  });
});

describe('parseExtraction', () => {
  it('accepts a well-formed provider response', () => {
    const raw = {
      ...EMPTY_EXTRACTION,
      intent: 'provide_info',
      slots: { ...EMPTY_EXTRACTION.slots, location: 'Liberty Market', vehicleMovable: false },
    };
    expect(parseExtraction(raw).slots.location).toBe('Liberty Market');
  });

  it('rejects a response with an invented intent', () => {
    const raw = { ...EMPTY_EXTRACTION, intent: 'dispatch_truck' };
    expect(() => parseExtraction(raw)).toThrow();
  });

  it('rejects a response missing a required field', () => {
    const { faqTopic, ...withoutTopic } = EMPTY_EXTRACTION;
    expect(() => parseExtraction(withoutTopic)).toThrow();
  });
});

describe('compactSlots', () => {
  it('drops nulls so unobserved fields never overwrite stored values', () => {
    const result = compactSlots({
      ...EMPTY_EXTRACTION.slots,
      location: 'Mall Road',
      vehicleMovable: false,
    });
    expect(result).toEqual({ location: 'Mall Road', vehicleMovable: false });
  });

  it('keeps false, which is a real answer and not an absence', () => {
    const result = compactSlots({ ...EMPTY_EXTRACTION.slots, vehicleMovable: false });
    expect(result).toHaveProperty('vehicleMovable', false);
  });
});
