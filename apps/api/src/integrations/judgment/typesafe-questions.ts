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
/*  State builders                                                            */
/* -------------------------------------------------------------------------- */

/** The state for judging a location the caller gave. */
export function locationState(location: string, knownAreas: readonly string[]) {
  return { location, business_service_areas: [...knownAreas], caller_said: location };
}

/** The state for judging a line the caller spoke. */
export function speechState(spoken: string, location: string | undefined) {
  return { caller_said: spoken, location: location ?? null };
}
