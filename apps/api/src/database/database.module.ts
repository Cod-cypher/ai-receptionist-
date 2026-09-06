/**
 * Tenant-scoped database access.
 *
 * Every query runs inside a transaction that first issues
 * `SET LOCAL app.business_id`, which is what the row-level security policies
 * key on. `SET LOCAL` is scoped to the transaction, so a pooled connection
 * handed to the next request carries nothing over from this one.
 *
 * The only way to reach the database is through `withTenant` or the explicitly
 * named `withoutTenant`, so an unscoped query is something you have to ask for
 * by name rather than something you can arrive at by forgetting.
 */

import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** A tenant-scoped handle. Structurally a Database, but only reachable inside `withTenant`. */
export type TenantDatabase = Parameters<Parameters<Database['transaction']>[0]>[0];

export const PG_POOL = Symbol('PG_POOL');

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly db: Database;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.db = drizzle(pool, { schema });
  }

  /**
   * Run work scoped to one tenant.
   *
   * The business id is passed as a bound parameter rather than interpolated:
   * `SET LOCAL` does not accept placeholders directly, so `set_config` is used,
   * which does.
   */
  async withTenant<T>(
    businessId: string,
    work: (tx: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.business_id', ${businessId}, true)`);
      return work(tx);
    });
  }

  /**
   * Run work with no tenant scope.
   *
   * There is exactly one legitimate caller: resolving an inbound call's
   * destination number to a business, which by definition happens before a
   * tenant is known. The migration grants a narrow SELECT-only policy on
   * `phone_numbers` for this, gated on a separate setting, so this escape hatch
   * cannot read leads or transcripts even if it is misused.
   */
  async withRoutingLookup<T>(work: (tx: TenantDatabase) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.routing_lookup', 'on', true)`);
      return work(tx);
    });
  }

  /**
   * Run the notification retry sweeper.
   *
   * Like `withRoutingLookup`, this is a deliberately narrow escape hatch: the
   * matching policy grants SELECT on `notifications` and nothing else, so the
   * sweeper can find work across tenants without being able to read a single
   * lead or transcript.
   */
  async withNotificationSweep<T>(work: (tx: TenantDatabase) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.notification_sweep', 'on', true)`);
      return work(tx);
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.db.execute(sql`SELECT 1`);
      return true;
    } catch (error) {
      this.logger.error(
        `Database health check failed: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          // A call in progress holds a connection only for the length of a turn,
          // but many calls can be in flight at once.
          max: 20,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        }),
    },
    DatabaseService,
  ],
  exports: [DatabaseService, PG_POOL],
})
export class DatabaseModule {}
