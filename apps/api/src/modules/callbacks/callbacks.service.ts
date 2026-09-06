/** Callback requests: what the receptionist could not answer itself. */

import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.module';
import { auditLogs, callbackRequests, type CallbackRequestRow } from '../../database/schema';

@Injectable()
export class CallbacksService {
  constructor(private readonly database: DatabaseService) {}

  async list(
    businessId: string,
    query: { status?: 'open' | 'resolved'; limit: number; offset: number },
  ) {
    return this.database.withTenant(businessId, async (tx) => {
      const filters: SQL[] = [eq(callbackRequests.businessId, businessId)];
      if (query.status) filters.push(eq(callbackRequests.status, query.status));
      const where = and(...filters);

      const [items, totals] = await Promise.all([
        tx
          .select()
          .from(callbackRequests)
          .where(where)
          .orderBy(desc(callbackRequests.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        tx.select({ value: count() }).from(callbackRequests).where(where),
      ]);

      return { items, total: totals[0]?.value ?? 0, limit: query.limit, offset: query.offset };
    });
  }

  async findOne(businessId: string, id: string): Promise<CallbackRequestRow> {
    const row = await this.database.withTenant(businessId, async (tx) => {
      const rows = await tx
        .select()
        .from(callbackRequests)
        .where(and(eq(callbackRequests.id, id), eq(callbackRequests.businessId, businessId)))
        .limit(1);
      return rows[0];
    });

    if (!row) throw new NotFoundException('Callback request not found');
    return row;
  }

  async updateStatus(
    businessId: string,
    userId: string,
    id: string,
    status: 'open' | 'resolved',
  ): Promise<CallbackRequestRow> {
    return this.database.withTenant(businessId, async (tx) => {
      const updated = await tx
        .update(callbackRequests)
        .set({ status })
        .where(and(eq(callbackRequests.id, id), eq(callbackRequests.businessId, businessId)))
        .returning();

      const row = updated[0];
      if (!row) throw new NotFoundException('Callback request not found');

      await tx.insert(auditLogs).values({
        businessId,
        userId,
        action: 'callback.status_changed',
        resourceType: 'callback_request',
        resourceId: id,
        metadata: { status },
      });

      return row;
    });
  }
}
