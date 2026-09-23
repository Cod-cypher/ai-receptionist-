import { describe, expect, it } from 'vitest';

import { isE164, normalisePhone } from './phone';

describe('normalisePhone', () => {
  it('accepts a full North American number, spoken or with punctuation', () => {
    expect(normalisePhone('814-202-7042', '+1')).toBe('+18142027042');
    expect(normalisePhone('(817) 409 8408', '+1')).toBe('+18174098408');
    expect(normalisePhone('+1 817 409 8408')).toBe('+18174098408');
  });

  it('rejects a North American number with the wrong number of digits, rather than store one nobody can dial', () => {
    // Heard over a bad line on a real call as "0328-93-...-13": nine digits.
    expect(normalisePhone('0328 93 13', '+1')).toBeNull();
    expect(normalisePhone('204 204', '+1')).toBeNull();
    expect(normalisePhone('+132893013')).toBeNull();
    expect(isE164('+18142027042')).toBe(true);
    expect(isE164('+1814202704')).toBe(false);
    expect(isE164('+10142027042')).toBe(false); // area codes never start with 0 or 1
  });

  it('keeps the national-format rule for Pakistan', () => {
    expect(normalisePhone('0300 1234567', '+92')).toBe('+923001234567');
    expect(normalisePhone('0300 12345', '+92')).toBeNull();
  });

  it('leaves other countries to the generic length check', () => {
    expect(isE164('+33123456789')).toBe(true);
  });
});
