/**
 * Phone number normalisation.
 *
 * Deliberately not libphonenumber: the only numbers this system handles are
 * (a) caller IDs the telephony provider already delivers in E.164, and
 * (b) an occasional "call me on ..." spoken alternative. Full national-format
 * parsing for every country is not worth the 500 kB and the ambiguity; when a
 * spoken number cannot be confidently normalised we keep the caller ID instead,
 * which is always correct.
 */

/** A number is stored only in E.164: leading '+', 8-15 digits, no separators. */
const E164 = /^\+[1-9]\d{7,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * Normalises a phone number to E.164 where that can be done without guessing.
 *
 * @param raw           the number as spoken or received
 * @param defaultRegionPrefix  e.g. '+92' — used only when `raw` is in national
 *                      format with a leading 0, which is the one national shape
 *                      that maps unambiguously once the country is known.
 * @returns E.164 string, or `null` when normalisation would require a guess.
 */
export function normalisePhone(
  raw: unknown,
  defaultRegionPrefix?: string,
): string | null {
  if (typeof raw !== 'string') return null;

  // Keep digits and a single leading '+'. Spoken numbers arrive with spaces,
  // dashes, parentheses, and sometimes the word "plus" already transcribed.
  const trimmed = raw.trim().replace(/^00/, '+');
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (digits.length === 0) return null;

  if (hasPlus) {
    const candidate = `+${digits}`;
    return isE164(candidate) ? candidate : null;
  }

  // National format with a trunk prefix: 0300 1234567 -> +92 300 1234567
  if (digits.startsWith('0') && defaultRegionPrefix) {
    const candidate = `${defaultRegionPrefix}${digits.slice(1)}`;
    return isE164(candidate) ? candidate : null;
  }

  // A bare national number with a known region.
  if (defaultRegionPrefix) {
    const candidate = `${defaultRegionPrefix}${digits}`;
    if (isE164(candidate)) return candidate;
  }

  // Long enough to be a full international number that simply lost its '+'.
  if (digits.length >= 10) {
    const candidate = `+${digits}`;
    if (isE164(candidate)) return candidate;
  }

  return null;
}

/**
 * Renders E.164 with light grouping for human display in WhatsApp and the
 * dashboard: '+923001234567' -> '+92 300 1234567'.
 *
 * Grouping is cosmetic only. The stored value is always the raw E.164 string,
 * so a operator can copy either form and still reach the customer.
 */
export function formatPhoneForDisplay(e164: string): string {
  if (!isE164(e164)) return e164;

  const digits = e164.slice(1);
  // Country codes are 1-3 digits; without a full metadata table we use a small
  // table for the codes this product actually sees and fall back to a 2-digit
  // split, which still reads better than an unbroken 12-digit run.
  const threeDigitCodes = ['923', '971', '966', '880', '234', '254'];
  const twoDigitCodes = ['92', '91', '44', '61', '49', '33', '90', '81', '86'];

  let cc: string;
  if (digits.startsWith('1') || digits.startsWith('7')) {
    cc = digits.slice(0, 1);
  } else if (threeDigitCodes.some((c) => digits.startsWith(c))) {
    cc = digits.slice(0, 2);
  } else if (twoDigitCodes.some((c) => digits.startsWith(c))) {
    cc = digits.slice(0, 2);
  } else {
    cc = digits.slice(0, 3);
  }

  const rest = digits.slice(cc.length);
  if (rest.length <= 4) return `+${cc} ${rest}`;

  const head = rest.slice(0, 3);
  const tail = rest.slice(3);
  return `+${cc} ${head} ${tail}`;
}
