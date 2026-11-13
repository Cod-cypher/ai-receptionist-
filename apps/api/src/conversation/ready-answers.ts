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
 * They are said the way the person at the front desk would say them: "from
 * here" and "the team", not "on this line", which sounds like a phone system.
 * Each is short enough to come before the next question in the same breath,
 * as in the prompt's example: the answer, then "Where are you right now?".
 *
 * Whatever is promised here is put on the lead (`lead-notes.ts`), so that the
 * towing team keeps the promise.
 */

export type AskedAbout = 'eta' | 'price';

export const ETA_ANSWER = "I don't have an ETA from here, but the team will call you with one as soon as they've got it.";

export const PRICE_ANSWER = "I can't quote a price from here. The team will confirm it with you before anything's done.";

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
