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

import type { HazardChoice } from './judgment.interface';

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
  location: string | undefined,
  pending?: { question: string; readBack?: Array<{ label: string; value: string }> },
) {
  return {
    caller_said: spoken,
    location: location ?? null,
    ...(pending
      ? {
          question_asked: pending.question,
          details_read_back: pending.readBack ? pending.readBack.map((line) => `${line.label}: ${line.value}`) : null,
        }
      : {}),
  };
}

/** The state for judging words said over the receptionist. */
export function overlapState(spoken: string, receptionistSaid: string) {
  return { receptionist_said: receptionistSaid, caller_said: spoken };
}
