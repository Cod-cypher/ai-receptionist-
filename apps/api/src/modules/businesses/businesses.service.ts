/**
 * Business configuration management.
 *
 * The receptionist settings deserve a note. An operator can shape tone, write a
 * greeting, add FAQ entries and give style guidance — but `businessInstructions`
 * is rendered into the prompt inside a fenced, explicitly-untrusted block and
 * is length-capped here. There is deliberately no field that accepts a raw
 * system prompt: the workflow, the guardrails and the "only state configured
 * facts" rule are not tenant-configurable, because a tenant who could edit them
 * could make the receptionist quote prices or promise arrival times.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { DatabaseService } from '../../database/database.module';
import {
  auditLogs,
  businessSettings,
  businesses,
  phoneNumbers,
  services,
} from '../../database/schema';

export const UpdateBusinessSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  website: z.string().trim().url().max(300).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  timezone: z.string().trim().max(64).optional(),
  serviceAreas: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  businessHours: z
    .array(
      z.object({
        day: z.number().int().min(0).max(6),
        open: z.string().regex(/^\d{2}:\d{2}$/),
        close: z.string().regex(/^\d{2}:\d{2}$/),
        closed: z.boolean().default(false),
      }),
    )
    .max(7)
    .optional(),
  pricingInfo: z.string().trim().max(2000).nullable().optional(),
  emergencyContact: z.string().trim().max(32).nullable().optional(),
  whatsappNumber: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, 'WhatsApp number must be in E.164 format, e.g. +923001234567')
    .nullable()
    .optional(),
  defaultRegionPrefix: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{0,3}$/)
    .nullable()
    .optional(),
});

export const UpdateSettingsSchema = z.object({
  greeting: z.string().trim().max(300).nullable().optional(),
  tone: z.enum(['professional', 'friendly', 'calm']).optional(),
  // Capped, and rendered as untrusted data rather than as instructions.
  businessInstructions: z.string().trim().max(2000).nullable().optional(),
  faq: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(300),
        answer: z.string().trim().min(1).max(1000),
      }),
    )
    .max(50)
    .optional(),
  fallbackBehavior: z.enum(['callback', 'emergency_contact']).optional(),
  voiceId: z.string().trim().max(120).nullable().optional(),
  language: z.string().trim().max(16).optional(),
  maxCallSeconds: z.number().int().min(60).max(1800).optional(),
});

export type UpdateBusinessInput = z.infer<typeof UpdateBusinessSchema>;
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;

@Injectable()
export class BusinessesService {
  constructor(private readonly database: DatabaseService) {}

  async getProfile(businessId: string) {
    return this.database.withTenant(businessId, async (tx) => {
      const [business] = await tx
        .select()
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      if (!business) throw new NotFoundException('Business not found');

      const [settings] = await tx
        .select()
        .from(businessSettings)
        .where(eq(businessSettings.businessId, businessId))
        .limit(1);

      const [serviceRows, numbers] = await Promise.all([
        tx
          .select()
          .from(services)
          .where(eq(services.businessId, businessId))
          .orderBy(asc(services.sortOrder), asc(services.name)),
        tx.select().from(phoneNumbers).where(eq(phoneNumbers.businessId, businessId)),
      ]);

      return { business, settings: settings ?? null, services: serviceRows, phoneNumbers: numbers };
    });
  }

  async updateBusiness(businessId: string, userId: string, input: UpdateBusinessInput) {
    return this.database.withTenant(businessId, async (tx) => {
      const updated = await tx
        .update(businesses)
        .set(input)
        .where(eq(businesses.id, businessId))
        .returning();

      if (!updated[0]) throw new NotFoundException('Business not found');

      await tx.insert(auditLogs).values({
        businessId,
        userId,
        action: 'business.updated',
        resourceType: 'business',
        resourceId: businessId,
        metadata: { fields: Object.keys(input) },
      });

      return updated[0];
    });
  }

  async updateSettings(businessId: string, userId: string, input: UpdateSettingsInput) {
    return this.database.withTenant(businessId, async (tx) => {
      const existing = await tx
        .select({ id: businessSettings.id })
        .from(businessSettings)
        .where(eq(businessSettings.businessId, businessId))
        .limit(1);

      const row = existing[0]
        ? (
            await tx
              .update(businessSettings)
              .set(input)
              .where(eq(businessSettings.businessId, businessId))
              .returning()
          )[0]
        : (await tx.insert(businessSettings).values({ businessId, ...input }).returning())[0];

      await tx.insert(auditLogs).values({
        businessId,
        userId,
        action: 'business_settings.updated',
        resourceType: 'business_settings',
        resourceId: row!.id,
        metadata: { fields: Object.keys(input) },
      });

      return row!;
    });
  }

  async listServices(businessId: string) {
    return this.database.withTenant(businessId, (tx) =>
      tx
        .select()
        .from(services)
        .where(eq(services.businessId, businessId))
        .orderBy(asc(services.sortOrder), asc(services.name)),
    );
  }

  async createService(
    businessId: string,
    input: { name: string; description?: string | null; sortOrder?: number },
  ) {
    return this.database.withTenant(businessId, async (tx) => {
      const rows = await tx
        .insert(services)
        .values({
          businessId,
          name: input.name,
          description: input.description ?? null,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning();
      return rows[0]!;
    });
  }

  async updateService(
    businessId: string,
    serviceId: string,
    input: { name?: string; description?: string | null; isActive?: boolean; sortOrder?: number },
  ) {
    return this.database.withTenant(businessId, async (tx) => {
      const rows = await tx
        .update(services)
        .set(input)
        .where(and(eq(services.id, serviceId), eq(services.businessId, businessId)))
        .returning();
      if (!rows[0]) throw new NotFoundException('Service not found');
      return rows[0];
    });
  }

  async deleteService(businessId: string, serviceId: string) {
    await this.database.withTenant(businessId, (tx) =>
      tx
        .delete(services)
        .where(and(eq(services.id, serviceId), eq(services.businessId, businessId))),
    );
  }

  /** Attach a telephony number so inbound calls route to this tenant. */
  async addPhoneNumber(businessId: string, e164: string, providerSid?: string) {
    return this.database.withTenant(businessId, async (tx) => {
      const rows = await tx
        .insert(phoneNumbers)
        .values({ businessId, e164, providerSid: providerSid ?? null })
        .returning();
      return rows[0]!;
    });
  }
}
