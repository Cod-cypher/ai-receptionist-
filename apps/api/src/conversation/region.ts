/**
 * The caller's country, from their caller ID.
 *
 * A towing business can take calls from another country than the one it was
 * set up for (the demo business is configured for +92 but answers a US
 * number). The caller's own country decides which emergency number to give
 * them and how to read a local phone number they say.
 */

export interface CallerRegion {
  /** E.164 country prefix, e.g. "+1". */
  prefix: string;
  emergencyNumber: string;
}

const REGIONS: readonly CallerRegion[] = [
  { prefix: '+971', emergencyNumber: '999' },
  { prefix: '+44', emergencyNumber: '999' },
  { prefix: '+61', emergencyNumber: '000' },
  { prefix: '+64', emergencyNumber: '111' },
  { prefix: '+92', emergencyNumber: '1122' },
  { prefix: '+91', emergencyNumber: '112' },
  { prefix: '+1', emergencyNumber: '911' },
];

/** The international emergency number, which also works on most mobile networks. */
export const FALLBACK_EMERGENCY_NUMBER = '112';

export function regionForNumber(e164: string | null | undefined): CallerRegion | null {
  if (!e164 || !e164.startsWith('+')) return null;
  return REGIONS.find((region) => e164.startsWith(region.prefix)) ?? null;
}
