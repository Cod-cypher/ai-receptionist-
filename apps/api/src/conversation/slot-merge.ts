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
  /** Values not applied because they were less specific than what was saved. */
  ignored: SlotKey[];
  effects: Effect[];
}

export interface MergeOptions {
  /**
   * Keep a saved value when the new one only drops words from it: "truck"
   * after "semi truck", "I-95" after "I-95, exit 42". The towing team needs
   * the specific version, and a model restating a detail tends to shorten it.
   */
  preferSpecific?: boolean;
}

const words = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

export function isLessSpecific(next: string, previous: string): boolean {
  const candidate = words(next);
  const saved = new Set(words(previous));
  return candidate.length > 0 && candidate.length < saved.size && candidate.every((w) => saved.has(w));
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
  options: MergeOptions = {},
): SlotMerge {
  const before = ctx.values;
  const values: SlotValues = { ...before };
  const changed: SlotKey[] = [];
  const ignored: SlotKey[] = [];
  const effects: Effect[] = [];

  for (const [key, value] of Object.entries(accepted) as Array<[SlotKey, unknown]>) {
    if (value === undefined) continue;
    const previous = before[key];
    if (previous === value) continue;

    if (options.preferSpecific && typeof previous === 'string' && typeof value === 'string' && isLessSpecific(value, previous)) {
      ignored.push(key);
      effects.push({
        type: 'LOG_EVENT',
        event: CallEventType.FIELD_DOWNGRADE_IGNORED,
        payload: { field: key, kept: previous, ignored: value },
      });
      continue;
    }

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
    ignored,
    effects,
  };
}
