/**
 * Live conversation state, keyed by call id.
 *
 * Redis rather than memory so a call survives a deploy or a pod restart, and so
 * a fleet behind a load balancer can handle consecutive webhooks for the same
 * call on different instances — which Twilio's `<Gather>` loop does routinely.
 *
 * This is a cache, not a source of truth. Everything needed to reconstruct a
 * call is in Postgres; losing a key costs the receptionist its place in the
 * conversation, not the caller's answers.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { ConversationContext } from '../conversation/types';

/** Long enough for any real call, short enough not to accumulate. */
const TTL_SECONDS = 60 * 60;

@Injectable()
export class CallSessionStore implements OnModuleDestroy {
  private readonly logger = new Logger(CallSessionStore.name);
  private readonly redis: Redis;
  /** Falls back to memory when Redis is unreachable, so a call still completes. */
  private readonly fallback = new Map<string, ConversationContext>();
  private redisHealthy = true;

  constructor(config: ConfigService) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      // A call in progress cannot wait on a reconnect backoff.
      connectTimeout: 2_000,
    });

    this.redis.on('error', (error) => {
      if (this.redisHealthy) {
        this.redisHealthy = false;
        this.logger.error(
          `Redis unavailable, falling back to in-process session state: ${error.message}`,
        );
      }
    });

    this.redis.on('ready', () => {
      this.redisHealthy = true;
      this.logger.log('Redis connected');
    });

    void this.redis.connect().catch(() => {
      // The error handler above has already logged it.
    });
  }

  private key(callId: string): string {
    return `call:${callId}:context`;
  }

  async save(callId: string, context: ConversationContext): Promise<void> {
    this.fallback.set(callId, context);

    if (!this.redisHealthy) return;
    try {
      await this.redis.set(this.key(callId), JSON.stringify(context), 'EX', TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        `Failed to persist session ${callId} to Redis: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  async load(callId: string): Promise<ConversationContext | null> {
    if (this.redisHealthy) {
      try {
        const raw = await this.redis.get(this.key(callId));
        if (raw) return JSON.parse(raw) as ConversationContext;
      } catch (error) {
        this.logger.warn(
          `Failed to read session ${callId} from Redis: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }

    return this.fallback.get(callId) ?? null;
  }

  async clear(callId: string): Promise<void> {
    this.fallback.delete(callId);
    if (!this.redisHealthy) return;
    try {
      await this.redis.del(this.key(callId));
    } catch {
      // A stale key expires on its own; nothing to recover here.
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
