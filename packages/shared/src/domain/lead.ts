/**
 * The structured lead — the product's actual output.
 *
 * Everything downstream (WhatsApp notification, dashboard table, future CRM
 * export) reads this object and nothing else. In particular the WhatsApp
 * message is rendered from a persisted Lead, never from model output, so a
 * hallucination cannot reach the tow operator's phone.
 */

import { z } from 'zod';
import type { SlotValues } from './slots';
import { describeVehicle } from './slots';

export const LeadStatus = {
  NEW: 'new',
  CONTACTED: 'contacted',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;

export type LeadStatus = (typeof LeadStatus)[keyof typeof LeadStatus];

export const LEAD_STATUSES: readonly LeadStatus[] = [
  LeadStatus.NEW,
  LeadStatus.CONTACTED,
  LeadStatus.COMPLETED,
  LeadStatus.CANCELLED,
];

export const LeadSource = {
  AI_RECEPTIONIST: 'ai_receptionist',
} as const;

export type LeadSource = (typeof LeadSource)[keyof typeof LeadSource];

/**
 * Fields absent from the call are `null`, never a placeholder string.
 * "Do not store information that was not provided."
 */
export const LeadSchema = z.object({
  id: z.string().uuid(),
  businessId: z.string().uuid(),
  callId: z.string().uuid().nullable(),

  customerName: z.string(),
  customerPhone: z.string(),

  service: z.string(),
  location: z.string(),
  destination: z.string().nullable(),

  vehicleMake: z.string().nullable(),
  vehicleModel: z.string().nullable(),
  vehicleType: z.string().nullable(),
  vehicleCondition: z.string().nullable(),
  vehicleMovable: z.boolean().nullable(),

  additionalNotes: z.string().nullable(),
  /** 'high' for urgent or unsafe situations. Absent on leads made before it existed. */
  priority: z.enum(['normal', 'high']).optional(),
  /** Where each detail came from: stated, inferred, unsure or caller_id. */
  fieldSources: z.record(z.string(), z.string()).optional(),

  source: z.literal(LeadSource.AI_RECEPTIONIST),
  status: z.enum([
    LeadStatus.NEW,
    LeadStatus.CONTACTED,
    LeadStatus.COMPLETED,
    LeadStatus.CANCELLED,
  ]),

  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Lead = z.infer<typeof LeadSchema>;

/** The subset needed to create a lead; ids and timestamps come from the DB. */
export type NewLead = Omit<Lead, 'id' | 'createdAt' | 'updatedAt' | 'status'> & {
  status?: LeadStatus;
};

/**
 * Projects collected slots into a lead payload.
 *
 * Throws when a required field is missing: reaching this function without a
 * complete intake is a state-machine bug, and silently writing a half lead
 * would hide it. Callers reach here only after `isIntakeComplete`.
 */
export function buildLeadFromSlots(params: {
  businessId: string;
  callId: string | null;
  values: SlotValues;
  priority?: 'normal' | 'high';
  fieldSources?: Record<string, string>;
  /** Overrides the caller's own notes, e.g. with notes composed from the call. */
  additionalNotes?: string | null;
}): NewLead {
  const { businessId, callId, values } = params;
  const { customerName, customerPhone, serviceType, location } = values;

  const missing: string[] = [];
  if (!customerName) missing.push('customerName');
  if (!customerPhone) missing.push('customerPhone');
  if (!serviceType) missing.push('serviceType');
  if (!location) missing.push('location');
  if (missing.length > 0) {
    throw new Error(
      `Cannot build lead: required slots missing (${missing.join(', ')}). ` +
        'This indicates the state machine reached FINALIZE prematurely.',
    );
  }
  // Re-asserted for the compiler; the guard above is the real check.
  if (!customerName || !customerPhone || !serviceType || !location) {
    throw new Error('unreachable');
  }

  return {
    businessId,
    callId,
    customerName,
    customerPhone,
    service: serviceType,
    location,
    destination: values.destination ?? null,
    vehicleMake: values.vehicleMake ?? null,
    vehicleModel: values.vehicleModel ?? null,
    vehicleType: values.vehicleType ?? null,
    vehicleCondition: values.vehicleCondition ?? null,
    vehicleMovable: values.vehicleMovable ?? null,
    additionalNotes: params.additionalNotes !== undefined ? params.additionalNotes : (values.additionalNotes ?? null),
    priority: params.priority ?? 'normal',
    fieldSources: params.fieldSources ?? {},
    source: LeadSource.AI_RECEPTIONIST,
  };
}

/** One-line vehicle description for tables and notifications. */
export function leadVehicleSummary(lead: Pick<Lead, 'vehicleMake' | 'vehicleModel' | 'vehicleType'>): string | null {
  return describeVehicle({
    vehicleMake: lead.vehicleMake ?? undefined,
    vehicleModel: lead.vehicleModel ?? undefined,
    vehicleType: lead.vehicleType ?? undefined,
  });
}
