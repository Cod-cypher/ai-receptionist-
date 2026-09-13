/**
 * Folding validated slot values into a call's context.
 *
 * Shared by the state machine (every pipeline that phrases templated turns) and
 * the intake operations the realtime receptionist calls as tools, so a detail
 * reaches the lead the same way whichever pipeline heard it.
 */

import { CallEventType, type SlotKey, type SlotValues } from '@towai/shared';

import type { ConversationContext, Effect } from './types';

export interface SlotMerge {
  context: ConversationContext;
  changed: SlotKey[];
  effects: Effect[];
}

/**
 * Latest statement wins: a caller correcting themselves is the normal case, and
 * treating a restatement as a conflict would strand the conversation. Values
 * never erase — an absent value simply is not in `accepted`.
 */
export function mergeSlots(
  ctx: ConversationContext,
  accepted: SlotValues,
  rejected: Array<{ key: SlotKey; reason: string }>,
): SlotMerge {
  const before = ctx.values;
  const values: SlotValues = { ...before };
  const changed: SlotKey[] = [];
  const effects: Effect[] = [];

  for (const [key, value] of Object.entries(accepted) as Array<[SlotKey, unknown]>) {
    if (value === undefined) continue;
    const previous = before[key];
    if (previous === value) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (values as any)[key] = value;
    changed.push(key);
    effects.push({
      type: 'LOG_EVENT',
      event: previous === undefined ? CallEventType.FIELD_EXTRACTED : CallEventType.FIELD_CORRECTED,
      payload:
        previous === undefined
          ? { field: key, value }
          : { field: key, from: previous, to: value },
    });
  }

  for (const rejection of rejected) {
    effects.push({
      type: 'LOG_EVENT',
      event: CallEventType.FIELD_REJECTED,
      payload: { field: rejection.key, reason: rejection.reason },
    });
  }

  // An explicit alternate number both fills and confirms the phone requirement.
  const gaveAlternatePhone = changed.includes('customerPhone');

  return {
    context: {
      ...ctx,
      values,
      phoneConfirmed: ctx.phoneConfirmed || gaveAlternatePhone,
      phoneNeedsCollection: gaveAlternatePhone ? false : ctx.phoneNeedsCollection,
      fieldVersion: (ctx.fieldVersion ?? 0) + (changed.length > 0 ? 1 : 0),
    },
    changed,
    effects,
  };
}
