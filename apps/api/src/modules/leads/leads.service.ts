/**
 * Lead queries and status changes.
 *
 * Every method takes `businessId` as its first argument and passes it to
 * `withTenant`. There is no overload that omits it, so a tenant-unscoped lead
 * query is not something this service can express.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, gte, ilike, or, type SQL } from 'drizzle-orm';
import { LEAD_STATUSES, type LeadStatus } from '@towai/shared';

import { DatabaseService } from '../../database/database.module';
import { auditLogs, calls, leads, type LeadRow } from '../../database/schema';

export interface ListLeadsQuery {
  status?: LeadStatus;
  /** Matches customer name, phone, location or vehicle. */
  search?: string;
  since?: Date;
  limit: number;
  offset: number;
}

export interface ListLeadsResult {
  items: LeadRow[];
  total: number;
  limit: number;
  offset: number;
}

@Injectable()
export class LeadsService {
  constructor(private readonly database: DatabaseService) {}

  async list(businessId: string, query: ListLeadsQuery): Promise<ListLeadsResult> {
    return this.database.withTenant(businessId, async (tx) => {
      const filters: SQL[] = [eq(leads.businessId, businessId)];

      if (query.status) filters.push(eq(leads.status, query.status));
      if (query.since) filters.push(gte(leads.createdAt, query.since));

      if (query.search) {
        const term = `%${query.search}%`;
        const match = or(
          ilike(leads.customerName, term),
          ilike(leads.customerPhone, term),
          ilike(leads.location, term),
          ilike(leads.vehicleMake, term),
          ilike(leads.vehicleModel, term),
        );
        if (match) filters.push(match);
      }

      const where = and(...filters);

      const [items, totals] = await Promise.all([
        tx
          .select()
          .from(leads)
          .where(where)
          .orderBy(desc(leads.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        tx.select({ value: count() }).from(leads).where(where),
      ]);

      return {
        items,
        total: totals[0]?.value ?? 0,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  async findOne(businessId: string, leadId: string): Promise<LeadRow> {
    const row = await this.database.withTenant(businessId, async (tx) => {
      const rows = await tx
        .select()
        .from(leads)
        .where(and(eq(leads.id, leadId), eq(leads.businessId, businessId)))
        .limit(1);
      return rows[0];
    });

    // A lead belonging to another tenant is reported as absent, not forbidden:
    // a 403 would confirm the id exists.
    if (!row) throw new NotFoundException('Lead not found');
    return row;
  }

  async updateStatus(
    businessId: string,
    userId: string,
    leadId: string,
    status: LeadStatus,
  ): Promise<LeadRow> {
    if (!LEAD_STATUSES.includes(status)) {
      throw new NotFoundException(`Unknown lead status: ${status}`);
    }

    return this.database.withTenant(businessId, async (tx) => {
      const updated = await tx
        .update(leads)
        .set({ status })
        .where(and(eq(leads.id, leadId), eq(leads.businessId, businessId)))
        .returning();

      const row = updated[0];
      if (!row) throw new NotFoundException('Lead not found');

      await tx.insert(auditLogs).values({
        businessId,
        userId,
        action: 'lead.status_changed',
        resourceType: 'lead',
        resourceId: leadId,
        metadata: { status },
      });

      return row;
    });
  }

  /** The lead produced by a given call, if any. Used on the call detail page. */
  async findByCall(businessId: string, callId: string): Promise<LeadRow | null> {
    return this.database.withTenant(businessId, async (tx) => {
      const rows = await tx
        .select()
        .from(leads)
        .where(and(eq(leads.callId, callId), eq(leads.businessId, businessId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }
}
