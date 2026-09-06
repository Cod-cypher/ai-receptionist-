/**
 * Assembles the runtime configuration for one business's receptionist.
 *
 * This is the boundary that turns stored tenant data into the narrow
 * `BusinessFacts` the model is allowed to see. Anything not projected here
 * cannot be spoken on a call, which is what makes "only state configured
 * information" an enforced property rather than a prompt instruction.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import {
  formatBusinessHours,
  isOpenAt,
  type BusinessFacts,
  type BusinessHours,
} from '@towai/shared';

import { DatabaseService } from '../../database/database.module';
import {
  businessSettings,
  businesses,
  phoneNumbers,
  services,
  type BusinessRow,
  type BusinessSettingsRow,
} from '../../database/schema';
import {
  DEFAULT_FLOW_LIMITS,
  type FlowConfig,
} from '../../conversation/types';

export interface ReceptionistConfig {
  business: BusinessRow;
  settings: BusinessSettingsRow | null;
  flow: FlowConfig;
  /** Where lead notifications go. Null means the operator has not set one up. */
  whatsappNumber: string | null;
  defaultRegionPrefix: string | undefined;
  maxCallSeconds: number;
}

@Injectable()
export class BusinessConfigService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Resolve an inbound call's destination number to a tenant.
   *
   * The one lookup that legitimately runs before a tenant is known — a call
   * arrives carrying only a number. It goes through the narrow routing policy,
   * which grants SELECT on `phone_numbers` and nothing else.
   */
  async findBusinessIdByPhoneNumber(e164: string): Promise<string | null> {
    const rows = await this.database.withRoutingLookup((tx) =>
      tx
        .select({ businessId: phoneNumbers.businessId })
        .from(phoneNumbers)
        .where(eq(phoneNumbers.e164, e164))
        .limit(1),
    );

    return rows[0]?.businessId ?? null;
  }

  /** Load everything the conversation engine needs for a call. */
  async load(businessId: string, now: Date = new Date()): Promise<ReceptionistConfig> {
    return this.database.withTenant(businessId, async (tx) => {
      const [business] = await tx
        .select()
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);

      if (!business) {
        throw new NotFoundException(`Business ${businessId} not found`);
      }

      const [settings] = await tx
        .select()
        .from(businessSettings)
        .where(eq(businessSettings.businessId, businessId))
        .limit(1);

      const serviceRows = await tx
        .select()
        .from(services)
        .where(and(eq(services.businessId, businessId), eq(services.isActive, true)))
        .orderBy(asc(services.sortOrder), asc(services.name));

      const hours = (business.businessHours ?? []) as BusinessHours[];

      const facts: BusinessFacts = {
        name: business.name,
        phone: business.phone,
        website: business.website,
        address: business.address,
        serviceAreas: business.serviceAreas ?? [],
        services: serviceRows.map((s) => s.name),
        businessHoursText: formatBusinessHours(hours),
        isOpenNow: isOpenAt(hours, business.timezone, now),
        pricingInfo: business.pricingInfo,
        emergencyContact: business.emergencyContact,
        faq: settings?.faq ?? [],
        tone: settings?.tone ?? 'friendly',
        businessInstructions: settings?.businessInstructions ?? null,
      };

      const flow: FlowConfig = {
        facts,
        greeting: settings?.greeting ?? null,
        fallbackBehavior: settings?.fallbackBehavior ?? 'callback',
        ...DEFAULT_FLOW_LIMITS,
      };

      return {
        business,
        settings: settings ?? null,
        flow,
        whatsappNumber: business.whatsappNumber,
        defaultRegionPrefix: business.defaultRegionPrefix ?? undefined,
        maxCallSeconds: settings?.maxCallSeconds ?? 300,
      };
    });
  }
}
