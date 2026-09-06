/** Call history, transcripts and the per-call event trail. */

import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, type SQL } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.module';
import {
  callEvents,
  callbackRequests,
  calls,
  leads,
  transcripts,
  type CallRow,
} from '../../database/schema';

export interface ListCallsQuery {
  outcome?: string;
  limit: number;
  offset: number;
}

@Injectable()
export class CallsService {
  constructor(private readonly database: DatabaseService) {}

  async list(businessId: string, query: ListCallsQuery) {
    return this.database.withTenant(businessId, async (tx) => {
      const filters: SQL[] = [eq(calls.businessId, businessId)];
      if (query.outcome) filters.push(eq(calls.outcome, query.outcome as never));
      const where = and(...filters);

      const [items, totals] = await Promise.all([
        tx
          .select()
          .from(calls)
          .where(where)
          .orderBy(desc(calls.startedAt))
          .limit(query.limit)
          .offset(query.offset),
        tx.select({ value: count() }).from(calls).where(where),
      ]);

      return { items, total: totals[0]?.value ?? 0, limit: query.limit, offset: query.offset };
    });
  }

  /**
   * Everything about one call, for the detail view: the transcript, the
   * extracted fields, the decision trail, and whatever record it produced.
   */
  async findOneDetailed(businessId: string, callId: string) {
    return this.database.withTenant(businessId, async (tx) => {
      const rows = await tx
        .select()
        .from(calls)
        .where(and(eq(calls.id, callId), eq(calls.businessId, businessId)))
        .limit(1);

      const call: CallRow | undefined = rows[0];
      if (!call) throw new NotFoundException('Call not found');

      const [transcriptRows, eventRows, leadRows, callbackRows] = await Promise.all([
        tx
          .select()
          .from(transcripts)
          .where(eq(transcripts.callId, callId))
          .orderBy(asc(transcripts.turnIndex)),
        tx
          .select()
          .from(callEvents)
          .where(eq(callEvents.callId, callId))
          .orderBy(asc(callEvents.sequence)),
        tx.select().from(leads).where(eq(leads.callId, callId)),
        tx.select().from(callbackRequests).where(eq(callbackRequests.callId, callId)),
      ]);

      return {
        call,
        transcript: transcriptRows,
        events: eventRows,
        lead: leadRows[0] ?? null,
        callbackRequests: callbackRows,
        extractedInformation: call.collectedData ?? {},
      };
    });
  }
}
