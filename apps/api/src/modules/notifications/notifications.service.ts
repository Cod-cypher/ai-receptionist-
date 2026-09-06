/**
 * Outbound notification delivery, with retries.
 *
 * The `notifications` table is the queue. That is a deliberate choice over a
 * Redis-backed job queue: the row has to exist anyway (the dashboard shows
 * delivery state, and the spec requires a failed notification be visible), and
 * a second store means two writes that can disagree — a job in Redis whose row
 * says `pending`, or a row marked `sent` for a job that never ran. With the
 * table as the queue there is one source of truth, it survives a restart, and
 * an operator can see exactly what happened to every message.
 *
 * The ordering that makes the product's promise true:
 *
 *   1. lead + notification(status=pending) are written in ONE transaction
 *   2. only then is delivery attempted
 *
 * So a WhatsApp outage costs a notification, never a lead. The sweeper picks up
 * anything left pending, including work orphaned by a crash between the two
 * steps.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Inject } from '@nestjs/common';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import {
  formatCallbackNotification,
  formatLeadNotification,
  leadNotificationVariables,
  type Lead,
} from '@towai/shared';

import { DatabaseService, type TenantDatabase } from '../../database/database.module';
import { notifications, type NotificationRow } from '../../database/schema';
import {
  WHATSAPP_PROVIDER,
  WhatsAppSendError,
  type WhatsAppProvider,
} from '../../integrations/whatsapp/whatsapp-provider.interface';

/**
 * Backoff schedule. Front-loaded because most failures are transient blips and
 * a towing lead is worth little an hour late; the long tail exists so a genuine
 * provider outage does not exhaust the attempts in ninety seconds.
 */
const RETRY_DELAYS_MS = [
  5_000,      // 5s
  30_000,     // 30s
  120_000,    // 2m
  600_000,    // 10m
  3_600_000,  // 1h
];

const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
const SWEEP_INTERVAL_MS = 5_000;

export interface QueueLeadNotificationInput {
  businessId: string;
  lead: Lead;
  businessName: string;
  timezone: string;
  whatsappNumber: string;
}

export interface QueueCallbackNotificationInput {
  businessId: string;
  callbackRequestId: string;
  customerName: string | null;
  customerPhone: string;
  reason: string;
  createdAt: Date;
  businessName: string;
  timezone: string;
  whatsappNumber: string;
}

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly database: DatabaseService,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    // Do not hold the process open purely to poll for retries.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /* ------------------------------------------------------------------------ */
  /*  Enqueue                                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Writes the pending notification row.
   *
   * Takes the caller's transaction so the row commits atomically with the lead
   * it announces. It deliberately does not send: sending inside the transaction
   * would hold a database connection open across a network call, and a failure
   * would roll back the lead.
   */
  async createLeadNotification(
    tx: TenantDatabase,
    input: QueueLeadNotificationInput,
  ): Promise<NotificationRow> {
    const ctx = { businessName: input.businessName, timezone: input.timezone };

    const [row] = await tx
      .insert(notifications)
      .values({
        businessId: input.businessId,
        channel: 'whatsapp',
        target: input.whatsappNumber,
        leadId: input.lead.id,
        payload: formatLeadNotification(input.lead, ctx),
        status: 'pending',
        nextRetryAt: new Date(),
      })
      .returning();

    return row!;
  }

  async createCallbackNotification(
    tx: TenantDatabase,
    input: QueueCallbackNotificationInput,
  ): Promise<NotificationRow> {
    const ctx = { businessName: input.businessName, timezone: input.timezone };

    const [row] = await tx
      .insert(notifications)
      .values({
        businessId: input.businessId,
        channel: 'whatsapp',
        target: input.whatsappNumber,
        callbackRequestId: input.callbackRequestId,
        payload: formatCallbackNotification(
          {
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            reason: input.reason,
            createdAt: input.createdAt,
          },
          ctx,
        ),
        status: 'pending',
        nextRetryAt: new Date(),
      })
      .returning();

    return row!;
  }

  /* ------------------------------------------------------------------------ */
  /*  Delivery                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Attempt one notification.
   *
   * Returns the resulting status rather than throwing, because a failed
   * notification is an expected outcome with a defined next step, not an error
   * the caller needs to handle.
   */
  async deliver(
    businessId: string,
    notificationId: string,
    templateVariables?: Record<string, string>,
  ): Promise<'sent' | 'failed' | 'dead'> {
    return this.database.withTenant(businessId, async (tx) => {
      const [row] = await tx
        .select()
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .limit(1);

      if (!row || row.status === 'sent' || row.status === 'dead') {
        return (row?.status as 'sent' | 'dead') ?? 'dead';
      }

      const attempts = row.attempts + 1;

      try {
        const result = await this.whatsapp.send({
          to: row.target,
          body: row.payload,
          ...(templateVariables ? { templateVariables } : {}),
        });

        await tx
          .update(notifications)
          .set({
            status: 'sent',
            attempts,
            sentAt: new Date(),
            providerMessageId: result.providerMessageId,
            nextRetryAt: null,
            lastError: null,
          })
          .where(eq(notifications.id, notificationId));

        return 'sent';
      } catch (error) {
        const retryable =
          error instanceof WhatsAppSendError ? error.retryable : true;
        const message = error instanceof Error ? error.message : String(error);

        // Permanent failures are not retried: hammering an invalid number just
        // delays the operator noticing they need to fix their configuration.
        const exhausted = attempts >= MAX_ATTEMPTS || !retryable;
        const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!;

        await tx
          .update(notifications)
          .set({
            status: exhausted ? 'dead' : 'failed',
            attempts,
            lastError: message.slice(0, 1000),
            nextRetryAt: exhausted ? null : new Date(Date.now() + delay),
          })
          .where(eq(notifications.id, notificationId));

        this.logger.warn(
          `Notification ${notificationId} attempt ${attempts} failed` +
            `${exhausted ? ' (giving up)' : `, retrying in ${delay}ms`}: ${message}`,
        );

        return exhausted ? 'dead' : 'failed';
      }
    });
  }

  /**
   * Re-attempt a dead notification on an operator's request, from the dashboard.
   * Resets the attempt counter: the operator has presumably fixed whatever
   * caused it to die.
   */
  async retryManually(businessId: string, notificationId: string): Promise<void> {
    await this.database.withTenant(businessId, async (tx) => {
      await tx
        .update(notifications)
        .set({ status: 'pending', attempts: 0, nextRetryAt: new Date(), lastError: null })
        .where(eq(notifications.id, notificationId));
    });
  }

  /* ------------------------------------------------------------------------ */
  /*  Sweeper                                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Picks up everything due for delivery.
   *
   * This is what makes the guarantee hold across a crash: a lead written and
   * committed with a pending notification is delivered on the next sweep even
   * if the process died immediately after the transaction.
   *
   * Runs unscoped by necessity — it serves every tenant — so it selects only
   * the id and business id, then does the actual work through the normal
   * tenant-scoped path.
   */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;

    try {
      const due = await this.database.withNotificationSweep((tx) =>
        tx
          .select({
            id: notifications.id,
            businessId: notifications.businessId,
          })
          .from(notifications)
          .where(
            and(
              or(eq(notifications.status, 'pending'), eq(notifications.status, 'failed')),
              or(
                isNull(notifications.nextRetryAt),
                lte(notifications.nextRetryAt, sql`now()`),
              ),
            ),
          )
          .limit(50),
      );

      let delivered = 0;
      for (const row of due) {
        const result = await this.deliver(row.businessId, row.id);
        if (result === 'sent') delivered += 1;
      }

      return delivered;
    } catch (error) {
      this.logger.error(
        `Notification sweep failed: ${error instanceof Error ? error.message : error}`,
      );
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  /** Template variables for an approved WhatsApp content template. */
  buildTemplateVariables(
    lead: Lead,
    businessName: string,
    timezone: string,
  ): Record<string, string> {
    return leadNotificationVariables(lead, { businessName, timezone });
  }
}
