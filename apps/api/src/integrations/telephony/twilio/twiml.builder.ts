/**
 * TwiML text helpers.
 *
 * Caller speech and business names reach TwiML as text. Both can contain
 * characters that would break the XML or, worse, inject elements into it, so
 * everything interpolated into a document goes through `escapeXml` first.
 */

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}
