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

import { classifyLocation } from './location';
import type { ConversationContext } from './types';

const URGENCY: Array<[RegExp, string]> = [
  [/\b(?:immediately|right now|right away|asap|a\.s\.a\.p|as soon as possible|urgent(?:ly)?|emergency|hurry|quickly)\b/i, 'caller needs help urgently'],
  [/\b(?:blocking (?:traffic|the (?:road|lane|highway))|in (?:the|a) (?:live |travel )?lane|middle of the (?:road|highway|lane))\b/i, 'vehicle is blocking traffic'],
  [/\b(?:kids?|children|baby|infant|elderly|pregnant)\b/i, 'vulnerable people with the vehicle'],
  [/\b(?:unsafe|not safe|scared|dangerous|in the dark|pitch black)\b/i, 'caller feels unsafe'],
];

const HAZARDS: Array<[RegExp, string]> = [
  [/\b(?:accident|crash(?:ed)?|collision|wreck(?:ed)?|rolled over)\b/i, 'an accident'],
  [/\b(?:injur(?:ed|y|ies)|hurt|bleeding)\b/i, 'a possible injury'],
  [/\b(?:smoke|smoking|fire|flames|burning|fuel leak|leaking (?:fuel|gas))\b/i, 'fire or fuel risk'],
  [/\b(?:blocking (?:traffic|the (?:road|lane|highway))|in (?:the|a) (?:live |travel )?lane|middle of the (?:road|highway))\b/i, 'being in live traffic'],
];

/** Numbered and high-speed roads, where stopping is itself dangerous. */
const HIGH_SPEED = /\b(?:interstate|i[- ]?\d|us[- ]?\d|highway|hwy|freeway|motorway|expressway|turnpike|beltway)/i;

function textOf(values: SlotValues, spoken?: string): string {
  return [spoken, values.location, values.vehicleCondition, values.additionalNotes].filter(Boolean).join(' . ');
}

/**
 * Folds anything new the caller said into the call's urgency and safety.
 * Reasons only accumulate; a hazard, once detected, stays until it is handled.
 */
export function assessRisk(
  ctx: ConversationContext,
  spoken?: string,
): Pick<ConversationContext, 'urgency' | 'safety'> {
  const text = textOf(ctx.values, spoken);
  const reasons = new Set(ctx.urgency?.reasons ?? []);

  for (const [pattern, reason] of URGENCY) if (pattern.test(text)) reasons.add(reason);

  const onHighSpeedRoad = Boolean(ctx.values.location && HIGH_SPEED.test(ctx.values.location)) &&
    classifyLocation(ctx.values.location).status !== 'missing';
  if (onHighSpeedRoad && ctx.values.vehicleMovable === false) reasons.add('broken down on a high-speed road');

  let hazard = ctx.safety?.hazard ?? null;
  if (!hazard) {
    hazard = HAZARDS.find(([pattern]) => pattern.test(text))?.[1] ?? (onHighSpeedRoad ? 'being stopped on a high-speed road' : null);
  }

  return {
    urgency: { level: reasons.size > 0 ? 'high' : 'normal', reasons: [...reasons] },
    safety: hazard ? { hazard, issuedAtTurn: ctx.safety?.issuedAtTurn ?? null } : ctx.safety,
  };
}
