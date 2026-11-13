/**
 * The lines the receptionist says word for word, and the one-off instructions
 * for the replies the backend scripts: the greeting, the read-back, the
 * goodbyes, the silence check, the fallback after a broken rule.
 *
 * They are fixed here rather than left to the model so that they never
 * promise a time or a price, never turn into another question, and read the
 * callback number digit by digit. `checkReply()` still checks every one.
 *
 * The model copies them exactly, so they are written the way a receptionist
 * talks: contractions, "you", one detail after another the way it is said
 * aloud. None opens with a one-word ack ("Okay,", "Alright,"): the read-back
 * and the goodbye come after a tool call, when the gateway has often just
 * played a filler ("Okay.", "Alright."), and the caller would hear it twice.
 */

import type { RequirementId } from '@towai/shared';

import type { IntakeSnapshot } from '../../conversation/intake';
import type { SummaryLine } from '../../conversation/types';
import { SERVICE_LABEL } from '../judgment/typesafe-questions';

export function greetingInstructions(greeting: string): string {
  return `Start the call. Say exactly this and nothing else: "${greeting}"`;
}

/** Said word for word when the caller goes quiet: on a real call the model dressed this up and asked for a confirmation it had never read back. */
export const SILENCE_CHECK_LINE = 'Still there?';

/** What every goodbye leaves out. "They'll call you soon" passes the arrival-time rule, so "soon" is named. */
const NOTHING_MORE = 'Ask nothing, don\'t read the details again, and don\'t say when the team will call, not even "soon".';

export const TURN_LIMIT_GOODBYE_INSTRUCTIONS = `The call has run too long, so it's ending. In one or two short sentences, say the towing team has what they need and will give them a call, then say goodbye. ${NOTHING_MORE}`;

/** The caller was asked to confirm the read-back turn after turn and never clearly did. */
export const UNCONFIRMED_GOODBYE_INSTRUCTIONS = `The call is ending. In one or two short sentences, say you've passed the details to the towing team, who will call to confirm them, then say goodbye. ${NOTHING_MORE}`;

export const SILENCE_GOODBYE_INSTRUCTIONS = `The caller has gone quiet, so the call is ending. In one or two short sentences, say the towing team will give them a call, then say goodbye. ${NOTHING_MORE}`;

/** After a reply was stopped for breaking a rule. */
export function guardrailRecoveryInstructions(detail: string, heard = ''): string {
  const stopped = heard
    ? `The caller heard you begin "${heard}" before your reply was stopped, because it ${detail}.`
    : `Your last reply was stopped before the caller heard it, because it ${detail}.`;
  return `${stopped} Never do that. Carry on without it; if they asked about it, say the team will go over it with them when they call. Keep it short.`;
}

/**
 * After a reply was stopped for thinking aloud ("what's my next move?"). Not a
 * claim to retract, so no fixed line follows a second time: the model is told
 * again and carries on with the required action.
 */
export const SELF_TALK_RECOVERY_INSTRUCTIONS =
  "Your last reply was stopped because you were thinking aloud about your instructions, tools or next step, and the caller hears every word. Say only what you'd say to the caller, and do the REQUIRED ACTION from the latest CALL STATE. Don't apologise for it.";

/**
 * Pinned once the call is ending, in place of the last action note. On a real
 * call the goodbye was asked for while the pinned note still said "ask whether
 * the details were right", and "Were those details right?" was the last thing
 * the caller heard before the line closed.
 */
export const ENDING_NOTE = `REQUIRED ACTION: CLOSE\nThe call is ending; nothing more is needed from the caller. Say only the goodbye. ${NOTHING_MORE}`;

/**
 * What the towing team will still ask the caller, in words spoken to them.
 * Each one follows "they'll give you a call to ask", so each reads as what is
 * asked: "to get the vehicle" would sound like a promise to come for it.
 */
const STILL_TO_ASK: Record<Exclude<RequirementId, 'customerPhone'>, string> = {
  serviceType: 'what help you need',
  location: 'where the vehicle is',
  vehicle: "what you're driving",
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
  const about = toAsk.length > 0 ? ` to ask ${inWords(toAsk)}` : '';
  return `You're all set${name ? `, ${name}` : ''}. I've passed everything to the towing team and they'll give you a call${about}. Take care.`;
}

/** Said word for word when the model breaks a rule a second time. */
export const SAFE_FALLBACK_LINE = "I can't confirm that from here, but the team will go over it with you when they call.";

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

/** The question that ends every read-back. The backend, the live check and the eval wait for the answer to it. */
export const READ_BACK_QUESTION = 'Did I get all that right?';

/**
 * The read-back, word for word. It is the caller's one chance to catch a
 * mishearing before the lead reaches the towing team, so it is not left to
 * the model to phrase: every saved detail, in a fixed order, the number digit
 * by digit, ending in the question the backend waits for an answer to.
 */
export function renderReadBack(lines: SummaryLine[]): string {
  const parts = readBackParts(lines);
  if (parts.length === 0) return READ_BACK_QUESTION;
  const body = sayParts(parts);
  return `Let me make sure I've got this right. ${body.charAt(0).toUpperCase()}${body.slice(1)}. ${READ_BACK_QUESTION}`;
}

/** Case, punctuation and spacing ignored, so that what was heard can be found in what was said. */
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * What is left of a read-back the caller spoke over, given the part they
 * heard. A detail they heard only the start of is said again whole. The
 * read-back is never started again from the top: on a real call that is how
 * the caller came to hear their own name and address three times. It follows
 * the model's answer to what the caller said, hence "As I was saying".
 */
export function renderReadBackRest(lines: SummaryLine[], heard: string): string {
  const heardPlain = ` ${plain(heard)} `;
  const parts = readBackParts(lines);
  // Details are read in order, so everything after the first one not heard in full is unheard too.
  const firstUnheard = parts.findIndex((part) => !heardPlain.includes(` ${plain(part.text)} `));
  if (firstUnheard === -1) return READ_BACK_QUESTION;
  if (firstUnheard === 0) return renderReadBack(lines);
  return `As I was saying, ${sayParts(parts.slice(firstUnheard))}. ${READ_BACK_QUESTION}`;
}

/** One detail of the read-back. The name is said on its own ("Ali, you need a tow"); every other part is a clause. */
interface ReadBackPart {
  text: string;
  name?: true;
}

/**
 * The parts, joined as they are said: "Ali, you need a tow; the Hyundai
 * Sonata is at 3114 Holloway Street; it can't move; and we'll call you back
 * on …". Both renderings use this, so the parts matched against what the
 * caller heard are exactly the words they heard.
 */
function sayParts(parts: ReadBackPart[]): string {
  const clauses = parts.filter((part) => !part.name).map((part) => part.text);
  const said = clauses.map((clause, i) => (i > 0 && i === clauses.length - 1 ? `and ${clause}` : clause)).join('; ');
  const name = parts.find((part) => part.name)?.text;
  return name ? (said ? `${name}, ${said}` : name) : said;
}

const SHOWN_ELSEWHERE = new Set(['Name', 'Service', 'Location', 'Destination', 'Vehicle', 'Vehicle movable', 'Condition', 'Notes', 'Callback number']);

function readBackParts(lines: SummaryLine[]): ReadBackPart[] {
  const value = (label: string) => lines.find((line) => line.label === label)?.value;
  const parts: ReadBackPart[] = [];
  const clause = (text: string | undefined) => {
    if (text) parts.push({ text });
  };

  const name = value('Name');
  if (name) parts.push({ text: name, name: true });

  const service = value('Service');
  clause(service && `you need ${spokenService(service)}`);

  // Where the vehicle is, said with what it is: "the Hyundai Sonata is at 3114 Holloway Street".
  const vehicle = value('Vehicle');
  const location = value('Location');
  const destination = value('Destination');
  const going = destination ? `, going to ${destination}` : '';
  if (location) {
    clause(`the ${vehicle ? spokenVehicle(vehicle) : 'vehicle'} is ${placed(location)}${going}`);
  } else {
    if (vehicle) clause(`it's ${withArticle(spokenVehicle(vehicle))}`);
    if (destination) clause(`it's going to ${destination}`);
  }

  const movable = value('Vehicle movable');
  if (movable) clause(movable === 'no' ? "it can't move" : 'it can still move');

  const condition = value('Condition');
  clause(condition && `the problem is ${spokenProblem(condition)}`);

  for (const line of lines) {
    if (!SHOWN_ELSEWHERE.has(line.label)) clause(`${line.label.toLowerCase()} ${line.value}`);
  }

  const callback = value('Callback number');
  clause(callback && `we'll call you back on ${spokenDigits(callback)}`);

  return parts;
}

/* -------------------------------------------------------------------------- */
/*  Saved values, as they are said                                            */
/* -------------------------------------------------------------------------- */

type ServiceKind = keyof typeof SERVICE_LABEL;

/** Each kind of help as it follows "you need". Typed against `SERVICE_LABEL`, so a new kind of help needs its words here. */
const SERVICE_SPOKEN: Record<ServiceKind, string> = {
  tow: 'a tow',
  jump_start: 'a jump start',
  flat_tire: 'help with a flat tire',
  lockout: 'a lockout',
  fuel_delivery: 'fuel',
  winch_out: 'a winch-out',
};

/**
 * Other words the same help is saved as: the caller's own, kept as said
 * ("towing"), and the older pipelines' ("vehicle towing"). On a real call the
 * read-back said "you need a vehicle towing".
 */
const SERVICE_SAID_AS: Record<string, ServiceKind> = {
  ...Object.fromEntries((Object.entries(SERVICE_LABEL) as Array<[ServiceKind, string]>).map(([kind, label]) => [plain(label), kind])),
  towing: 'tow',
  'vehicle towing': 'tow',
  'car towing': 'tow',
  'tow truck': 'tow',
  jump: 'jump_start',
  jumpstart: 'jump_start',
  boost: 'jump_start',
  'battery jump': 'jump_start',
  'flat tyre': 'flat_tire',
  flat: 'flat_tire',
  'tire change': 'flat_tire',
  'tyre change': 'flat_tire',
  'lock out': 'lockout',
  'locked out': 'lockout',
  unlock: 'lockout',
  fuel: 'fuel_delivery',
  gas: 'fuel_delivery',
  'gas delivery': 'fuel_delivery',
  'out of gas': 'fuel_delivery',
  'out of fuel': 'fuel_delivery',
  winch: 'winch_out',
  winching: 'winch_out',
  winchout: 'winch_out',
};

/**
 * "a tow" for "vehicle towing". Anything else is said as it was saved
 * ("you need roadside assistance"): a guess at a closer word could drop a
 * detail ("two flat tires" is not "a flat tire").
 */
function spokenService(service: string): string {
  const key = plain(service)
    .replace(/^(?:a|an|some) /, '')
    .replace(/ services?$/, '');
  const kind = SERVICE_SAID_AS[key];
  return kind ? SERVICE_SPOKEN[kind] : service;
}

/**
 * Words that describe a kind of vehicle rather than name one. A saved value
 * made only of these is a type ("Small Car", from a real call) and is said in
 * lower case; anything else holds a make or model and keeps its case.
 */
const VEHICLE_TYPE_WORDS = new Set([
  ...['car', 'truck', 'pickup', 'pick-up', 'van', 'minivan', 'suv', 'sedan', 'saloon', 'coupe', 'hatchback', 'wagon', 'estate'],
  ...['convertible', 'crossover', 'motorcycle', 'motorbike', 'bike', 'scooter', 'moped', 'bus', 'trailer', 'camper', 'motorhome'],
  ...['rv', 'atv', 'utv', 'semi', 'tractor', 'box', 'flatbed', 'dump', 'tow', 'cargo', 'panel', 'delivery', 'utility', 'limo'],
  ...['vehicle', 'auto', 'automobile', '18-wheeler', 'wheeler', 'small', 'compact', 'mid-size', 'midsize', 'full-size', 'large'],
  ...['big', 'little', 'heavy', 'heavy-duty', 'light', 'medium', 'duty', 'sport', 'sports', 'family', 'electric', 'hybrid'],
  ...['two-door', 'four-door', 'old', 'new', 'white', 'black', 'silver', 'grey', 'gray', 'red', 'blue', 'green', 'dark'],
]);

/** Said letter by letter, so kept in capitals: "an SUV". */
const SPELLED_OUT = new Set(['suv', 'rv', 'atv', 'utv']);

function spokenType(type: string): string {
  return type
    .split(/\s+/)
    .map((word) => (SPELLED_OUT.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()))
    .join(' ');
}

/** "Toyota Hilux (Pickup)" as "Toyota Hilux pickup", "Small Car" as "small car", "Hyundai Sonata" as it is. */
function spokenVehicle(vehicle: string): string {
  const typed = /^(.*\S)\s*\(([^)]+)\)$/.exec(vehicle.trim());
  if (typed) return `${typed[1]} ${spokenType(typed[2]!)}`;
  const isType = vehicle.trim().split(/\s+/).every((word) => VEHICLE_TYPE_WORDS.has(word.toLowerCase()));
  return isType ? spokenType(vehicle.trim()) : vehicle;
}

/**
 * "at 3114 Holloway Street", but "on the highway, near mile marker 97": on a
 * real call the read-back said "the Toyota Corolla is at highway, shoulder
 * near mile marker 97".
 */
function placed(location: string): string {
  return /^(?:highway|freeway|interstate|motorway|expressway|turnpike|shoulder|hard shoulder)/i.test(location) ? `on the ${location}` : `at ${location}`;
}

/** "a blowout" for "blowout" (the same call: "the problem is blowout"); anything not a plain countable problem is said as saved. */
function spokenProblem(condition: string): string {
  return /^(?:blowout|flat|flat tire|flat tyre|dead battery|puncture|accident|crash|breakdown|leak|oil leak|broken axle)$/i.test(condition.trim()) ? `a ${condition.trim()}` : condition;
}

/** "a Hyundai Sonata", "an SUV", "an old pickup". */
function withArticle(words: string): string {
  return /^(?:[aeio]|(?:SUV|RV|ATV|18|8|11)\b)/i.test(words) ? `an ${words}` : `a ${words}`;
}
