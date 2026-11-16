/**
 * Benchmark scenarios. Each is a scripted caller plus what must be true
 * afterwards. `targeted` scenarios cover the behaviour this work fixes and
 * get more runs; the rest guard against regressions.
 */

import type { SlotKey } from '@towai/shared';

import type { LocationStatus } from '../../../conversation/location';
import type { NextAction, Topic } from '../../../conversation/next-action';

export interface TurnExpectation {
  /** 1-based caller line the reply follows. */
  turn: number;
  /** The reply must ask about one of these (or give safety advice, if allowed). */
  ask?: Topic[];
  allowSafety?: boolean;
  /** The reply must not ask about any of these. */
  forbid?: Topic[];
  /** The backend's next action after this turn must be one of these. */
  action?: NextAction[];
  /** The reply must not say it did not understand. */
  understood?: boolean;
  /** The reply must match this, e.g. an acknowledgement. */
  mention?: RegExp;
  /** The reply must not match this, e.g. an answer already given, or details already read out. */
  notMention?: RegExp;
  /**
   * The caller said something a person would reply to (a question, a
   * complaint, a line cut off): the reply must match this, and before any
   * intake question. Scored as IGNORED_CALLER. On the call of 12 October
   * (6d1304af) every such line got the next intake question instead, and
   * `mention` alone would have passed a reply that said the right word after it.
   */
  needsReply?: RegExp;
  /** The reply must ask no intake question at all, e.g. when the caller was cut off mid-sentence. Scored as IGNORED_CALLER. */
  noIntakeQuestion?: boolean;
  /** The reply must open with a short acknowledgement ("Okay.", "Got it.") or the caller's own word ("A Civic, got it."). */
  startsWithAck?: boolean;
}

export interface Scenario {
  name: string;
  group: 'priority' | 'multi' | 'specificity' | 'interruption' | 'confirmation' | 'safety' | 'notes' | 'conversation';
  targeted: boolean;
  what: string;
  lines: string[];
  turns?: TurnExpectation[];
  /** Saved values that must be present at the end. */
  fields?: Partial<Record<SlotKey, RegExp | boolean>>;
  /** Values that must keep the caller's specificity. */
  specific?: Partial<Record<SlotKey, { want: RegExp; generic: RegExp }>>;
  locationStatus?: LocationStatus;
  /** The lead must (or must not) exist at the end. */
  leadCreated?: boolean;
  /** The caller never answered a callback-number question. */
  phoneNotConfirmed?: boolean;
  /** Safety advice must be given by this caller turn. */
  safetyBy?: number;
  urgencyHigh?: boolean;
  /** A make the caller never said must be tagged inferred. */
  inferredMake?: boolean;
  /** A detail from garbled speech must not be accepted silently. */
  garbledField?: SlotKey;
}

const LOWER_THAN_LOCATION: Topic[] = ['callback_number', 'name', 'vehicle', 'movable', 'destination'];

// What a reply must say to each caller line in the conversation group. Each
// is wide on wording, since any natural answer will do; `needsReply` also
// requires it before any intake question, so a reply that only mirrors a
// word inside "Where's the car right now?" does not pass. The scorer makes
// curly apostrophes plain first, so "can't" here matches either.

/** "What have I already given you?" after "I need a tow": the tow, or the number they are calling from. */
const SAYS_WHAT_IS_SAVED = /\btow(?:ing)?\b(?!\s+truck)|\byour (?:phone |callback )?number\b|\bcalling from\b/i;
/** A caller cut off mid-sentence is asked to finish. */
const ASKS_TO_FINISH =
  /\b(?:try to what|try what|go on|go ahead|finish|say that again|repeat that|(?:catch|get|hear) the (?:end|rest)|the (?:end|rest) of (?:that|it|what)|cut off|you were saying|keep going|carry on|what happens if)\b/i;
const APOLOGISES = /\bsorry\b|\bapolog/i;
/** "Are you capable of helping me?" gets a yes. "I can't" is not one. */
const SAYS_YES = /\b(?:yes|yeah|yep|yup|sure|of course|absolutely|definitely|certainly)\b|\b(?:i|we) can\b(?!'t)|\b(?:happy|glad) to\b/i;
/** "How's it going?" answered like a person. */
const ANSWERS_SMALL_TALK = /\b(?:good|great|fine|not bad|doing|going (?:well|good|great|fine)|thanks|thank you|can'?t complain)\b/i;
const ANSWERS_CARDS = /\bcards?\b|\bpay(?:ment|ing)?\b|\bnot sure\b|\bdon'?t know\b|\bcan'?t (?:say|confirm)\b/i;
const ANSWERS_PRICE = /\b(?:price|pricing|cost|quote|charge)\b/i;
const ANSWERS_ETA = /\b(?:time|estimate|eta|arrival|how long)\b/i;

export const SCENARIOS: Scenario[] = [
  // ---- Priority -----------------------------------------------------------
  {
    name: 'partial-location-before-phone',
    group: 'priority',
    targeted: true,
    what: 'Name + semi + "I-95": narrow the location down before anything lower',
    lines: ['I need a tow. My name is Mike and my semi truck broke down on I-95.'],
    turns: [{ turn: 1, ask: ['location'], allowSafety: true, forbid: LOWER_THAN_LOCATION, action: ['HANDLE_SAFETY', 'ASK_LOCATION_DETAIL'] }],
    fields: { customerName: /mike/i, location: /95/ },
    specific: { vehicleType: { want: /semi/i, generic: /^\s*(truck|vehicle)\s*$/i } },
    locationStatus: 'partial',
  },
  {
    name: 'partial-location-before-destination',
    group: 'priority',
    targeted: true,
    what: 'Destination given with "Highway 10": do not ask about the destination, narrow the location',
    lines: ["I need a tow for my pickup truck. It's on Highway 10 and I want it taken to Joe's Garage."],
    turns: [{ turn: 1, ask: ['location'], allowSafety: true, forbid: LOWER_THAN_LOCATION, action: ['HANDLE_SAFETY', 'ASK_LOCATION_DETAIL'] }],
    fields: { location: /highway 10/i, destination: /joe/i },
    locationStatus: 'partial',
  },
  {
    name: 'partial-location-before-vehicle-condition',
    group: 'priority',
    targeted: true,
    what: '"The interstate": narrow the location before asking if the truck can move',
    lines: ['I need a tow, my box truck broke down on the interstate.'],
    turns: [{ turn: 1, ask: ['location'], allowSafety: true, forbid: LOWER_THAN_LOCATION, action: ['HANDLE_SAFETY', 'ASK_LOCATION_DETAIL'] }],
    locationStatus: 'partial',
  },
  {
    name: 'missing-location',
    group: 'priority',
    targeted: true,
    what: 'No location at all: ask where the vehicle is first',
    lines: ['I need a tow for my 18-wheeler.'],
    turns: [{ turn: 1, ask: ['location'], forbid: LOWER_THAN_LOCATION, action: ['ASK_LOCATION'] }],
    specific: { vehicleType: { want: /18[- ]?wheel/i, generic: /^\s*(truck|vehicle|semi)\s*$/i } },
  },
  {
    name: 'missing-name',
    group: 'priority',
    targeted: false,
    what: 'Everything but the name: ask the name (after safety)',
    // What is wrong is asked for since the 13 Nov calls; "it won't move" alone does not say it.
    lines: ["I need a tow. My pickup truck broke down at exit 42 on I-95 and it won't move."],
    turns: [{ turn: 1, ask: ['name'], allowSafety: true, forbid: ['callback_number', 'location', 'vehicle', 'movable'], action: ['HANDLE_SAFETY', 'ASK_CUSTOMER_NAME'] }],
    locationStatus: 'complete',
  },
  {
    name: 'missing-vehicle',
    group: 'priority',
    targeted: false,
    what: 'Name and a full address: ask about the vehicle',
    lines: ["I need a tow, my name is Sarah, I'm at 123 Main Street."],
    turns: [{ turn: 1, ask: ['vehicle'], forbid: ['callback_number', 'name', 'location'], action: ['ASK_VEHICLE'] }],
    fields: { customerName: /sarah/i },
    locationStatus: 'complete',
  },

  // ---- Multi-information --------------------------------------------------
  {
    name: 'multi-service-vehicle-location',
    group: 'multi',
    targeted: false,
    what: 'Service, vehicle and a landmark in one sentence are all saved',
    lines: ['I need a jump start for my SUV in the Walmart parking lot on Preston Road.'],
    fields: { serviceType: /jump/i, vehicleType: /suv/i, location: /walmart/i },
    locationStatus: 'complete',
  },
  {
    name: 'multi-vehicle-condition-location',
    group: 'multi',
    targeted: false,
    what: 'Make, model, condition and address in one sentence are all saved',
    lines: ['My Honda Civic has a flat tire at 123 Main Street, I need a tow.'],
    fields: { vehicleMake: /honda/i, vehicleModel: /civic/i, vehicleCondition: /flat tire/i, location: /123 main/i },
  },
  {
    name: 'multi-everything',
    group: 'multi',
    targeted: false,
    what: 'Name, service, vehicle, precise location and movability in one breath',
    lines: ["Hi, I'm Mike, I need a tow, my semi truck broke down at mile marker 118 on I-95 and it can't move."],
    fields: { customerName: /mike/i, serviceType: /tow/i, location: /118/, vehicleMovable: false },
    specific: { vehicleType: { want: /semi/i, generic: /^\s*(truck|vehicle)\s*$/i } },
    phoneNotConfirmed: true,
  },

  // ---- Specificity --------------------------------------------------------
  {
    name: 'specificity-semi-truck',
    group: 'specificity',
    targeted: true,
    what: '"semi truck" stays "semi truck"',
    lines: ['I need a tow for my semi truck at exit 42 on I-95.'],
    specific: { vehicleType: { want: /semi/i, generic: /^\s*(truck|vehicle)\s*$/i } },
  },
  {
    name: 'specificity-18-wheeler',
    group: 'specificity',
    targeted: true,
    what: '"18-wheeler" stays "18-wheeler"',
    lines: ['My 18-wheeler needs a tow, it is at mile marker 30 on I-40.'],
    specific: { vehicleType: { want: /18[- ]?wheel/i, generic: /^\s*(truck|vehicle|semi)\s*$/i } },
  },
  {
    name: 'specificity-box-truck',
    group: 'specificity',
    targeted: false,
    what: '"box truck" stays "box truck"',
    lines: ['I need a tow for a box truck at 500 Elm Street.'],
    specific: { vehicleType: { want: /box/i, generic: /^\s*(truck|vehicle)\s*$/i } },
  },
  {
    name: 'specificity-pickup-truck',
    group: 'specificity',
    targeted: false,
    what: '"pickup truck" stays "pickup truck"',
    lines: ['My pickup truck needs a tow from the Shell station on Highway 10.'],
    specific: { vehicleType: { want: /pick-?up/i, generic: /^\s*(truck|vehicle)\s*$/i } },
  },

  // ---- Interruptions ------------------------------------------------------
  {
    name: 'hello',
    group: 'interruption',
    targeted: false,
    what: 'A bare "Hello?" gets a natural acknowledgement',
    lines: ['Hello?'],
    turns: [{ turn: 1, understood: true, mention: /\b(hear|here|help|hi|hello)\b/i }],
  },
  {
    name: 'can-you-hear-me',
    group: 'interruption',
    targeted: false,
    what: 'A connection check mid-intake is answered, not treated as a wrong answer',
    lines: ['I need a tow for my car.', 'Hello? Can you hear me?'],
    turns: [{ turn: 2, understood: true, mention: /\b(hear|here)\b/i }],
  },
  {
    name: 'small-talk',
    group: 'interruption',
    targeted: false,
    what: '"How are you?" gets a brief natural answer',
    lines: ['Hi, how are you doing today?'],
    turns: [{ turn: 1, understood: true }],
  },
  {
    name: 'mid-intake-interruption',
    group: 'interruption',
    targeted: false,
    what: 'A caller stepping away mid-intake is acknowledged, then intake resumes',
    lines: ['I need a tow for my car.', "Sorry, one second, my kid is talking to me. Okay, I'm back."],
    turns: [{ turn: 2, understood: true, forbid: ['service'] }],
  },

  // ---- Questions from the caller ------------------------------------------
  // From the real call of 29 September 2026: a question got the details read
  // out three times, or "Is that all correct?", and then a second answer.
  {
    name: 'question-mid-intake',
    group: 'interruption',
    targeted: true,
    what: '"How soon?" is answered at once with what happens next, then the intake resumes',
    lines: ['I need a tow for my car.', 'How soon can you get someone here?'],
    turns: [{ turn: 2, understood: true, mention: /\bestimate\b|call you/i, ask: ['location'], forbid: ['service'] }],
    fields: { serviceType: /tow/i },
  },
  {
    name: 'question-answered-once',
    group: 'interruption',
    targeted: true,
    what: 'A question that has been answered is not answered again on the next turn',
    lines: ['I need a tow for my car.', 'How much is this going to cost me?', "It's at 123 Main Street."],
    turns: [
      { turn: 2, understood: true, mention: /\bprice\b/i },
      { turn: 3, notMention: /\b(?:price|cost|estimate)\b/i, ask: ['vehicle'], forbid: ['service', 'location'] },
    ],
    fields: { location: /123 main/i },
  },
  {
    name: 'question-after-read-back',
    group: 'interruption',
    targeted: true,
    what: 'A question after the read-back is answered without reading the details out again, and "yes" completes',
    // Every detail in the first line, what is wrong included, so the number question comes next.
    lines: [
      "I need a tow, I'm Mike, my pickup truck broke down at 123 Main Street and it can't move.",
      'Yes, this number is the best one.',
      'How much will it cost me?',
      "Yes, that's all correct.",
    ],
    turns: [
      { turn: 3, understood: true, mention: /\bprice\b/i, notMention: /your name is|the vehicle is at/i },
      { turn: 4, notMention: /\b(?:price|cost)\b/i },
    ],
    leadCreated: true,
  },
  {
    name: 'breakdown-means-tow',
    group: 'interruption',
    targeted: true,
    what: '"I broke down" is a request for a tow, not a reason to ask what help is needed',
    lines: ['Hi, I broke down.'],
    turns: [{ turn: 1, understood: true, forbid: ['service'] }],
    fields: { serviceType: /tow/i },
  },

  // ---- Confirmation -------------------------------------------------------
  {
    name: 'read-back-waits-for-yes',
    group: 'confirmation',
    targeted: true,
    what: 'The lead is only created after the caller confirms the read-back',
    // Every detail in the first line, what is wrong included, so the safety check and the number come next.
    lines: [
      "I need a tow, I'm Mike, my semi truck broke down at exit 42 on I-95 and it can't move.",
      "Yes, we're safe, we're off the road.",
      'Yes, this number is the best one.',
      "Yes, that's all correct.",
    ],
    leadCreated: true,
  },
  {
    name: 'no-self-confirmed-callback-number',
    group: 'confirmation',
    targeted: true,
    what: 'The callback number is not marked confirmed until the caller answers',
    lines: ["I need a tow, I'm Mike, my semi truck is at exit 42 on I-95 and it can't move."],
    phoneNotConfirmed: true,
  },

  // ---- Safety -------------------------------------------------------------
  {
    name: 'highway-safety-advice',
    group: 'safety',
    targeted: true,
    what: 'A highway breakdown gets 911 advice first',
    lines: ["My car broke down on I-85, I'm on the shoulder."],
    safetyBy: 1,
  },
  {
    name: 'accident-safety-advice',
    group: 'safety',
    targeted: false,
    what: 'An accident gets 911 advice first',
    lines: ["I was in an accident at Main Street and Elm, the car's smashed up."],
    safetyBy: 1,
  },

  // ---- Notes, urgency, provenance -----------------------------------------
  {
    name: 'urgent-blowout',
    group: 'notes',
    targeted: true,
    what: '"Immediately" makes it urgent; "blowout" is kept verbatim; an inferred make is tagged',
    lines: ['I need a tow immediately, my Mustang had a blowout at exit 12 on I-85.'],
    fields: { vehicleCondition: /blowout/i },
    urgencyHigh: true,
    inferredMake: true,
  },
  {
    name: 'garbled-answer',
    group: 'notes',
    targeted: false,
    what: 'A garbled answer about movability is checked, not guessed',
    // What is wrong in the first line, so the garbled line answers whether it moves, as it did before that was asked.
    lines: ['I need a tow for my Mustang, it broke down at exit 12 on I-85, my name is Michael.', "Yes, I'm safe.", 'It needs to be dot ES.'],
    garbledField: 'vehicleMovable',
  },

  // ---- Conversation -------------------------------------------------------
  // From the real call of 12 October 2026 (6d1304af, 102 s, abandoned): the
  // caller asked if the receptionist could help, was cut off mid-sentence,
  // complained, and twice asked what they had already said. Every one of those
  // lines got the next intake question, and nothing in the eval noticed: a
  // reply that ignores the caller passed unless a `mention` happened to catch it.
  {
    name: 'meta-what-do-you-have',
    group: 'conversation',
    targeted: true,
    what: '"What have I already given you?" is answered from what is saved, before the next question',
    // Turns 6 and 7 of 6d1304af, word for word: both got "Could you tell me ...".
    lines: ['I need a tow.', 'What kind of information have I already given you?'],
    turns: [{ turn: 2, understood: true, needsReply: SAYS_WHAT_IS_SAVED }],
  },
  {
    name: 'cut-off-mid-sentence',
    group: 'conversation',
    targeted: true,
    what: 'A caller cut off mid-sentence is asked to finish, not asked the next question',
    // Turn 4 of 6d1304af, word for word: it got "Where is the vehicle right now?".
    lines: ['I need a tow for my car.', 'Okay, so what happens if we try to'],
    turns: [{ turn: 2, needsReply: ASKS_TO_FINISH, noIntakeQuestion: true }],
  },
  {
    name: 'complaint-asked-something-else',
    group: 'conversation',
    targeted: true,
    what: '"I asked you something else." gets an apology before anything is asked',
    // Turn 5 of 6d1304af, word for word: it got "Could you describe the location?".
    lines: ['I need a tow for my car.', 'Do you take credit cards?', 'I asked you something else.'],
    turns: [
      { turn: 2, understood: true, needsReply: ANSWERS_CARDS },
      { turn: 3, understood: true, needsReply: APOLOGISES },
    ],
  },
  {
    name: 'capable-of-helping',
    group: 'conversation',
    targeted: true,
    what: '"Are you capable of helping me?" gets a yes before the first question',
    // Turn 2 of 6d1304af was answered ("I can help"), but nothing checked that it would be.
    lines: ['Are you capable of helping me?'],
    turns: [{ turn: 1, understood: true, needsReply: SAYS_YES }],
  },
  {
    name: 'ack-then-ask',
    group: 'conversation',
    targeted: true,
    what: 'A detail is acknowledged in a word or two, then the next question is asked',
    // A person says "Okay." or "A Civic, got it." first; on 6d1304af replies started cold.
    lines: ["My Honda Civic won't start, I need a jump start."],
    turns: [{ turn: 1, startsWithAck: true, ask: ['location'], forbid: LOWER_THAN_LOCATION }],
  },
  {
    name: 'small-talk-then-detail',
    group: 'conversation',
    targeted: true,
    what: '"How\'s it going?" is answered like a person, and the detail that follows is saved',
    lines: ["How's it going?", 'My Civic died at 5th and Main.'],
    turns: [
      { turn: 1, understood: true, needsReply: ANSWERS_SMALL_TALK },
      { turn: 2, forbid: ['vehicle'] },
    ],
    fields: { vehicleModel: /civic/i, location: /5th|fifth/i },
  },
  {
    name: 'two-questions-in-a-row',
    group: 'conversation',
    targeted: true,
    what: 'The price and then the arrival time are each answered once, and the location is still asked',
    lines: ['I need a tow for my car.', 'How much is this going to cost?', 'And how long until someone gets here?'],
    turns: [
      { turn: 2, understood: true, needsReply: ANSWERS_PRICE, ask: ['location'], forbid: LOWER_THAN_LOCATION },
      {
        turn: 3,
        understood: true,
        needsReply: ANSWERS_ETA,
        notMention: /\b(?:price|pricing|cost)\b/i,
        ask: ['location'],
        forbid: LOWER_THAN_LOCATION,
      },
    ],
  },
  {
    name: 'one-answer-at-a-time',
    group: 'conversation',
    targeted: true,
    what: 'A caller who answers one question at a time: each answer is saved, and the next question comes with it',
    // The shape of most real calls, and the one no other scenario has: a
    // detail per turn. The vehicle and the name each have their next question
    // named before the save, so the save and the question are one reply.
    lines: ["I need a tow, I'm at 123 Main Street.", "It's a Honda Civic.", "It won't start.", "It's Sarah.", 'Yes, this number is fine.'],
    turns: [
      { turn: 1, ask: ['vehicle'], forbid: ['name', 'callback_number'] },
      { turn: 2, startsWithAck: true, ask: ['condition', 'service'], forbid: ['name', 'callback_number', 'location'] },
      { turn: 3, ask: ['name'], forbid: ['callback_number', 'location', 'vehicle'] },
      { turn: 4, ask: ['callback_number'], forbid: ['location', 'vehicle', 'name'] },
    ],
    fields: { vehicleMake: /honda/i, vehicleModel: /civic/i, vehicleCondition: /start/i, customerName: /sarah/i },
    locationStatus: 'complete',
  },
];
