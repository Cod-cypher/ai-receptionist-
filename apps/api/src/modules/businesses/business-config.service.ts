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

/**
 * How long a configuration read for one operation of a call serves the
 * next ones. A call makes several operations per caller turn, and each one
 * read the business, its settings and its services again: three queries in
 * a transaction, in the caller's wait for a reply. Short, so a change saved
 * on the dashboard, or the business opening or closing, reaches a call in
 * progress within the time of a sentence or two.
 */
export const CALL_CONFIG_TTL_MS = 30_000;

@Injectable()
export class BusinessConfigService {
  /** The latest configuration read for each business, and when. */
  private readonly recent = new Map<string, { at: number; config: Promise<ReceptionistConfig> }>();

  constructor(private readonly database: DatabaseService) {}

  /**
   * The configuration for an operation on a call in progress: the one read
   * within the last `CALL_CONFIG_TTL_MS`, or a fresh one. A call's start
   * reads afresh (`load`), so a new call never begins on old settings.
   */
  async loadForCall(businessId: string): Promise<ReceptionistConfig> {
    const cached = this.recent.get(businessId);
    if (cached && Date.now() - cached.at < CALL_CONFIG_TTL_MS) return cached.config;
    return this.load(businessId);
  }

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

  /**
   * Every business a phone number routes calls to, through the same routing
   * policy: what the greeting warm-up records before any call arrives.
   */
  async routedBusinessIds(): Promise<string[]> {
    const rows = await this.database.withRoutingLookup((tx) => tx.selectDistinct({ businessId: phoneNumbers.businessId }).from(phoneNumbers));
    return rows.map((row) => row.businessId);
  }

  /** Load everything the conversation engine needs for a call. */
  async load(businessId: string, now: Date = new Date()): Promise<ReceptionistConfig> {
    const config = this.read(businessId, now);
    // Kept for the operations that follow on the call; a read that failed is not.
    const entry = { at: Date.now(), config };
    this.recent.set(businessId, entry);
    config.catch(() => {
      if (this.recent.get(businessId) === entry) this.recent.delete(businessId);
    });
    return config;
  }

  private async read(businessId: string, now: Date): Promise<ReceptionistConfig> {
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
