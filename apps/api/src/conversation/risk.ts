/**
 * Urgency and safety, detected in code from what the caller said and where
 * they are.
 *
 * On the last real call the caller said "I need it immediately" from a highway
 * blowout; the model did not acknowledge it and the lead came out with
 * "Notes: None". These rules make that a high-priority lead and make the
 * receptionist give safety advice first, whatever the model would have done.
 */

import type { SlotValues } from '@towai/shared';

import { DANGER_FLOOR, HAZARD_LABEL, URGENT_FLOOR } from '../integrations/judgment/typesafe-questions';
import { classifyLocation } from './location';
import type { ConversationContext } from './types';

const URGENCY: Array<[RegExp, string]> = [
  [/\b(?:immediately|right now|right away|asap|a\.s\.a\.p|as soon as possible|urgent(?:ly)?|emergency|hurry|quickly)\b/i, 'caller needs help urgently'],
  [/\b(?:blocking (?:traffic|the (?:road|lane|highway))|in (?:the|a) (?:live |travel )?lane|middle of the (?:road|highway|lane))\b/i, 'vehicle is blocking traffic'],
  // Children who are there, not children mentioned: "my kid is talking to
  // me" made a caller stepping away from the phone an urgent lead.
  [
    /\b(?:kids?|children|baby|infant|toddler|elderly|pregnant)\b[^.?!]{0,25}\b(?:with me|with us|in the (?:car|vehicle|truck|van|back(?: ?seat)?)|in my (?:car|truck|van)|here with|on board)\b|\b(?:i(?:'ve| have)(?: got)?|we(?:'ve| have)(?: got)?|there(?:'s| are| is)|i(?:'m| am) with) (?:a |an |my |our |two |three |some |the )?(?:kids?|children|baby|infant|toddler|elderly (?:mother|father|parent)|pregnant)\b|\bi(?:'m| am) pregnant\b/i,
    'vulnerable people with the vehicle',
  ],
  [/\b(?:unsafe|not safe|scared|dangerous|in the dark|pitch black)\b/i, 'caller feels unsafe'],
];

const HAZARDS: Array<[RegExp, string]> = [
  [/\b(?:accident|crash(?:ed)?|collision|wreck(?:ed)?|rolled over)\b/i, 'an accident'],
  [/\b(?:injur(?:ed|y|ies)|hurt|bleeding)\b/i, 'a possible injury'],
  [/\b(?:smoke|smoking|fire|flames|burning|fuel leak|leaking (?:fuel|gas))\b/i, 'fire or fuel risk'],
  [/\b(?:blocking (?:traffic|the (?:road|lane|highway))|in (?:the|a) (?:live |travel )?lane|middle of the (?:road|highway))\b/i, 'being in live traffic'],
];

/** The one hazard a location can describe. The rest of the list, read from a location, finds place names. */
const LIVE_TRAFFIC = HAZARDS[3]!;

/**
 * A hazard the caller denies is not one: "nobody is hurt", "no accident, it
 * just won't start". Taken out before the lists are read.
 */
const DENIED =
  /\b(?:no|not|nobody(?:'s| is)?|no one(?:'s| is)?|none|never|isn'?t|aren'?t|wasn'?t|weren'?t|didn'?t|don'?t|without)\b[^.,;!?]{0,20}?\b(?:hurt|injur\w*|bleeding|accident|crash\w*|collision|wreck\w*|fire|flames?|smoke|smoking|burning)\b/gi;
/** Fire in a name, not a fire. */
const FIRE_NAMES = /\bfire ?(?:station|department|dept|house|hydrant|truck|engine|brigade|lane|road|rd|street|st|lake|island|tower|hall)\b/gi;

/** Numbered and high-speed roads, where stopping is itself dangerous. */
const HIGH_SPEED = /\b(?:interstate|i[- ]?\d|us[- ]?\d|highway|hwy|freeway|motorway|expressway|turnpike|beltway)/i;
/** The hazard of the common case: a breakdown on such a road, with nothing else wrong. */
export const HIGH_SPEED_ROAD_HAZARD = 'being stopped on a high-speed road';

/** What the caller said, and what is wrong with the vehicle: the words that can describe danger. */
function saidOf(values: SlotValues, spoken?: string): string {
  return [spoken, values.vehicleCondition, values.additionalNotes]
    .filter(Boolean)
    .join(' . ')
    .replace(FIRE_NAMES, ' ')
    .replace(DENIED, ' ');
}

/** Everything, for urgency, which a location can also carry ("blocking the road"). */
function textOf(values: SlotValues, spoken?: string): string {
  return [saidOf(values, spoken), values.location].filter(Boolean).join(' . ');
}

function hazardIn(values: SlotValues, spoken?: string): string | null {
  const said = saidOf(values, spoken);
  const found = HAZARDS.find(([pattern]) => pattern.test(said))?.[1];
  if (found) return found;
  return values.location && LIVE_TRAFFIC[0].test(values.location) ? LIVE_TRAFFIC[1] : null;
}

/**
 * Folds anything new the caller said into the call's urgency and safety.
 * Reasons only accumulate; a hazard, once detected, stays until it is handled.
 *
 * With a judgment from Jev about exactly this text (the spoken line, or the
 * saved location when nothing was spoken), its hazard and urgency count too.
 * The rules and the judge add to each other: a hazard either one is sure of
 * is handled, since missing one costs more than a needless safety reminder.
 */
export function assessRisk(
  ctx: ConversationContext,
  spoken?: string,
): Pick<ConversationContext, 'urgency' | 'safety'> {
  const text = textOf(ctx.values, spoken);
  const reasons = new Set(ctx.urgency?.reasons ?? []);
  const judgedText = spoken ?? ctx.values.location;
  const judged = ctx.judgments?.risk && judgedText && ctx.judgments.risk.text === judgedText ? ctx.judgments.risk : null;

  for (const [pattern, reason] of URGENCY) if (pattern.test(text)) reasons.add(reason);
  if (judged && judged.urgent !== null && judged.urgent >= URGENT_FLOOR) reasons.add('caller needs help urgently');

  const onHighSpeedRoad = Boolean(ctx.values.location && HIGH_SPEED.test(ctx.values.location)) &&
    classifyLocation(ctx.values.location).status !== 'missing';
  if (onHighSpeedRoad && ctx.values.vehicleMovable === false) reasons.add('broken down on a high-speed road');

  let hazard = ctx.safety?.hazard ?? null;
  if (!hazard) {
    const judgedHazard = judged && judged.danger >= DANGER_FLOOR ? HAZARD_LABEL[judged.hazard] : null;
    hazard =
      hazardIn(ctx.values, spoken) ??
      judgedHazard ??
      (onHighSpeedRoad ? HIGH_SPEED_ROAD_HAZARD : null);
  }

  return {
    urgency: { level: reasons.size > 0 ? 'high' : 'normal', reasons: [...reasons] },
    safety: hazard ? { hazard, issuedAtTurn: ctx.safety?.issuedAtTurn ?? null } : ctx.safety,
  };
}
