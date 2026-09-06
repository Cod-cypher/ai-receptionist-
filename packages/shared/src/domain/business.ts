/**
 * Business configuration and the sanitised view of it that the model is allowed
 * to see.
 *
 * The distinction matters: `Business` is the full tenant record; `BusinessFacts`
 * is what gets rendered into a prompt. Anything not in `BusinessFacts` cannot be
 * spoken by the receptionist, which is what makes "the AI must only provide
 * information that exists in the company's configured data" enforceable rather
 * than aspirational.
 */

import { z } from 'zod';

export const ReceptionistTone = {
  PROFESSIONAL: 'professional',
  FRIENDLY: 'friendly',
  CALM: 'calm',
} as const;

export type ReceptionistTone =
  (typeof ReceptionistTone)[keyof typeof ReceptionistTone];

export const FallbackBehavior = {
  /** Raise a callback request and tell the caller someone will ring back. */
  CALLBACK: 'callback',
  /** Read out the configured emergency contact number. */
  EMERGENCY_CONTACT: 'emergency_contact',
} as const;

export type FallbackBehavior =
  (typeof FallbackBehavior)[keyof typeof FallbackBehavior];

export const BusinessHoursSchema = z.object({
  /** 0 = Sunday. */
  day: z.number().int().min(0).max(6),
  /** "HH:MM" in the business's timezone. */
  open: z.string().regex(/^\d{2}:\d{2}$/),
  close: z.string().regex(/^\d{2}:\d{2}$/),
  closed: z.boolean().default(false),
});

export type BusinessHours = z.infer<typeof BusinessHoursSchema>;

export const FaqEntrySchema = z.object({
  question: z.string().min(1).max(300),
  answer: z.string().min(1).max(1000),
});

export type FaqEntry = z.infer<typeof FaqEntrySchema>;

export interface Business {
  id: string;
  name: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  timezone: string;
  serviceAreas: string[];
  businessHours: BusinessHours[];
  pricingInfo: string | null;
  emergencyContact: string | null;
  whatsappNumber: string | null;
  /** Default country prefix used to normalise nationally-formatted numbers. */
  defaultRegionPrefix: string | null;
  status: 'active' | 'suspended';
}

export interface BusinessService {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface BusinessSettings {
  greeting: string | null;
  tone: ReceptionistTone;
  /**
   * Tenant-authored style guidance. Rendered into the prompt inside a delimited,
   * explicitly-untrusted block. It can influence wording; it cannot alter the
   * workflow, the guardrails, or what the receptionist is allowed to claim.
   */
  businessInstructions: string | null;
  faq: FaqEntry[];
  fallbackBehavior: FallbackBehavior;
  voiceId: string | null;
  language: string;
  maxCallSeconds: number;
}

/**
 * Everything the model may state as fact, and nothing else.
 * Built by the API from a Business + its services and settings.
 */
export interface BusinessFacts {
  name: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  serviceAreas: string[];
  services: string[];
  businessHoursText: string | null;
  /** Whether the business is open at the moment the call is happening. */
  isOpenNow: boolean | null;
  pricingInfo: string | null;
  emergencyContact: string | null;
  faq: FaqEntry[];
  tone: ReceptionistTone;
  /** Untrusted tenant text. Always rendered inside a fenced block. */
  businessInstructions: string | null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Renders business hours as one readable line per distinct schedule. */
export function formatBusinessHours(hours: BusinessHours[]): string | null {
  if (hours.length === 0) return null;

  const parts = [...hours]
    .sort((a, b) => a.day - b.day)
    .map((h) =>
      h.closed
        ? `${DAY_NAMES[h.day]}: closed`
        : `${DAY_NAMES[h.day]}: ${h.open}-${h.close}`,
    );

  return parts.join(', ');
}

/**
 * Whether the business is open at `at`, evaluated in the business's timezone.
 * Returns null when hours are not configured, which the receptionist must treat
 * as "I can't confirm that" rather than as "closed".
 */
export function isOpenAt(
  hours: BusinessHours[],
  timezone: string,
  at: Date = new Date(),
): boolean | null {
  if (hours.length === 0) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;
  if (!weekday || !hour || !minute) return null;

  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  const today = hours.find((h) => h.day === dayIndex);
  if (!today || today.closed) return false;

  const now = `${hour}:${minute}`;
  // An overnight window (22:00-06:00) wraps past midnight.
  if (today.close < today.open) return now >= today.open || now < today.close;
  return now >= today.open && now < today.close;
}
