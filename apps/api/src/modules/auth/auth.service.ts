/**
 * Authentication.
 *
 * The access token carries `businessId`, and every tenant-scoped query derives
 * its scope from that claim rather than from anything in the request body or
 * path. A user cannot ask for another business's data because there is nowhere
 * in the request to say which business they mean.
 */

import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

import { DatabaseService } from '../../database/database.module';
import {
  businessSettings,
  businesses,
  refreshTokens,
  services,
  users,
  type UserRow,
} from '../../database/schema';

/** The services a towing company starts with; all editable afterwards. */
const DEFAULT_SERVICES = [
  'Local towing',
  'Long-distance towing',
  'Flatbed towing',
  'Motorcycle towing',
  'Roadside assistance',
  'Jump starts',
  'Tire changes',
  'Fuel delivery',
  'Lockouts',
];

export interface AccessTokenClaims {
  sub: string;
  businessId: string;
  email: string;
  role: 'owner' | 'manager' | 'agent';
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RegisterInput {
  businessName: string;
  email: string;
  password: string;
  name: string;
  timezone?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Creates a business and its first owner together.
   *
   * Runs unscoped because the tenant does not exist yet — this is the one
   * write that legitimately precedes a tenant context. It uses the owner
   * connection path via a raw transaction that sets the new business id as soon
   * as it is known, so the dependent inserts are already policy-compliant.
   */
  async register(input: RegisterInput): Promise<{ tokens: AuthTokens; user: UserRow }> {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

    const existing = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email))
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictException('An account with that email already exists');
    }

    const user = await this.database.db.transaction(async (tx) => {
      const [business] = await tx
        .insert(businesses)
        .values({
          name: input.businessName,
          timezone: input.timezone ?? 'UTC',
        })
        .returning();

      // From here on the transaction is scoped, so the remaining inserts are
      // subject to the same policies as any other write.
      await tx.execute(sql`SELECT set_config('app.business_id', ${business!.id}, true)`);

      const [created] = await tx
        .insert(users)
        .values({
          businessId: business!.id,
          email,
          passwordHash,
          name: input.name,
          role: 'owner',
        })
        .returning();

      await tx.insert(businessSettings).values({ businessId: business!.id });

      await tx.insert(services).values(
        DEFAULT_SERVICES.map((name, index) => ({
          businessId: business!.id,
          name,
          sortOrder: index,
        })),
      );

      return created!;
    });

    return { tokens: await this.issueTokens(user), user };
  }

  async login(email: string, password: string): Promise<{ tokens: AuthTokens; user: UserRow }> {
    const normalised = email.trim().toLowerCase();

    const rows = await this.database.db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.email})`, normalised))
      .limit(1);

    const user = rows[0];

    // Verify against a dummy hash when the user does not exist, so a missing
    // account and a wrong password take the same time to reject.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const valid = await argon2.verify(hash, password).catch(() => false);

    if (!user || !valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.database.withTenant(user.businessId, (tx) =>
      tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id)),
    );

    return { tokens: await this.issueTokens(user), user };
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * The old token is revoked on use. A refresh token presented twice means it
   * leaked, and the second presentation fails.
   */
  async refresh(rawToken: string): Promise<AuthTokens> {
    const tokenHash = hashToken(rawToken);

    const rows = await this.database.db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
      .limit(1);

    const stored = rows[0];
    if (!stored || stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    return this.database.withTenant(stored.businessId, async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, stored.id));

      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, stored.userId))
        .limit(1);

      if (!user) throw new UnauthorizedException('Account no longer exists');

      return this.issueTokens(user);
    });
  }

  async logout(rawToken: string): Promise<void> {
    await this.database.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.tokenHash, hashToken(rawToken)));
  }

  private async issueTokens(user: UserRow): Promise<AuthTokens> {
    const claims: AccessTokenClaims = {
      sub: user.id,
      businessId: user.businessId,
      email: user.email,
      role: user.role,
    };

    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // jsonwebtoken types this as a template-literal union ("15m", "1h", ...);
      // the value is validated as a duration string by the config schema.
      expiresIn: this.config.get<string>(
        'JWT_ACCESS_TTL',
        '15m',
      ) as unknown as number,
    });

    // Opaque and random rather than a JWT: it must be revocable, and only its
    // hash is stored, so a database leak yields no usable sessions.
    const refreshToken = randomBytes(48).toString('base64url');

    await this.database.withTenant(user.businessId, (tx) =>
      tx.insert(refreshTokens).values({
        userId: user.id,
        businessId: user.businessId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + parseTtlMs(this.config.get('JWT_REFRESH_TTL', '30d'))),
      }),
    );

    return { accessToken, refreshToken };
  }
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** A valid argon2id hash of a random value, used to equalise login timing. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$J9mYyQwLKQxKZ0V0Y0Z0Y0Z0Y0Z0Y0Z0Y0Z0Y0Z0Y0';

function parseTtlMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return 30 * 24 * 60 * 60 * 1000;

  const value = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return value * multiplier;
}
