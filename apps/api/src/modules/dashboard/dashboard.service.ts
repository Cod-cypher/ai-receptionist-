/** The overview counters and recent activity for one towing company. */

import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.module';
import { callbackRequests, calls, leads } from '../../database/schema';

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService) {}

  async overview(businessId: string, since: Date) {
    return this.database.withTenant(businessId, async (tx) => {
      const scoped = eq(calls.businessId, businessId);
      const window = gte(calls.startedAt, since);

      const [
        callsReceived,
        aiAnswered,
        leadsCaptured,
        callbacksOpen,
        recentCalls,
        recentLeads,
      ] = await Promise.all([
        tx.select({ value: count() }).from(calls).where(and(scoped, window)),
        // Every call the receptionist actually handled to a conclusion, as
        // opposed to one that failed before the conversation started.
        tx
          .select({ value: count() })
          .from(calls)
          .where(and(scoped, window, eq(calls.status, 'completed'))),
        tx
          .select({ value: count() })
          .from(leads)
          .where(and(eq(leads.businessId, businessId), gte(leads.createdAt, since))),
        tx
          .select({ value: count() })
          .from(callbackRequests)
          .where(
            and(
              eq(callbackRequests.businessId, businessId),
              eq(callbackRequests.status, 'open'),
            ),
          ),
        tx
          .select({
            id: calls.id,
            fromNumber: calls.fromNumber,
            startedAt: calls.startedAt,
            durationSeconds: calls.durationSeconds,
            outcome: calls.outcome,
            status: calls.status,
          })
          .from(calls)
          .where(scoped)
          .orderBy(desc(calls.startedAt))
          .limit(10),
        tx
          .select()
          .from(leads)
          .where(eq(leads.businessId, businessId))
          .orderBy(desc(leads.createdAt))
          .limit(5),
      ]);

      return {
        since: since.toISOString(),
        callsReceived: callsReceived[0]?.value ?? 0,
        aiAnsweredCalls: aiAnswered[0]?.value ?? 0,
        leadsCaptured: leadsCaptured[0]?.value ?? 0,
        openCallbackRequests: callbacksOpen[0]?.value ?? 0,
        recentCalls,
        recentLeads,
      };
    });
  }
}
