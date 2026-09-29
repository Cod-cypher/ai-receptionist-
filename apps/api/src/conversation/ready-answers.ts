/**
 * The two questions every stranded caller asks, and what the receptionist
 * says to each.
 *
 * It cannot give an arrival time: that depends on which truck is free, which
 * is the dispatcher's to decide. It can only give a price the business has
 * configured. On a real call it met both with "I can't confirm that on this
 * call", after a tool lookup that took two model round trips, and the caller
 * asked again. A person would say at once what they cannot tell you and what
 * will happen instead. These lines are that, and they are written here rather
 * than left to the model so that they never promise a time or a price.
 *
 * Whatever is promised here is put on the lead (`lead-notes.ts`), so that the
 * towing team keeps the promise.
 */

export type AskedAbout = 'eta' | 'price';

export const ETA_ANSWER = "I don't have a live arrival time on this line, but I'll have the towing team call you with an estimate.";

export const PRICE_ANSWER =
  "I don't have the current price on this line. I'll have the towing team confirm the price with you before any work starts.";

/** What the towing team is told to do about each, on the lead. */
export const ASKED_NOTE: Record<AskedAbout, string> = {
  eta: 'Caller asked how long it will take: call them with an estimate.',
  price: 'Caller asked the price: confirm it with them before any work starts.',
};

const ETA = /\b(?:how (?:long|soon|quick(?:ly)?|fast)|when (?:will|can|would|are|is)|what time|eta|how many minutes)\b/i;
const PRICE = /\b(?:how much|what(?:'s| is| will| does| would)[^.?!]{0,30}\b(?:cost|charge|price|fee|rate)|cost me|the (?:price|cost|fee|charge|rate)|a quote|pricing)\b/i;

/** What a line the caller spoke asks about, by its words. The judge adds what these miss. */
export function askedAbout(text: string): AskedAbout[] {
  const asked: AskedAbout[] = [];
  if (ETA.test(text)) asked.push('eta');
  if (PRICE.test(text)) asked.push('price');
  return asked;
}
