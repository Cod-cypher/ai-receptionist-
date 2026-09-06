/**
 * Text hygiene for values that originate from a language model and end up in a
 * WhatsApp message, a dashboard table, and a database row.
 *
 * Everything here is deliberately conservative: the cost of over-cleaning is a
 * slightly odd-looking lead, the cost of under-cleaning is control characters or
 * a 4000-character hallucination in an operator's WhatsApp.
 */

/** Strings a model emits when it means "I don't know". Never store these. */
const PLACEHOLDER_VALUES = new Set([
  '',
  '-',
  '--',
  'n/a',
  'na',
  'none',
  'null',
  'nil',
  'undefined',
  'unknown',
  'unspecified',
  'not provided',
  'not specified',
  'not given',
  'not mentioned',
  'not available',
  'not applicable',
  'no answer',
  'no response',
  'customer did not say',
  'did not say',
  'tbd',
  'string',
]);

/**
 * True for C0/C1 control code points, excluding tab (0x09) and newline (0x0A).
 *
 * Expressed numerically rather than as a regex character class so this source
 * file stays pure ASCII and no literal control byte can hide inside it.
 */
function isControlCodePoint(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

/**
 * Removes control characters. Tab and newline survive here; `collapseWhitespace`
 * folds them into single spaces.
 */
export function stripControlCharacters(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (code === undefined || !isControlCodePoint(code)) out += ch;
  }
  return out;
}

/** Collapses all runs of whitespace (including newlines) to a single space. */
export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Full cleaning pass for a free-text slot value.
 * Returns `null` when nothing meaningful survives.
 */
export function cleanText(input: unknown, maxLength: number): string | null {
  if (typeof input !== 'string') return null;

  const cleaned = collapseWhitespace(stripControlCharacters(input));
  if (cleaned.length === 0) return null;
  if (PLACEHOLDER_VALUES.has(cleaned.toLowerCase())) return null;

  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned;
}

/** True when a model's answer is a stand-in for "no value". */
export function isPlaceholder(input: string): boolean {
  return PLACEHOLDER_VALUES.has(collapseWhitespace(input).toLowerCase());
}

/**
 * Gentle title casing for names and vehicle makes: "ahmed" -> "Ahmed",
 * "TOYOTA" -> "Toyota". Preserves interior capitals in already-mixed tokens
 * ("McLaren", "iPhone") and keeps short all-caps tokens (BMW, GMC, SUV) as-is.
 */
export function titleCase(input: string): string {
  return input
    .split(' ')
    .map((word) => {
      if (word.length === 0) return word;
      if (word.length <= 3 && word === word.toUpperCase()) return word;
      if (word !== word.toLowerCase() && word !== word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}
