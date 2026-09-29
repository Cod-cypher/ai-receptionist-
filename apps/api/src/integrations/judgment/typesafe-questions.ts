/**
 * Every question the receptionist asks TypeSafe's Jev model, and the
 * thresholds that decide when an answer is acted on.
 *
 * One file on purpose, so a person can read and change every judgment in
 * one sitting. The engine keeps deciding what happens next; Jev supplies the
 * two judgments that regex rules got wrong on real calls: whether a location
 * is precise enough to dispatch to, and whether the caller is in danger.
 *
 * Question IDs are for code. The model sees only the instructions, the
 * criteria and the state, so each question must carry its whole meaning.
 * The names in backticks are fields of the state object sent with it.
 */

import { choice, noul, score } from '@typesafe-ai/sdk';

import type { CallerMove, HazardChoice, QuestionTopic, ServiceChoice } from './judgment.interface';

/* -------------------------------------------------------------------------- */
/*  Thresholds                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Below this, Jev's read on the location is ignored and the rules decide.
 * Asking a stranded caller "where exactly?" once more is a low-stakes
 * mistake, so the floor is modest.
 */
export const LOCATION_CONFIDENCE_FLOOR = 0.6;

/**
 * The probability that the people there are in some danger (one minus the
 * probability of "none") at or above which the safety step is taken, with
 * the most likely kind of danger as its reason. Gated on the whole rather
 * than on one kind, because "we crashed and my friend is hurt" splits the
 * probability between two true answers. A false alarm makes the receptionist
 * give safety advice nobody needed, and the regex rules still catch the plain
 * cases, so this is set higher than the location floor.
 */
export const DANGER_FLOOR = 0.7;

/** Probability of "yes" at or above which the caller counts as urgent. */
export const URGENT_FLOOR = 0.7;

/**
 * A read-back or callback-number question counts as confirmed only when the
 * caller's latest line is at least this likely to be a yes, and less than
 * `CORRECTION_FLOOR` likely to be a correction. Below that the model's
 * `complete_request` is refused and it is told what the caller said. Set
 * high: a wrong lead is worse than one more "is that right?".
 */
export const CONFIRMATION_FLOOR = 0.7;
export const CORRECTION_FLOOR = 0.5;

/**
 * Words said over the receptionist are answered when at least this likely to
 * be an answer, and left alone when at most `OVERLAP_ACKNOWLEDGEMENT_CEILING`
 * likely. In between, the word lists in the gateway decide.
 */
export const OVERLAP_ANSWER_FLOOR = 0.7;
export const OVERLAP_ACKNOWLEDGEMENT_CEILING = 0.3;

/**
 * Confidence at which a caller's complaint, question or "can you hear me" is
 * put in front of the model as something to answer first. Being wrong costs
 * one needless "sorry about that", so the floor is modest.
 */
export const MOVE_CONFIDENCE_FLOOR = 0.6;

/**
 * A question or complaint counts as answered when the reply to it is at least
 * this likely to have answered or acknowledged it. Only below this is the
 * model reminded of it, once, on the caller's next turn.
 */
export const ANSWERED_FLOOR = 0.5;

/** Confidence at which a question is noted on the lead as being about the arrival time or the price. */
export const TOPIC_CONFIDENCE_FLOOR = 0.6;

/**
 * Confidence at which the kind of help the judge picked is saved, marked as
 * inferred. Below it the receptionist offers the caller the two most likely
 * kinds instead of asking "what do you need?" again.
 */
export const SERVICE_CONFIDENCE_FLOOR = 0.75;
/** An alternative is only offered if it is at least this likely. */
export const SERVICE_ALTERNATIVE_FLOOR = 0.15;

/* -------------------------------------------------------------------------- */
/*  Location precision                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Score 0-2. Level 2 is the only one that lets the intake move on; 0 and 1
 * both mean "ask where exactly". State: `location`, `business_service_areas`.
 */
export const LOCATION_PRECISION = score(
  {
    question:
      'How precisely does `location` say where the vehicle is, for a tow truck driver who has to drive there and find it?',
    notes: [
      '`location` is what a caller said on the phone, possibly transcribed with errors.',
      'A name that is one of `business_service_areas` on its own is a town or district, not a spot.',
      'A single word that is not a recognisable place is most likely a misheard name; treat it as not precise.',
    ],
  },
  [
    'No usable place: nothing, or only words like "here", "on the road" or "at the side of the road".',
    'A road, street, town or district with no point on it. The driver would have to search along it or around it. Examples: "I-95", "on the highway", "Main Street", "downtown", "Dallas", "I-85 near the exit", "the shoulder", or a single unrecognisable word.',
    'A specific spot the driver can go to: a street address with a number, an intersection of two named roads, a numbered exit or mile marker, a named business or landmark, a rest area on a named road, or coordinates.',
  ],
);

/* -------------------------------------------------------------------------- */
/*  Danger and urgency                                                        */
/* -------------------------------------------------------------------------- */

const HAZARD_CRITERIA: Record<HazardChoice, string> = {
  none: 'No danger described: a breakdown, a flat tyre, a dead battery, a lockout, being stuck, or nothing said about danger at all.',
  accident: 'A crash or collision happened, whether or not anyone says they are hurt.',
  injury: 'Someone is hurt, bleeding or injured.',
  fire_or_fuel: 'Smoke, fire, flames, burning smell, or leaking fuel or gas.',
  live_traffic: 'The vehicle is in a live lane, in the middle of the road, or blocking moving traffic.',
  other_danger:
    'Some other immediate danger to the people there: they feel unsafe or threatened, or they are stranded in extreme heat, cold or darkness.',
};

/**
 * Choice. State: `caller_said` (a line they spoke, or the location they gave)
 * and `location` (where they are, if known).
 */
export const HAZARD = choice(
  'From what the caller said in `caller_said`, and where they are according to `location`, what danger, if any, are the caller or the people with them in right now?',
  HAZARD_CRITERIA,
);

/** The phrase used for each hazard in the lead notes and the safety step. `null`: no hazard. */
export const HAZARD_LABEL: Record<HazardChoice, string | null> = {
  none: null,
  accident: 'an accident',
  injury: 'a possible injury',
  fire_or_fuel: 'fire or fuel risk',
  live_traffic: 'being in live traffic',
  other_danger: 'a dangerous situation',
};

/** Noul. State: `caller_said`. */
export const URGENT = noul(
  'Is the caller in `caller_said` asking for help urgently or immediately, rather than at an ordinary pace?',
  {
    true: 'They ask for it now, right away, as soon as possible, or say it is an emergency or that they are in a hurry.',
    false: 'They describe the problem without pressing for speed, or they are only answering a question.',
  },
);

/* -------------------------------------------------------------------------- */
/*  Confirmations                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Noul. State: `caller_said`, `question_asked`, and `details_read_back` when
 * the question was a read-back. Asked only while the receptionist is waiting
 * for the caller's answer to that question.
 */
export const CONFIRMS = noul(
  'The receptionist asked `question_asked` and the caller replied with `caller_said`. Does the caller say that what was asked about is correct?',
  {
    true: 'A yes in any words: "yes", "that\'s right", "correct", "yep that\'s it", "sounds good", "perfect".',
    false: 'A no, a correction, a different detail, a question back, silence-fillers like "hello?", or something unrelated.',
  },
);

/** Noul. Same state as `CONFIRMS`. */
export const CORRECTS = noul(
  'The receptionist asked `question_asked` and the caller replied with `caller_said`. Does the caller correct or change any detail, or ask for something different from what was read back?',
  {
    true: 'They say something is wrong, give a different value ("no, it\'s a Ford"), add a detail, or ask for a change.',
    false: 'They agree, or say something that changes nothing.',
  },
);

/* -------------------------------------------------------------------------- */
/*  What the caller is doing                                                  */
/* -------------------------------------------------------------------------- */

const MOVE_CRITERIA: Record<CallerMove, string> = {
  request:
    'They say what they need, answer the receptionist, or give a detail: what happened, where they are, the vehicle, their name or their number.',
  line_check: 'They only check the line: "hello?", "can you hear me?", "are you there?", "is this audible?".',
  complaint:
    'They complain about the call itself: being cut off, talked over, not listened to, asked the same thing again, or kept waiting.',
  question:
    'They ask the receptionist something and expect an answer: a price, how long it takes, something about the company, what happens next.',
  other: 'A greeting, thanks, a filler word, words to someone else nearby, or nothing clear.',
};

/**
 * Choice. State: `caller_said`. On a real call the caller asked "why do you
 * keep cutting me off?" twice and was asked "what kind of help do you need?"
 * both times.
 */
export const CALLER_MOVE = choice(
  'What is the caller doing in `caller_said`? If they complain and also ask why, it is a complaint.',
  MOVE_CRITERIA,
);

const TOPIC_CRITERIA: Record<QuestionTopic, string> = {
  eta: 'How long it will take, how soon someone can come, or when help will arrive.',
  price: 'What it will cost: the price, a fee, a charge, a quote, "what\'s the damage".',
  other: 'A question about anything else.',
  none: 'Not a question.',
};

/**
 * Choice. State: `caller_said`. The receptionist tells a caller who asks
 * either that the towing team will come back to them on it; the lead has to
 * say so, or the promise is not kept.
 */
export const QUESTION_TOPIC = choice('If the caller asks a question in `caller_said`, what is it about?', TOPIC_CRITERIA);

/**
 * Noul. State: `caller_said`, `receptionist_replied`. Asked only about a
 * line judged a question, a complaint or a check of the line.
 */
export const ANSWERED = noul(
  'The caller said `caller_said`. The receptionist replied `receptionist_replied`. Does the reply answer or acknowledge what the caller said?',
  {
    true: 'It answers the question, says it cannot answer and what happens instead, apologises for what was complained of, or confirms it can hear them. It may then go on to something else.',
    false: 'It goes straight to something else: it asks its own next question or reads details back, with nothing about what the caller said.',
  },
);

/* -------------------------------------------------------------------------- */
/*  The help they need                                                        */
/* -------------------------------------------------------------------------- */

const SERVICE_CRITERIA: Record<ServiceChoice, string> = {
  tow: 'The vehicle has to be taken somewhere: it broke down, will not move or drive, was in a crash, or they ask for a tow.',
  jump_start: 'The battery is flat or dead: the engine will not turn over or only clicks, the lights were left on. A jump would get it going.',
  lockout: 'The keys are locked inside the vehicle, or lost.',
  flat_tire: 'A flat or blown tire to be changed or repaired at the roadside.',
  fuel_delivery: 'The vehicle has run out of fuel.',
  winch_out: 'The vehicle is stuck in mud, sand, snow or a ditch and needs pulling out; it would run if it were free.',
  unclear: 'They have not said enough to tell what help they need.',
};

/** Choice. State: `caller_said`, `problem_described`, `location`. */
export const SERVICE = choice(
  'Which kind of roadside help does the caller need, going by `caller_said`, by what is wrong with the vehicle in `problem_described`, and by where it is in `location`?',
  SERVICE_CRITERIA,
);

/** The word saved as the service, and said to the caller, for each kind of help. */
export const SERVICE_LABEL: Record<Exclude<ServiceChoice, 'unclear'>, string> = {
  tow: 'tow',
  jump_start: 'jump start',
  lockout: 'lockout',
  flat_tire: 'flat tire',
  fuel_delivery: 'fuel delivery',
  winch_out: 'winch out',
};

/** Words that already name a kind of help. What the caller said is kept as it is when it has one. */
export const NAMES_A_SERVICE = /\b(?:tow(?:ed|ing)?|jump(?:[- ]?start)?|boost|lock(?:ed)?[- ]?out|unlock|tire|tyre|fuel|gas|petrol|diesel|winch|pull(?:ed)? out|recovery)\b/i;

/* -------------------------------------------------------------------------- */
/*  Words said over the receptionist                                          */
/* -------------------------------------------------------------------------- */

/** Noul. State: `receptionist_said`, `caller_said`. */
export const ANSWERS = noul(
  'While the receptionist was saying `receptionist_said`, the caller said `caller_said`. Does `caller_said` answer the receptionist, give new information, or ask something, rather than only acknowledging or checking the line is live?',
  {
    true: 'An answer ("yes", "no" or a detail) to a question the receptionist asked, a new fact, a correction, or a question of their own.',
    false: 'Only "okay", "uh-huh", "right", "sure", "got it", "hello?", "are you there?", a repeated word, or noise transcribed as words.',
  },
);

/* -------------------------------------------------------------------------- */
/*  State builders                                                            */
/* -------------------------------------------------------------------------- */

/** The state for judging a location the caller gave. */
export function locationState(location: string, knownAreas: readonly string[]) {
  return { location, business_service_areas: [...knownAreas], caller_said: location };
}

/** The state for judging a line the caller spoke. */
export function speechState(
  spoken: string,
  about: {
    location?: string;
    problem?: string;
    pending?: { question: string; readBack?: Array<{ label: string; value: string }> };
  } = {},
) {
  return {
    caller_said: spoken,
    location: about.location ?? null,
    ...(about.problem ? { problem_described: about.problem } : {}),
    ...(about.pending
      ? {
          question_asked: about.pending.question,
          details_read_back: about.pending.readBack ? about.pending.readBack.map((line) => `${line.label}: ${line.value}`) : null,
        }
      : {}),
  };
}

/** The state for judging what was saved as the help the caller needs. */
export function serviceState(said: string, about: { problem?: string; location?: string }) {
  return { caller_said: said, problem_described: about.problem ?? null, location: about.location ?? null };
}

/** The state for judging whether a reply answered the caller. */
export function replyState(callerSaid: string, reply: string) {
  return { caller_said: callerSaid, receptionist_replied: reply };
}

/** The state for judging words said over the receptionist. */
export function overlapState(spoken: string, receptionistSaid: string) {
  return { receptionist_said: receptionistSaid, caller_said: spoken };
}
