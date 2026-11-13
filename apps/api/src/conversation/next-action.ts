/**
 * The priority engine: what the receptionist must do next.
 *
 * The realtime model says this; it does not choose it. Each ask comes with a
 * line to say it with (`ASK_PHRASINGS`), so it sounds like a person rather
 * than a form. The order is the existing requirement order from
 * `REQUIREMENTS` (the business's intake order), with three additions only
 * code can judge reliably: safety advice comes first, a detail the model was
 * unsure it heard is checked straight away, and a location too vague to
 * dispatch to is narrowed down before anything else is asked.
 *
 * `doNotAsk` names every topic that must wait: everything already known and
 * everything lower in the order. It is what stops "I-95" being followed by
 * "is this the best number to reach you?".
 */

import {
  ConversationState,
  REQUIREMENTS,
  SLOT_DEFS,
  type Requirement,
  type RequirementId,
  type SlotKey,
  type SlotValues,
} from '@towai/shared';

import { SERVICE_LABEL } from '../integrations/judgment/typesafe-questions';
import { assessLocation, type LocationAssessment } from './location';
import { HIGH_SPEED_ROAD_HAZARD } from './risk';
import { buildSummary } from './state-machine';
import type { ConversationContext, SummaryLine } from './types';

export type NextAction =
  | 'HANDLE_SAFETY'
  | 'CLARIFY_FIELD'
  | 'ASK_SERVICE_TYPE'
  | 'ASK_LOCATION'
  | 'ASK_LOCATION_DETAIL'
  | 'ASK_VEHICLE'
  | 'ASK_VEHICLE_MOVABLE'
  | 'ASK_CUSTOMER_NAME'
  | 'CONFIRM_CALLBACK_NUMBER'
  | 'ASK_CALLBACK_NUMBER'
  | 'CONFIRM_DETAILS'
  | 'AWAIT_CONFIRMATION'
  | 'CLOSE';

/** What a question is about. Used to spot a reply asking the wrong thing. */
export type Topic =
  | 'safety'
  | 'service'
  | 'location'
  | 'vehicle'
  | 'movable'
  | 'name'
  | 'callback_number'
  | 'details'
  | 'destination';

export interface NextActionPlan {
  action: NextAction;
  topic: Topic | null;
  /** What to ask, in plain words, then the line to say it with: `Say it like: "…"`. */
  ask: string;
  /** Topics that must not be asked about now. */
  doNotAsk: Topic[];
  /** For CLARIFY_FIELD: the fields to check. */
  clarify?: SlotKey[];
  /** For CONFIRM_DETAILS / AWAIT_CONFIRMATION: what to read back. */
  summary?: SummaryLine[];
  location: LocationAssessment;
  /**
   * Why this action, for the call's event trail: the deciding reason first,
   * then what stood around it. Never sent to the model.
   */
  because: string[];
  /** Topics already settled: known, or given up on. A question about one is not "to wait", it is done. */
  settled: Topic[];
}

export interface NextActionOptions {
  emergencyNumber?: string;
  knownAreas?: readonly string[];
  /** The caller's current turn. Without it, a cut read-back is finished whenever it is next asked about. */
  callerTurn?: number;
}

/** Detail requests before a vague location is accepted as the best available. */
export const MAX_LOCATION_DETAIL_ATTEMPTS = 2;

/**
 * Caller turns on which the same thing may be asked before the receptionist
 * moves on without it. What is missing is then for the towing team to get
 * when they call: a caller asked the same thing a fourth time hangs up. Only
 * a caller who has since answered other questions is asked once more, as the
 * last thing before the read-back (`lastChanceDue`).
 */
export const MAX_ASKS = 3;
/** A value the model was not sure it heard is checked with the caller once. */
export const MAX_CLARIFICATIONS = 1;
/**
 * Caller turns spent waiting for a yes to the read-back before the call is
 * finished with the details unconfirmed. Questions get answered on those
 * turns; what does not happen is a fifth "were those details right?".
 */
export const MAX_CONFIRMATION_WAITS = 4;

/** What an ask is counted under. A value to check is counted with the value, so a new value is a new check. */
export function askKeys(plan: Pick<NextActionPlan, 'action' | 'clarify'>, values: SlotValues): string[] {
  if (plan.action === 'CLARIFY_FIELD') return (plan.clarify ?? []).map((key) => `CLARIFY_FIELD:${key}=${String(values[key])}`);
  return [plan.action];
}

/** Caller turns before this one on which `key` was asked. Asking again within a turn is the same ask. */
function askedBefore(ctx: ConversationContext, key: string, turn: number | undefined): number {
  const asked = ctx.asked?.[key];
  if (!asked) return 0;
  return turn !== undefined && asked.turn === turn ? asked.count - 1 : asked.count;
}

// Not "say you did not get it": a caller who asked about the weather was told
// "I'm not sure where the vehicle is", and one who said "It's a plane" was told
// "Sorry, I didn't catch that". New words come from the sample for the attempt.
const ASK_AGAIN =
  "You've asked this before: answer anything else they said first, say briefly why if their answer wasn't usable, and never say you didn't hear them when you did. ";

const LAST_TRY = "One last try before the read-back: ask it one last time, and if they still can't say, leave it for the towing team. ";

/** The attempt whose sample is the one last chance before the read-back: asked `MAX_ASKS` times already. */
const LAST_CHANCE_ATTEMPT = MAX_ASKS;

// The read-back is said word for word from the line the note gives after the
// ask. Given a list to phrase, the model read the number as "+18174098408".
const READ_BACK_ASK = "Everything's saved. Read the details back word for word, with the exact line given below, then wait for their answer.";

// No "soon" or "shortly": the towing team calls when it calls.
const CLOSE_ASK =
  'The call\'s over. Thank them, say the towing team will call them, and say goodbye; don\'t say when. Say it like: "Thanks for calling. The towing team will give you a call. Take care."';

/**
 * How each ask is said. The instruction tells the model what to ask; the
 * sample is the line it says. Asked in plain words ("Ask what vehicle it is
 * (make and model, or at least the type)"), it said "Could you tell me what
 * kind of vehicle it is?" on the call of 12 October, and "What kind of help do
 * you need right now?". Given a sample, it says the sample word for word, so
 * every sample is a line a caller should hear: short, with contractions, no
 * "Could you tell me", no "please provide", and none opening with a one-word
 * ack, which the model or a filler has often just said.
 *
 * The index is the attempt: the caller turns it was asked on before this one.
 * 0 is the first ask, 1 asked again, 2 the last try before moving on, and 3
 * the one last chance before the read-back (asked `MAX_ASKS` times already).
 * Every attempt has its own words: the eval fails a sentence said twice on a
 * call (REPEATED_REPLY), and a caller asked in the same words again hears a
 * machine. `askPhrasing` clamps the attempt to the last sample.
 *
 * Placeholders, filled by `askPhrasing`: {offer} the help offered ("a jump
 * start, or a tow"), {road} ("I-95"), {number} the emergency number ("911"),
 * {value} the value being checked, as it is said ("a Honda Civic").
 *
 * The `Topic` of each key. `questionsIn` (response-check) must find that
 * topic in every sample and no other, or a correct reply is called off-plan:
 * - service: ASK_SERVICE_TYPE, ASK_SERVICE_TYPE:problem, ASK_SERVICE_TYPE:offer, CLARIFY_FIELD:service
 * - location: ASK_LOCATION, ASK_LOCATION_DETAIL, ASK_LOCATION_DETAIL:highway, ASK_LOCATION_DETAIL:street, CLARIFY_FIELD:location
 * - vehicle: ASK_VEHICLE, CLARIFY_FIELD:vehicle
 * - movable: ASK_VEHICLE_MOVABLE, ASK_VEHICLE_MOVABLE:tow, CLARIFY_FIELD:movable:yes, CLARIFY_FIELD:movable:no
 * - name: ASK_CUSTOMER_NAME, CLARIFY_FIELD:name
 * - callback_number: CONFIRM_CALLBACK_NUMBER, ASK_CALLBACK_NUMBER, CLARIFY_FIELD:callback_number
 * - details: AWAIT_CONFIRMATION
 * - safety: HANDLE_SAFETY, HANDLE_SAFETY:road (the question; the sentence after it is the advice)
 * - none of its own: CLARIFY_FIELD, for any other field; only {value} says what it is about
 */
export const ASK_PHRASINGS: Record<string, readonly string[]> = {
  ASK_SERVICE_TYPE: [
    "What's going on with the car?",
    'What happened?',
    'So what do you need, a tow or something else?',
    'Before I pass this on, what do you need help with?',
  ],
  // They have said what is wrong ("it won't start"). Asked "what's going on
  // with the car?", they would hear a receptionist who was not listening.
  'ASK_SERVICE_TYPE:problem': [
    'So what do you need, a tow or something else?',
    'Do you need a tow, or something else?',
    'Should I put you down for a tow, or is it something else?',
    'Before I pass this on, what do you need help with?',
  ],
  // The judge's likeliest kinds of help, offered by name.
  'ASK_SERVICE_TYPE:offer': [
    'Do you need {offer}?',
    'So is it {offer} you need?',
    'Should I put you down for {offer}?',
    'Before I pass this on, do you need {offer}?',
  ],
  ASK_LOCATION: [
    'Where are you right now?',
    "What's the nearest exit, cross street, or a business you can see?",
    'Which road are you on, or which town?',
    'Last thing before I pass this on: any landmark near you?',
  ],
  // A numbered road or a highway: "I-95", "the highway".
  'ASK_LOCATION_DETAIL:highway': [
    'Where on {road}, an exit number, mile marker, or something you can see?',
    "What's the nearest exit or mile marker on {road}?",
    'Is there an exit sign or a landmark you can see from there?',
  ],
  // A street with no number on it: "Main Street".
  'ASK_LOCATION_DETAIL:street': [
    'Where on {road}, a house number or a cross street?',
    "What's the nearest cross street on {road}?",
    'Is there a landmark near you, a store or a gas station?',
  ],
  // No road at all: "downtown", "on the shoulder", a word nobody knows.
  ASK_LOCATION_DETAIL: [
    'Where exactly, a street name or a business you can see?',
    'Can you give me the nearest exit or a cross street?',
    'Any landmark near you, a gas station or a store?',
  ],
  ASK_VEHICLE: [
    'What are you driving?',
    'What kind of car is it, make and model if you know it?',
    'What sort of vehicle is it, just roughly?',
    'And one more thing: what are you driving, roughly?',
  ],
  // The service is a tow: what the driver needs to know is whether it rolls.
  'ASK_VEHICLE_MOVABLE:tow': [
    'Does it roll and steer, or is it stuck where it is?',
    "Will it roll if it's in neutral?",
    'Can it roll at all, or is it stuck?',
    'One more thing: does it roll, or is it stuck?',
  ],
  ASK_VEHICLE_MOVABLE: [
    'Does it still start and drive, or is it dead?',
    'Can you still drive it?',
    'Is it drivable at all?',
    'One more thing: can it still be driven?',
  ],
  ASK_CUSTOMER_NAME: [
    'And who am I speaking with?',
    "What's your name?",
    'Can I get your first name, for the team?',
    'And your name, before I pass this on?',
  ],
  CONFIRM_CALLBACK_NUMBER: [
    'Is this the best number to reach you on?',
    'Should we call you back on this number?',
    "Is the number you're calling from the right one for the team?",
  ],
  ASK_CALLBACK_NUMBER: [
    "What's the best number to call you back on?",
    "What's a good number for the team to reach you?",
    'What number can we reach you on?',
  ],
  // After the read-back, whose own question is said word for word. Never that
  // question again: the caller heard it, and the eval fails a repeat.
  AWAIT_CONFIRMATION: ['Is all that right?', 'Does that sound right?', 'So, is everything right?', 'Are those details right?'],
  // A hazard found on a later turn gets the advice again, in other words.
  'HANDLE_SAFETY:road': [
    "First, are you safely off the road, away from traffic? If anyone's hurt, call {number} right now.",
    "Are you somewhere safe, away from the traffic? If anyone's been hurt, call {number} straight away.",
  ],
  HANDLE_SAFETY: [
    "First, is everyone okay and off the road? If anyone's hurt or in danger, call {number} right now.",
    'Is everyone somewhere safe? If anyone needs help, call {number} straight away.',
  ],
  // A value is checked once, so one sample each; a new value is a new check
  // and a new sentence.
  'CLARIFY_FIELD:service': ['Sorry, what do you need, {value}?'],
  'CLARIFY_FIELD:location': ['Sorry, where was that, {value}?'],
  'CLARIFY_FIELD:vehicle': ['Sorry, what are you driving, {value}?'],
  'CLARIFY_FIELD:movable:yes': ['Sorry, can it still drive, then?'],
  'CLARIFY_FIELD:movable:no': ["Sorry, so it won't move at all?"],
  'CLARIFY_FIELD:name': ['Sorry, what was your name, {value}?'],
  // Read back, ten digits are easy to mishear twice; said again, they are saved as said.
  'CLARIFY_FIELD:callback_number': ['Sorry, can you say the best number again, slowly?'],
  CLARIFY_FIELD: ['Sorry, did you say {value}?'],
};

/** The sample for `key` at `attempt` (clamped to the last one), with its placeholders filled. Empty for an unknown key. */
export function askPhrasing(key: string, attempt: number, fill: Readonly<Record<string, string>> = {}): string {
  const samples = ASK_PHRASINGS[key];
  if (!samples || samples.length === 0) return '';
  const sample = samples[Math.min(Math.max(0, attempt), samples.length - 1)]!;
  return sample.replace(/\{(\w+)\}/g, (placeholder, name: string) => fill[name] ?? placeholder);
}

/** An instruction in plain words, then the line to say. The line comes last: the model does the last thing it reads. */
function sayIt(instruction: string, key: string, attempt: number, fill: Readonly<Record<string, string>> = {}): string {
  const sample = askPhrasing(key, attempt, fill);
  return sample ? `${instruction} Say it like: "${sample}"` : instruction;
}

/** Each kind of help as it follows "do you need". */
const SPOKEN_HELP: Record<keyof typeof SERVICE_LABEL, string> = {
  tow: 'a tow',
  jump_start: 'a jump start',
  lockout: 'help getting into the car',
  flat_tire: 'help with a flat tire',
  fuel_delivery: 'a fuel delivery',
  winch_out: 'a winch-out',
};

/** "a tow" for "tow"; anything that is not a kind of help by name is said as it was saved. */
function spokenService(service: string): string {
  const bare = service.trim().replace(/^(?:a|an)\s+/i, '').toLowerCase();
  const kind = (Object.keys(SERVICE_LABEL) as Array<keyof typeof SERVICE_LABEL>).find((k) => SERVICE_LABEL[k] === bare);
  return kind ? SPOKEN_HELP[kind] : service.trim();
}

/** "a Honda Civic", "an SUV", "an F-150": the article as it is said, not as it is spelled. */
function withArticle(noun: string): string {
  const bare = noun.trim().replace(/^(?:a|an|the)\s+/i, '');
  const spelledOut = /^[A-Z](?:[A-Z]|[-\d])/.test(bare);
  const vowelSound = spelledOut ? /^[AEFHILMNORSX]/.test(bare) : /^[aeiou]/i.test(bare);
  return `${vowelSound ? 'an' : 'a'} ${bare}`;
}

/** The road in "where on {road}" is a street, rather than a highway or numbered road. */
const STREET_NAME = /\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|circle|cir|terrace|trail|trl|square|sq)\.?$/i;

const ORDER: Topic[] = ['safety', 'service', 'location', 'vehicle', 'movable', 'name', 'callback_number', 'details'];

const TOPIC_OF_REQUIREMENT: Record<RequirementId, Topic> = {
  serviceType: 'service',
  location: 'location',
  vehicle: 'vehicle',
  vehicleMovable: 'movable',
  customerName: 'name',
  customerPhone: 'callback_number',
};

const ASK_ACTION: Record<Exclude<RequirementId, 'customerPhone'>, NextAction> = {
  serviceType: 'ASK_SERVICE_TYPE',
  location: 'ASK_LOCATION',
  vehicle: 'ASK_VEHICLE',
  vehicleMovable: 'ASK_VEHICLE_MOVABLE',
  customerName: 'ASK_CUSTOMER_NAME',
};

export function topicOfSlot(key: SlotKey): Topic | null {
  switch (key) {
    case 'serviceType':
      return 'service';
    case 'location':
      return 'location';
    case 'destination':
      return 'destination';
    case 'vehicleMake':
    case 'vehicleModel':
    case 'vehicleType':
      return 'vehicle';
    case 'vehicleMovable':
    case 'vehicleCondition':
      return 'movable';
    case 'customerName':
      return 'name';
    case 'customerPhone':
      return 'callback_number';
    default:
      return null;
  }
}

const show = (value: unknown) => (typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value));

/**
 * A detail given up on gets one more ask before the read-back, once the
 * caller has answered something asked after it. On a real call the location
 * was asked three times while the caller talked about the weather; the caller
 * then answered every question, and the read-back had no location in it.
 * Due for the whole turn on which it is put, like every other ask.
 */
function lastChanceDue(ctx: ConversationContext, id: Exclude<RequirementId, 'customerPhone'>, turn: number | undefined): boolean {
  const last = ctx.asked?.[ASK_ACTION[id]];
  if (!last) return false;
  if (turn !== undefined && last.turn === turn) return true;
  return REQUIREMENTS.some(
    (r) => r.id !== id && r.id !== 'customerPhone' && r.isSatisfied(ctx.values) && (ctx.asked?.[ASK_ACTION[r.id]]?.turn ?? -1) > last.turn,
  );
}

/** True once the caller has been asked to confirm the read-back on `MAX_CONFIRMATION_WAITS` turns without a yes. */
export function confirmationOverdue(ctx: ConversationContext, turn: number | undefined): boolean {
  const current = ctx.pendingConfirmation?.kind === 'details' && ctx.pendingConfirmation.fieldVersion === (ctx.fieldVersion ?? 0);
  return current && askedBefore(ctx, 'AWAIT_CONFIRMATION', turn) >= MAX_CONFIRMATION_WAITS;
}

/** A location the caller could not narrow down further counts as settled. */
export function locationSettled(ctx: ConversationContext, location: LocationAssessment): boolean {
  if (location.status === 'complete') return true;
  return location.status === 'partial' && (ctx.locationDetailAttempts ?? 0) >= MAX_LOCATION_DETAIL_ATTEMPTS;
}

/**
 * The caller has said what is wrong but not what they want done, and the
 * judge could not tell either. "What kind of help do you need?" has then
 * already failed once; the two likeliest kinds of help are offered instead.
 */
function offerOfHelp(ctx: ConversationContext): Ask | null {
  const judged = ctx.judgments?.service;
  if (!judged || judged.alternatives.length === 0) return null;
  const [first, second] = judged.alternatives;
  const offer = second ? `a ${SERVICE_LABEL[first!]} or a ${SERVICE_LABEL[second]}` : `a ${SERVICE_LABEL[first!]}`;
  return {
    instruction: `They've described the problem ("${judged.text}") but not said what help they want. Don't ask what they need again: ask whether they need ${offer}.`,
    key: 'ASK_SERVICE_TYPE:offer',
    fill: { offer: second ? `${SPOKEN_HELP[first!]}, or ${SPOKEN_HELP[second]}` : SPOKEN_HELP[first!] },
  };
}

/** Which samples a question is said like, and what fills them. */
interface Phrasing {
  key: string;
  fill?: Record<string, string>;
}

/** What to ask, in plain words, and how it is said. */
interface Ask extends Phrasing {
  instruction: string;
}

/**
 * The question for a requirement, in the light of what is saved. "Can it
 * still move, or does it need to be towed?" to a caller who opened with "I
 * need a tow" sounds like not listening; what the dispatcher needs to know
 * then is whether it rolls.
 */
function askFor(id: Exclude<RequirementId, 'customerPhone'>, ctx: ConversationContext): Ask {
  switch (id) {
    case 'serviceType': {
      const offer = offerOfHelp(ctx);
      if (offer) return offer;
      const problem = ctx.values.vehicleCondition;
      return problem
        ? { instruction: `They've said what's wrong ("${problem}") but not what help they want: ask that.`, key: 'ASK_SERVICE_TYPE:problem' }
        : { instruction: "Ask what's happened, or what help they need.", key: 'ASK_SERVICE_TYPE' };
    }
    case 'location':
      return { instruction: 'Ask where they are.', key: 'ASK_LOCATION' };
    case 'vehicle':
      return { instruction: "Ask what they're driving: make and model, or at least the type.", key: 'ASK_VEHICLE' };
    case 'vehicleMovable':
      return /\btow/i.test(ctx.values.serviceType ?? '')
        ? { instruction: 'Ask whether it can roll and steer onto the truck, or is stuck where it is.', key: 'ASK_VEHICLE_MOVABLE:tow' }
        : { instruction: 'Ask whether it can still move, or needs a tow.', key: 'ASK_VEHICLE_MOVABLE' };
    case 'customerName':
      return { instruction: 'Ask their name.', key: 'ASK_CUSTOMER_NAME' };
  }
}

/** The check of a value not clearly heard, said with the value: "Sorry, what are you driving, a Honda Civic?" */
function clarifyPhrasing(unsure: readonly SlotKey[], values: SlotValues): Phrasing {
  const first = unsure[0]!;
  switch (topicOfSlot(first)) {
    case 'service':
      return { key: 'CLARIFY_FIELD:service', fill: { value: spokenService(values.serviceType ?? '') } };
    case 'location':
      return { key: 'CLARIFY_FIELD:location', fill: { value: values.location ?? '' } };
    case 'vehicle': {
      const named = unsure.includes('vehicleMake') || unsure.includes('vehicleModel');
      const vehicle = named ? [values.vehicleMake, values.vehicleModel].filter(Boolean).join(' ') : (values.vehicleType ?? '');
      return { key: 'CLARIFY_FIELD:vehicle', fill: { value: withArticle(vehicle) } };
    }
    case 'movable':
      if (unsure.includes('vehicleMovable') && typeof values.vehicleMovable === 'boolean') {
        return { key: `CLARIFY_FIELD:movable:${values.vehicleMovable ? 'yes' : 'no'}` };
      }
      break;
    case 'name':
      return { key: 'CLARIFY_FIELD:name', fill: { value: values.customerName ?? '' } };
    case 'callback_number':
      return { key: 'CLARIFY_FIELD:callback_number' };
  }
  return { key: 'CLARIFY_FIELD', fill: { value: show(values[first]) } };
}

/** What is saved, in short, for the reasons on a plan. */
function savedFacts(ctx: ConversationContext): string {
  return (Object.entries(ctx.values) as Array<[SlotKey, unknown]>)
    .filter(([key, value]) => value !== undefined && value !== null && value !== '' && key !== 'location')
    .map(([key, value]) => `${key}=${show(value)}${ctx.fieldSources?.[key] && ctx.fieldSources[key] !== 'stated' ? ` (${ctx.fieldSources[key]})` : ''}`)
    .join(', ');
}

export function readBack(ctx: ConversationContext): SummaryLine[] {
  const lines = buildSummary(ctx.values);
  if (ctx.values.customerPhone) lines.push({ label: 'Callback number', value: ctx.values.customerPhone });
  return lines;
}

export function determineNextAction(ctx: ConversationContext, options: NextActionOptions = {}): NextActionPlan {
  const location = assessLocation(ctx, { knownAreas: options.knownAreas });

  const known = new Set<Topic>();
  for (const requirement of REQUIREMENTS) {
    if (requirement.id === 'customerPhone') continue;
    if (!requirement.isSatisfied(ctx.values)) continue;
    if (requirement.id === 'location' && !locationSettled(ctx, location)) continue;
    known.add(TOPIC_OF_REQUIREMENT[requirement.id]);
  }
  if (ctx.phoneConfirmed) known.add('callback_number');

  // What stood when the decision was made; the deciding reason goes in front.
  const facts: string[] = [];
  const saved = savedFacts(ctx);
  if (saved) facts.push(`saved: ${saved}`);
  if (ctx.values.location && location.status !== 'missing') {
    facts.push(
      `location "${ctx.values.location}": ${location.status}, ${location.reason}, detail asked ${ctx.locationDetailAttempts ?? 0}/${MAX_LOCATION_DETAIL_ATTEMPTS}`,
    );
  }

  const plan = (
    action: NextAction,
    topic: Topic | null,
    ask: string,
    why: string,
    extra: Partial<NextActionPlan> = {},
  ): NextActionPlan => {
    const later = topic ? ORDER.slice(ORDER.indexOf(topic) + 1).filter((t) => t !== 'details') : [];
    // At the read-back everything needed is known, so none of it is asked
    // again: once the backend takes a yes to the number itself, a reply
    // already asking "is this the best number?" is stopped.
    const doNotAsk =
      topic === 'details'
        ? [...new Set<Topic>([...known, 'destination'])]
        : [...new Set<Topic>([...later, ...known, 'destination'])].filter((t) => t !== topic);
    return { action, topic, ask, doNotAsk, location, because: [why, ...facts], settled: [...known], ...extra };
  };

  if (ctx.state === ConversationState.ENDED) {
    return {
      action: 'CLOSE',
      topic: null,
      ask: CLOSE_ASK,
      doNotAsk: [...ORDER, 'destination'],
      location,
      because: ['the call has ended', ...facts],
      settled: [...ORDER],
    };
  }

  const turn = options.callerTurn;
  if (ctx.safety && ctx.safety.issuedAtTurn !== null && ctx.safety.issuedAtTurn !== turn) {
    facts.push(`safety advice for ${ctx.safety.hazard} given on turn ${ctx.safety.issuedAtTurn}`);
  }

  // Due for the whole caller turn on which it was issued, like every other
  // ask. It is issued when a plan is delivered, and the plan delivered before
  // the caller's words are saved is followed by another from the save: on
  // that second plan the intake moved on to the vehicle, and the advice was
  // never given, while the lead said it had been.
  const safetyDue = ctx.safety && (ctx.safety.issuedAtTurn === null || (turn !== undefined && ctx.safety.issuedAtTurn === turn));
  if (ctx.safety && safetyDue) {
    const number = options.emergencyNumber ?? 'emergency services';
    const attempt = askedBefore(ctx, 'HANDLE_SAFETY', turn);
    // A shoulder stop on a highway is the common case, and gets a short line;
    // a crash, an injury, fire or a live lane gets the full one.
    const ask =
      ctx.safety.hazard === HIGH_SPEED_ROAD_HAZARD
        ? sayIt(
            `They're stopped on a high-speed road. Before anything else, briefly check they're off the road and away from traffic, and say to call ${number} right now if anyone's hurt.`,
            'HANDLE_SAFETY:road',
            attempt,
            { number },
          )
        : sayIt(
            `They may be in danger (${ctx.safety.hazard}). Before anything else, check everyone is safe and off the road, and tell them to call ${number} right now if anyone's hurt or in danger.`,
            'HANDLE_SAFETY',
            attempt,
            { number },
          );
    const due = ctx.safety.issuedAtTurn === null ? 'safety advice not given yet' : `safety advice due this turn (${turn})`;
    return plan('HANDLE_SAFETY', 'safety', ask, `${ctx.safety.hazard}: ${due}`);
  }
  // Checked with the caller once. After that the value stands, marked on the
  // lead as not clearly heard, unless the caller gives another.
  const unsure = (Object.entries(ctx.fieldSources ?? {}) as Array<[SlotKey, string]>)
    .filter(([key, source]) => source === 'unsure' && ctx.values[key] !== undefined)
    .map(([key]) => key)
    .filter((key) => askedBefore(ctx, `CLARIFY_FIELD:${key}=${String(ctx.values[key])}`, turn) < MAX_CLARIFICATIONS);
  if (unsure.length > 0) {
    const check = clarifyPhrasing(unsure, ctx.values);
    return plan(
      'CLARIFY_FIELD',
      topicOfSlot(unsure[0]!),
      sayIt(
        `You weren't sure you heard ${unsure.map((k) => `${SLOT_DEFS[k].label} "${show(ctx.values[k])}"`).join(', ')} right. Check it with them once: on a yes, save it again without unsureFields; if they say something else, save that.`,
        check.key,
        0,
        check.fill,
      ),
      `not sure it heard ${unsure.map((k) => `${k} "${show(ctx.values[k])}"`).join(', ')} right; not checked with the caller yet`,
      { clarify: unsure },
    );
  }

  let lastChance: Requirement | null = null;
  for (const requirement of [...REQUIREMENTS].filter((r) => r.required).sort((a, b) => a.order - b.order)) {
    if (requirement.id === 'customerPhone') continue;
    if (!requirement.isSatisfied(ctx.values)) {
      const times = askedBefore(ctx, ASK_ACTION[requirement.id], turn);
      // Asked on three turns and still not had: move on. The towing team
      // gets it when they call, unless the caller, answering again, gives it
      // when asked once more before the read-back.
      if (times >= MAX_ASKS) {
        known.add(TOPIC_OF_REQUIREMENT[requirement.id]);
        if (times === MAX_ASKS && lastChanceDue(ctx, requirement.id, turn)) {
          lastChance ??= requirement;
          facts.push(`${requirement.id} asked ${MAX_ASKS} times without an answer; the caller has answered since, so asked once more before the read-back`);
        } else {
          facts.push(`${requirement.id} asked ${MAX_ASKS} times without an answer: left for the towing team`);
        }
        continue;
      }
      const question = askFor(requirement.id, ctx);
      const offered = question.key === 'ASK_SERVICE_TYPE:offer';
      const ask = `${times > 0 ? ASK_AGAIN : ''}${sayIt(question.instruction, question.key, times, question.fill)}`;
      const why = `${requirement.id} missing${times > 0 ? `, asked ${times}/${MAX_ASKS} already` : ''}${offered ? '; what help they want is unclear, so the likeliest are offered' : ''}`;
      return plan(ASK_ACTION[requirement.id], TOPIC_OF_REQUIREMENT[requirement.id], ask, why);
    }
    if (requirement.id === 'location' && !locationSettled(ctx, location)) {
      const road = location.road;
      const where = road ? ` on ${road}` : '';
      const key = !road ? 'ASK_LOCATION_DETAIL' : STREET_NAME.test(road) ? 'ASK_LOCATION_DETAIL:street' : 'ASK_LOCATION_DETAIL:highway';
      return plan(
        'ASK_LOCATION_DETAIL',
        'location',
        sayIt(
          `"${ctx.values.location}" is too vague for a driver to find. Ask where exactly${where}.`,
          key,
          askedBefore(ctx, 'ASK_LOCATION_DETAIL', turn),
          road ? { road } : {},
        ),
        `location "${ctx.values.location}" not precise enough to drive to (${location.reason}); detail asked ${ctx.locationDetailAttempts ?? 0}/${MAX_LOCATION_DETAIL_ATTEMPTS}`,
      );
    }
  }

  if (lastChance) {
    const id = lastChance.id as Exclude<RequirementId, 'customerPhone'>;
    const topic = TOPIC_OF_REQUIREMENT[id];
    const question = askFor(id, ctx);
    return plan(
      ASK_ACTION[id],
      topic,
      `${LAST_TRY}${sayIt(question.instruction, question.key, LAST_CHANCE_ATTEMPT, question.fill)}`,
      `${id} missing, asked ${MAX_ASKS}/${MAX_ASKS} already; one last try before the read-back, as the caller has answered since`,
      { settled: [...known].filter((t) => t !== topic) },
    );
  }

  const numberAction = ctx.phoneNeedsCollection || !ctx.values.customerPhone ? 'ASK_CALLBACK_NUMBER' : 'CONFIRM_CALLBACK_NUMBER';
  // Asked three times with no answer: the number they called from stands, unconfirmed, and the lead says so.
  const numberGivenUp = askedBefore(ctx, numberAction, turn) >= MAX_ASKS;
  if (numberGivenUp) {
    known.add('callback_number');
    if (!ctx.phoneConfirmed) facts.push(`callback number asked ${MAX_ASKS} times without a clear answer: the caller ID stands, unconfirmed`);
  }
  if (!ctx.phoneConfirmed && !numberGivenUp) {
    const source = ctx.phoneNeedsCollection ? 'the caller said not this number' : !ctx.values.customerPhone ? 'no number saved' : 'only the caller ID number, not confirmed';
    const timesAsked = askedBefore(ctx, numberAction, turn);
    const numberWhy = `everything before the number is settled; ${source}${timesAsked > 0 ? `, asked ${timesAsked}/${MAX_ASKS} already` : ''}`;
    if (numberAction === 'ASK_CALLBACK_NUMBER') {
      const ask =
        timesAsked > 0
          ? 'You asked for the best number to reach them. If they gave one: call update_call_information with it in customerPhone. Only if they did not: ask again.'
          : 'Ask for the best number to call them back on.';
      return plan('ASK_CALLBACK_NUMBER', 'callback_number', sayIt(ask, 'ASK_CALLBACK_NUMBER', timesAsked), numberWhy);
    }
    // The number is not read out: a person says "the number you're calling
    // from", and the caller knows their own number. Asked again, the model is
    // told what the answer means: on a real call it heard "Yes." three times,
    // saved nothing, and asked again each time. The line to ask again with
    // comes after "only if they did not answer", so it is only for that.
    const ask =
      timesAsked > 0
        ? "You asked whether the number they're calling from is the best one. If they said yes: call update_call_information with callerIdConfirmed true and nothing else. If they said no, or gave another number: call update_call_information with callerIdConfirmed false, and the number in customerPhone if they gave one. Do not read the number out. Only if they did not answer: ask again."
        : "Ask whether the number they're calling from is the best one to reach them. Do not read the number out.";
    return plan('CONFIRM_CALLBACK_NUMBER', 'callback_number', sayIt(ask, 'CONFIRM_CALLBACK_NUMBER', timesAsked), numberWhy);
  }

  const summary = readBack(ctx);
  const confirmationCurrent =
    ctx.pendingConfirmation?.kind === 'details' && ctx.pendingConfirmation.fieldVersion === (ctx.fieldVersion ?? 0);
  if (confirmationCurrent) {
    const pending = ctx.pendingConfirmation!;
    const thenConfirm = 'Only on a clear yes, call complete_request with callerConfirmed true; if they correct something, save it first.';

    // The caller spoke over the read-back. What they said is answered first;
    // then they hear the details once, since they have not heard them all.
    const cut =
      pending.cutAfter !== undefined &&
      (pending.resumeTurn === undefined || options.callerTurn === undefined || pending.resumeTurn === options.callerTurn);
    if (cut) {
      const heard = pending.cutAfter ? `they heard only: "${pending.cutAfter}"` : 'they heard none of it';
      return plan(
        'AWAIT_CONFIRMATION',
        'details',
        `They spoke over the read-back; ${heard}. Answer what they said first, in one short sentence, then finish the read-back from where they stopped hearing it; don't start it again from the beginning. ${thenConfirm}`,
        `the caller spoke over the read-back; ${heard}, so it is finished this turn`,
        { summary },
      );
    }

    // Put on this very turn: the caller has not heard it yet. Told "they have
    // heard the details, do not read them again", the model would never read them.
    if (pending.cutAfter === undefined && options.callerTurn !== undefined && options.callerTurn === pending.callerTurn) {
      return plan(
        'CONFIRM_DETAILS',
        'details',
        READ_BACK_ASK,
        'the read-back was put on this turn and the caller has not answered it yet',
        { summary },
      );
    }

    // No summary: on a real call the details were in front of the model on
    // every turn of the wait, and it read them out three times while the
    // caller asked what it would cost. The line to ask with is not the
    // read-back's own question: the caller has heard that once, and the eval
    // fails a sentence said twice.
    const waited = askedBefore(ctx, 'AWAIT_CONFIRMATION', turn);
    return plan(
      'AWAIT_CONFIRMATION',
      'details',
      sayIt(
        "They've heard the details. Do NOT read them out again unless they ask to hear them (get them with get_call_state). If they asked or said something else, answer that first, in one short sentence. " +
          `${thenConfirm} If they haven't answered yet, ask once whether the details are right.`,
        'AWAIT_CONFIRMATION',
        waited,
      ),
      `details read back on turn ${pending.callerTurn}; waiting for a clear yes, asked ${waited}/${MAX_CONFIRMATION_WAITS} times`,
    );
  }

  return plan(
    'CONFIRM_DETAILS',
    'details',
    READ_BACK_ASK,
    ctx.pendingConfirmation?.kind === 'details'
      ? 'the details changed since they were read back, so they are read back again'
      : 'everything required is saved and the callback number is settled',
    { summary },
  );
}
