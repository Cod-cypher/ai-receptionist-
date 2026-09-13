/**
 * Renders the WhatsApp message a tow operator receives.
 *
 * This is a pure function of a *persisted* Lead. It never sees model output, a
 * transcript, or a prompt. That is the whole point: whatever the model may have
 * hallucinated during the call, only values that survived slot validation and a
 * database write can appear on the operator's phone.
 *
 * Keep it pure and side-effect free — it is snapshot-tested, and it runs inside
 * a queue worker that may retry it hours after the call ended.
 */

import type { Lead } from '../domain/lead';
import { leadVehicleSummary } from '../domain/lead';
import { formatPhoneForDisplay } from '../util/phone';

export interface LeadNotificationContext {
  businessName: string;
  /** IANA timezone; the operator wants the call time in their own clock. */
  timezone: string;
  /** Overridable for deterministic tests. */
  now?: Date;
}

const NOT_PROVIDED = 'Not provided';
const NONE = 'None';

function formatCallTime(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      day: 'numeric',
      month: 'short',
    }).format(at);
  } catch {
    // An invalid tenant timezone must not stop the operator being notified.
    return at.toISOString();
  }
}

function movableText(movable: boolean | null): string {
  if (movable === null) return NOT_PROVIDED;
  return movable ? 'Yes' : 'No';
}

/**
 * The notification body.
 *
 * Section order is fixed and every section is always present, including the
 * empty ones. An operator glancing at a phone at 2am reads by position, so a
 * message whose fields move around depending on what was collected is worse
 * than one with a couple of "Not provided" lines.
 */
export function formatLeadNotification(
  lead: Lead,
  ctx: LeadNotificationContext,
): string {
  const vehicle = leadVehicleSummary(lead) ?? NOT_PROVIDED;
  const callTime = formatCallTime(lead.createdAt, ctx.timezone);

  const lines: string[] = [
    lead.priority === 'high' ? '🚨 URGENT TOWING LEAD' : '🚨 NEW TOWING LEAD',
    '',
    `Customer: ${lead.customerName}`,
    `Phone: ${formatPhoneForDisplay(lead.customerPhone)}`,
    '',
    `Service: ${lead.service}`,
    '',
    'Vehicle:',
    vehicle,
    '',
    'Vehicle movable:',
    movableText(lead.vehicleMovable),
    '',
    'Location:',
    lead.location,
    '',
    'Destination:',
    lead.destination ?? NOT_PROVIDED,
  ];

  // Condition is optional and only earns a section when it was actually given —
  // it is detail, not one of the fields the operator scans for.
  if (lead.vehicleCondition) {
    lines.push('', 'Condition:', lead.vehicleCondition);
  }

  lines.push(
    '',
    'Additional notes:',
    lead.additionalNotes ?? NONE,
    '',
    '📞 Customer requested towing assistance.',
    '',
    'Call received:',
    callTime,
  );

  return lines.join('\n');
}

/**
 * Variable list for a Twilio/Meta approved content template.
 *
 * Business-initiated WhatsApp messages outside the 24-hour service window must
 * use an approved template, which takes ordered positional variables rather than
 * a free-form body. Same data, same order as the plain-text body above, so the
 * two renderings cannot drift apart.
 */
export function leadNotificationVariables(
  lead: Lead,
  ctx: LeadNotificationContext,
): Record<string, string> {
  return {
    '1': lead.customerName,
    '2': formatPhoneForDisplay(lead.customerPhone),
    '3': lead.service,
    '4': leadVehicleSummary(lead) ?? NOT_PROVIDED,
    '5': movableText(lead.vehicleMovable),
    '6': lead.location,
    '7': lead.destination ?? NOT_PROVIDED,
    '8': lead.additionalNotes ?? NONE,
    '9': formatCallTime(lead.createdAt, ctx.timezone),
  };
}

export interface CallbackNotificationInput {
  customerName: string | null;
  customerPhone: string;
  reason: string;
  createdAt: Date;
}

/** The equivalent message for a callback request. */
export function formatCallbackNotification(
  callback: CallbackNotificationInput,
  ctx: LeadNotificationContext,
): string {
  return [
    '📞 CALLBACK REQUEST',
    '',
    `Customer: ${callback.customerName ?? NOT_PROVIDED}`,
    `Phone: ${formatPhoneForDisplay(callback.customerPhone)}`,
    '',
    'They asked about:',
    callback.reason,
    '',
    'The receptionist could not answer this and told the caller someone would',
    'contact them.',
    '',
    'Call received:',
    formatCallTime(callback.createdAt, ctx.timezone),
  ].join('\n');
}
