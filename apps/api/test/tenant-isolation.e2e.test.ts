/**
 * Tenant isolation, end to end over HTTP.
 *
 * The unit tests cover the conversation; these cover the promise that matters
 * commercially: two towing companies on one platform can never see each other's
 * callers. Two businesses are registered through the real API, each runs a real
 * call, and then each tries to reach the other's data by every route that
 * exposes it.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { testDatabaseUrls } from './global-setup';

let app: INestApplication;
let server: ReturnType<INestApplication['getHttpServer']>;

interface Tenant {
  businessId: string;
  accessToken: string;
  callId: string;
  leadId: string;
  phoneNumber: string;
}

const tenants: Record<'a' | 'b', Tenant> = {} as never;

/** Registers a business, gives it a number, and runs one call to completion. */
async function setUpTenant(
  name: string,
  email: string,
  phoneNumber: string,
  callerId: string,
): Promise<Tenant> {
  const register = await request(server)
    .post('/api/auth/register')
    .send({
      businessName: name,
      email,
      password: 'a-sufficiently-long-password',
      name: 'Owner',
      timezone: 'Asia/Karachi',
    })
    .expect(201);

  const accessToken: string = register.body.accessToken;
  const businessId: string = register.body.businessId;

  await request(server)
    .post('/api/business')
    .set('Authorization', `Bearer ${accessToken}`);

  // A WhatsApp number so the lead path also creates a notification row.
  await request(server)
    .put('/api/business')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ whatsappNumber: '+923000000001', defaultRegionPrefix: '+92' })
    .expect(200);

  await request(server)
    .post('/api/business/phone-numbers')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ e164: phoneNumber })
    .expect(201);

  // A full call, through the same path a phone call takes.
  const start = await request(server)
    .post('/api/dev/conversations')
    .send({ toNumber: phoneNumber, fromNumber: callerId })
    .expect(201);

  const callId: string = start.body.callId;

  const script = [
    'My car broke down near Liberty Market',
    "It's a Toyota Corolla",
    "It can't move",
    'Ahmed',
    'Yes',
    "Yes that's right",
  ];

  for (const text of script) {
    await request(server)
      .post('/api/dev/conversations/turn')
      .send({ businessId, callId, text })
      .expect(201);
  }

  const leads = await request(server)
    .get('/api/leads')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);

  expect(leads.body.items).toHaveLength(1);

  return { businessId, accessToken, callId, leadId: leads.body.items[0].id, phoneNumber };
}

beforeAll(async () => {
  const { appUrl, migrationUrl } = testDatabaseUrls();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: appUrl,
    DATABASE_MIGRATION_URL: migrationUrl,
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'test-access-secret-that-is-long-enough-here',
    JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-long-enough-x',
    AI_PROVIDER: 'stub',
    WHATSAPP_PROVIDER: 'console',
    ENABLE_DEV_SIMULATOR: 'true',
    TWILIO_VALIDATE_SIGNATURE: 'false',
  });

  const { AppModule } = await import('../src/app.module');

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
  server = app.getHttpServer();

  tenants.a = await setUpTenant(
    'Company A Towing',
    'a@example.test',
    '+924235000101',
    '+923001111111',
  );
  tenants.b = await setUpTenant(
    'Company B Towing',
    'b@example.test',
    '+924235000102',
    '+923002222222',
  );
});

afterAll(async () => {
  await app?.close();
});

describe('two towing companies on one platform', () => {
  it('each sees only its own leads', async () => {
    for (const key of ['a', 'b'] as const) {
      const response = await request(server)
        .get('/api/leads')
        .set('Authorization', `Bearer ${tenants[key].accessToken}`)
        .expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.items[0].id).toBe(tenants[key].leadId);
      expect(response.body.items[0].businessId).toBe(tenants[key].businessId);
    }
  });

  it("cannot read the other's lead by id", async () => {
    // 404 rather than 403: a 403 would confirm the id exists.
    await request(server)
      .get(`/api/leads/${tenants.b.leadId}`)
      .set('Authorization', `Bearer ${tenants.a.accessToken}`)
      .expect(404);

    await request(server)
      .get(`/api/leads/${tenants.a.leadId}`)
      .set('Authorization', `Bearer ${tenants.b.accessToken}`)
      .expect(404);
  });

  it("cannot change the status of the other's lead", async () => {
    await request(server)
      .patch(`/api/leads/${tenants.b.leadId}/status`)
      .set('Authorization', `Bearer ${tenants.a.accessToken}`)
      .send({ status: 'cancelled' })
      .expect(404);

    // And B's lead is untouched.
    const check = await request(server)
      .get(`/api/leads/${tenants.b.leadId}`)
      .set('Authorization', `Bearer ${tenants.b.accessToken}`)
      .expect(200);
    expect(check.body.status).toBe('new');
  });

  it("cannot read the other's call, transcript or event trail", async () => {
    await request(server)
      .get(`/api/calls/${tenants.b.callId}`)
      .set('Authorization', `Bearer ${tenants.a.accessToken}`)
      .expect(404);

    const own = await request(server)
      .get(`/api/calls/${tenants.a.callId}`)
      .set('Authorization', `Bearer ${tenants.a.accessToken}`)
      .expect(200);

    // The transcript is readable by its owner, which is what makes the denial
    // above meaningful rather than a route that is simply broken.
    expect(own.body.transcript.length).toBeGreaterThan(0);
    expect(own.body.events.length).toBeGreaterThan(0);
  });

  it('each call list contains only that tenant\'s calls', async () => {
    for (const key of ['a', 'b'] as const) {
      const response = await request(server)
        .get('/api/calls')
        .set('Authorization', `Bearer ${tenants[key].accessToken}`)
        .expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.items[0].id).toBe(tenants[key].callId);
    }
  });

  it("cannot read the other's notifications", async () => {
    for (const key of ['a', 'b'] as const) {
      const response = await request(server)
        .get('/api/notifications')
        .set('Authorization', `Bearer ${tenants[key].accessToken}`)
        .expect(200);

      expect(response.body.total).toBe(1);
      for (const item of response.body.items) {
        expect(item.businessId).toBe(tenants[key].businessId);
      }
    }
  });

  it('dashboard counters are scoped to the tenant', async () => {
    for (const key of ['a', 'b'] as const) {
      const response = await request(server)
        .get('/api/dashboard/overview')
        .set('Authorization', `Bearer ${tenants[key].accessToken}`)
        .expect(200);

      expect(response.body.callsReceived).toBe(1);
      expect(response.body.leadsCaptured).toBe(1);
    }
  });

  it("cannot read the other's business settings", async () => {
    const response = await request(server)
      .get('/api/business')
      .set('Authorization', `Bearer ${tenants.a.accessToken}`)
      .expect(200);

    expect(response.body.business.id).toBe(tenants.a.businessId);
    expect(response.body.business.name).toBe('Company A Towing');
  });

  it('rejects requests with no token, and with a tampered one', async () => {
    await request(server).get('/api/leads').expect(401);

    const [header, payload] = tenants.a.accessToken.split('.');
    // Re-sign is impossible without the secret; a swapped payload must fail.
    const forged = `${header}.${payload}.not-a-real-signature`;
    await request(server)
      .get('/api/leads')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });
});
