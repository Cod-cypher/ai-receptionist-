import { describe, expect, it } from 'vitest';

import { isKnownTimeZone, isOpenAt, type BusinessHours } from './business';

const HOURS: BusinessHours[] = [{ day: 1, open: '09:00', close: '17:00', closed: false }];
// A Monday, 10:00 in Chicago (15:00 UTC).
const MONDAY_MORNING = new Date('2026-03-16T15:00:00.000Z');

describe('isOpenAt', () => {
  it('reads the clock in the business\'s own time zone', () => {
    expect(isOpenAt(HOURS, 'America/Chicago', MONDAY_MORNING)).toBe(true);
    expect(isOpenAt(HOURS, 'Asia/Karachi', MONDAY_MORNING)).toBe(false); // 20:00 there
  });

  it('cannot say, rather than throwing, for a time zone it does not know', () => {
    // A tenant saved "Karachi" once; every call to that business then failed
    // before the greeting, because loading the business threw here.
    expect(isOpenAt(HOURS, 'Not/AZone', MONDAY_MORNING)).toBeNull();
    expect(isOpenAt(HOURS, 'Karachi', MONDAY_MORNING)).toBeNull();
  });
});

describe('isKnownTimeZone', () => {
  it('knows IANA names and nothing else', () => {
    expect(isKnownTimeZone('America/Chicago')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
    expect(isKnownTimeZone('Karachi')).toBe(false);
    expect(isKnownTimeZone('')).toBe(false);
  });
});
