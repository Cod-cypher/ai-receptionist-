/**
 * The lines the receptionist says word for word, and the one-off instructions
 * for the replies the backend scripts: the greeting, the read-back, the
 * goodbyes, the silence check, the fallback after a broken rule.
 *
 * They are fixed here rather than left to the model so that they never
 * promise a time or a price, never turn into another question, and read the
 * callback number digit by digit. `checkReply()` still checks every one.
 */

import type { RequirementId } from '@towai/shared';

import type { IntakeSnapshot } from '../../conversation/intake';
import type { SummaryLine } from '../../conversation/types';

export function greetingInstructions(greeting: string): string {
  return `Start the call. Say exactly this and nothing else: "${greeting}"`;
}

/** Said word for word when the caller goes quiet: on a real call the model dressed this up and asked for a confirmation it had never read back. */
export const SILENCE_CHECK_LINE = 'Are you still there?';

export const TURN_LIMIT_GOODBYE_INSTRUCTIONS =
  'The call has gone on too long, so it is ending. Say the towing team has what they need and will contact them, and say goodbye. One or two short sentences.';

/** The caller was asked to confirm the read-back turn after turn and never clearly did. */
export const UNCONFIRMED_GOODBYE_INSTRUCTIONS =
  'The call is ending. Say you have passed the details to the towing team, who will call to confirm them, and say goodbye. One or two short sentences. Do not read the details again.';

export const SILENCE_GOODBYE_INSTRUCTIONS =
  'The caller has stayed silent, so the call is ending. Say the towing team will contact them, and say goodbye. One or two short sentences.';

/** After a reply was stopped for breaking a rule. */
export function guardrailRecoveryInstructions(detail: string, heard = ''): string {
  const stopped = heard
    ? `The caller heard you begin "${heard}" before your reply was stopped, because it ${detail}.`
    : `Your last reply was stopped before the caller heard it, because it ${detail}.`;
  return `${stopped} You must never do that. Continue helping the caller without it. If they asked about it, say the towing team will go over that with them when they get in touch. Keep it brief.`;
}

/**
 * After a reply was stopped for thinking aloud ("what's my next move?"). Not a
 * claim to retract, so no fixed line follows a second time: the model is told
 * again and carries on with the required action.
 */
export const SELF_TALK_RECOVERY_INSTRUCTIONS =
  'Your last reply was stopped because you were thinking aloud about your instructions, tools or what to do next. The caller hears every word you say. Say only what a receptionist would say to the caller, and do the REQUIRED ACTION from the latest CALL STATE. Do not apologise for it.';

/**
 * Pinned once the call is ending, in place of the last action note. On a real
 * call the goodbye was asked for while the pinned note still said "ask whether
 * the details were right", and "Were those details right?" was the last thing
 * the caller heard before the line closed.
 */
export const ENDING_NOTE =
  'REQUIRED ACTION: CLOSE\nThe call is ending. Nothing more is needed from the caller: do not ask them anything, and do not read the details again. Say only the goodbye.';

/** What the towing team will still ask the caller, in words spoken to them. */
const STILL_TO_ASK: Record<Exclude<RequirementId, 'customerPhone'>, string> = {
  serviceType: 'what help you need',
  location: 'where the vehicle is',
  vehicle: 'the vehicle',
  vehicleMovable: 'whether it can move',
  customerName: 'your name',
};

function inWords(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');
}

/**
 * Said word for word when the caller has said yes to the read-back. A goodbye
 * the model phrases from instructions can come out as another question.
 * Anything still missing is what the towing team will call about.
 */
export function confirmedGoodbyeLine(state: IntakeSnapshot | undefined): string {
  const name = state?.collected.customerName;
  const toAsk = (state?.missing ?? []).filter((id): id is keyof typeof STILL_TO_ASK => id !== 'customerPhone').map((id) => STILL_TO_ASK[id]);
  const then = toAsk.length > 0 ? `they'll call you to get ${inWords(toAsk)}` : "they'll be in touch";
  return `Thank you${name ? `, ${name}` : ''}. I've passed your details to the towing team, and ${then}. Goodbye.`;
}

/** Said word for word when the model breaks a rule a second time. */
export const SAFE_FALLBACK_LINE =
  "I can't confirm that on this call, but the towing team will go over it with you when they get in touch.";

export function exactLineInstructions(line: string): string {
  return `Say exactly this and nothing else: "${line}"`;
}

/** A phone number as it should be read aloud: digit by digit, in groups. */
export function spokenDigits(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const spaced = (s: string) => s.split('').join(' ');
  if (e164.startsWith('+1') && digits.length === 11) {
    const n = digits.slice(1);
    return `${spaced(n.slice(0, 3))}, ${spaced(n.slice(3, 6))}, ${spaced(n.slice(6))}`;
  }
  const groups = digits.match(/.{1,3}/g) ?? [digits];
  return `plus ${groups.map(spaced).join(', ')}`;
}

/**
 * The read-back, word for word. It is the caller's one chance to catch a
 * mishearing before the lead reaches the towing team, so it is not left to
 * the model to phrase: every saved detail, in a fixed order, the number digit
 * by digit, ending in the question the backend waits for an answer to.
 */
export function renderReadBack(lines: SummaryLine[]): string {
  const body = readBackParts(lines).join(', ');
  return `Let me read that back. ${body.charAt(0).toUpperCase()}${body.slice(1)}. Is that all correct?`;
}

/** Case, punctuation and spacing ignored, so that what was heard can be found in what was said. */
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * What is left of a read-back the caller spoke over, given the part they
 * heard. A detail they heard only the start of is said again whole. The
 * read-back is never started again from the top: on a real call that is how
 * the caller came to hear their own name and address three times.
 */
export function renderReadBackRest(lines: SummaryLine[], heard: string): string {
  const heardPlain = ` ${plain(heard)} `;
  const parts = readBackParts(lines);
  // Details are read in order, so everything after the first one not heard in full is unheard too.
  const firstUnheard = parts.findIndex((part) => !heardPlain.includes(` ${plain(part)} `));
  if (firstUnheard === -1) return 'Is that all correct?';
  if (firstUnheard === 0) return renderReadBack(lines);
  const body = parts.slice(firstUnheard).join(', ');
  return `And the rest: ${body}. Is that all correct?`;
}

function readBackParts(lines: SummaryLine[]): string[] {
  return lines
    .map(({ label, value }) => {
      switch (label) {
        case 'Name':
          return `your name is ${value}`;
        case 'Service':
          return `you need a ${value}`;
        case 'Location':
          return `the vehicle is at ${value}`;
        case 'Destination':
          return `it is going to ${value}`;
        case 'Vehicle':
          return `it is a ${value}`;
        case 'Vehicle movable':
          return value === 'no' ? "it can't move" : 'it can still move';
        case 'Condition':
          return `the problem is ${value}`;
        case 'Callback number':
          return `the callback number is ${spokenDigits(value)}`;
        case 'Notes':
          return null;
        default:
          return `${label.toLowerCase()} ${value}`;
      }
    })
    .filter((part): part is string => part !== null);
}
