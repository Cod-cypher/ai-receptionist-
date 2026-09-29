/**
 * The notes a tow operator reads on a lead, composed in code from what the
 * call established — urgency, safety, and how much to trust each detail.
 *
 * Before this, a highway blowout with "I need it immediately" arrived as
 * "Notes: None", indistinguishable from a driveway jump start.
 */

import { SLOT_DEFS, type SlotKey } from '@towai/shared';

import { assessLocation } from './location';
import type { ConversationContext } from './types';

const show = (value: unknown) => (typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value));

export function buildLeadNotes(ctx: ConversationContext): string | null {
  const notes: string[] = [];

  if (ctx.urgency?.level === 'high') notes.push(`URGENT: ${ctx.urgency.reasons.join('; ')}.`);

  // Only the realtime pipeline reads the details back and records where each
  // came from. A lead made because the call ended first looked, on a real
  // call, exactly as trustworthy as one the caller had confirmed.
  if (ctx.fieldSources !== undefined && !ctx.detailsConfirmed) {
    const why = ctx.escalationReason ? ` (${ctx.escalationReason.replace(/\.$/, '')})` : '';
    notes.push(`NOT CONFIRMED: the call ended before these details were read back to the caller${why}. Check them when you call.`);
    if (ctx.values.customerPhone && !ctx.phoneConfirmed) {
      notes.push('Callback number is the one they called from; the caller did not confirm it is the best one.');
    }
  }
  if (ctx.safety?.hazard) {
    notes.push(
      `Safety: caller may be at risk (${ctx.safety.hazard}); emergency advice ${ctx.safety.issuedAtTurn !== null ? 'was given' : 'was NOT given'}.`,
    );
  }

  for (const [key, source] of Object.entries(ctx.fieldSources ?? {}) as Array<[SlotKey, string]>) {
    const value = ctx.values[key];
    if (value === undefined) continue;
    if (source === 'inferred') notes.push(`${SLOT_DEFS[key].label} "${show(value)}" was inferred, not said by the caller.`);
    if (source === 'unsure') notes.push(`${SLOT_DEFS[key].label} "${show(value)}" was not clearly heard; please confirm.`);
  }

  // Only the realtime pipeline asks for location detail; other pipelines'
  // leads keep their notes exactly as before.
  if (ctx.locationDetailAttempts !== undefined && assessLocation(ctx).status === 'partial') {
    notes.push('Location is approximate: the caller could not give an exit, mile marker or landmark.');
  }

  if (ctx.values.additionalNotes) notes.push(ctx.values.additionalNotes);
  return notes.length > 0 ? notes.join('\n') : null;
}
