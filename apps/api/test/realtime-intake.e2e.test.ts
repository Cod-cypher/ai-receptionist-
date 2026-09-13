/**
 * The realtime receptionist's tools against a real database.
 *
 * The model can ask to complete or end a call; these tests pin down that the
 * backend alone decides what that creates, that it happens in the same
 * transaction model as every other pipeline (lead and notification row
 * together), and that a call is only reachable through its own tenant.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { testDatabaseUrls } from './global-setup';

let app: INestApplication;
let server: ReturnType<INestApplication['getHttpServer']>;
let database: import('../src/database/database.module').DatabaseService;
let schema: typeof import('../src/database/schema');
let callSession: import('../src/call-session/call-session.service').CallSessionService;

let businessId: string;
let otherBusinessId: string;
const phoneNumber = '+924235000301';

async function register(name: string, email: string) {
  const res = await request(server)
    .post('/api/auth/register')
    .send({ businessName: name, email, password: 'a-sufficiently-long-password', name: 'Owner', timezone: 'Asia/Karachi' })
    .expect(201);
  return { token: res.body.accessToken as string, businessId: res.body.businessId as string };
}

async function startCall(fromNumber: string): Promise<string> {
  const start = await request(server).post('/api/dev/conversations').send({ toNumber: phoneNumber, fromNumber }).expect(201);
  return start.body.callId as string;
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
  const { DatabaseService } = await import('../src/database/database.module');
  const { CallSessionService } = await import('../src/call-session/call-session.service');
  schema = await import('../src/database/schema');

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
  server = app.getHttpServer();
  database = moduleRef.get(DatabaseService);
  callSession = moduleRef.get(CallSessionService);

  const owner = await register('Realtime Towing', 'realtime@example.test');
  businessId = owner.businessId;
  await request(server).put('/api/business').set('Authorization', `Bearer ${owner.token}`).send({ whatsappNumber: '+923000000031' }).expect(200);
  await request(server).post('/api/business/phone-numbers').set('Authorization', `Bearer ${owner.token}`).send({ e164: phoneNumber }).expect(201);

  otherBusinessId = (await register('Other Towing', 'realtime-other@example.test')).businessId;
});

afterAll(async () => {
  await app?.close();
});

describe('realtime intake tools', () => {
  it('create the lead and its notification together, only after the read-back is confirmed', async () => {
    const callId = await startCall('+18174090001');

    const saved = await callSession.applyIntakeOperation(businessId, callId, {
      kind: 'update',
      slots: { serviceType: 'towing', location: 'I-95 near exit 42', vehicleType: 'semi truck', vehicleMovable: false, customerName: 'Mike' },
      callerIdConfirmed: true,
    });
    expect(saved.ended).toBe(false);

    const readBack = await callSession.applyIntakeOperation(businessId, callId, { kind: 'complete', callerConfirmed: true });
    expect(readBack.output.needsConfirmation).toBe(true);

    const leadsBefore = await database.withTenant(businessId, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.callId, callId)),
    );
    expect(leadsBefore).toHaveLength(0);

    const done = await callSession.applyIntakeOperation(businessId, callId, { kind: 'complete', callerConfirmed: true });
    expect(done.ended).toBe(true);
    expect(done.outcome).toBe('lead_created');

    const { leads, notifications, call } = await database.withTenant(businessId, async (tx) => ({
      leads: await tx.select().from(schema.leads).where(eq(schema.leads.callId, callId)),
      notifications: await tx.select().from(schema.notifications).where(eq(schema.notifications.businessId, businessId)),
      call: (await tx.select().from(schema.calls).where(eq(schema.calls.id, callId)))[0],
    }));

    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ customerName: 'Mike', location: 'I-95 near exit 42', vehicleType: 'Semi Truck', vehicleMovable: false });
    expect(notifications.some((n) => n.leadId === leads[0]!.id)).toBe(true);
    expect(call).toMatchObject({ status: 'completed', outcome: 'lead_created' });
  });

  it('turn an ended call with partial details into a callback', async () => {
    const callId = await startCall('+18174090002');
    await callSession.applyIntakeOperation(businessId, callId, { kind: 'update', slots: { location: 'I-95' } });

    const ended = await callSession.applyIntakeOperation(businessId, callId, { kind: 'end', reason: 'caller had to go' });
    expect(ended.outcome).toBe('callback_created');

    const callbacks = await database.withTenant(businessId, (tx) =>
      tx.select().from(schema.callbackRequests).where(eq(schema.callbackRequests.callId, callId)),
    );
    expect(callbacks).toHaveLength(1);
  });

  it('record the caller\'s words and the receptionist\'s in order', async () => {
    const callId = await startCall('+18174090003');
    await callSession.applyIntakeOperation(businessId, callId, { kind: 'caller_speech', text: 'Hello? Can you hear me?' });
    await callSession.appendAiTranscriptLine(businessId, callId, "Yes, I'm here. How can I help?");

    const lines = await database.withTenant(businessId, (tx) =>
      tx.select().from(schema.transcripts).where(eq(schema.transcripts.callId, callId)).orderBy(schema.transcripts.turnIndex),
    );
    expect(lines.map((l) => `${l.speaker}: ${l.text}`).slice(-2)).toEqual([
      'customer: Hello? Can you hear me?',
      "ai: Yes, I'm here. How can I help?",
    ]);
  });

  it('cannot reach a call through another business', async () => {
    const callId = await startCall('+18174090004');
    await expect(
      callSession.applyIntakeOperation(otherBusinessId, callId, { kind: 'update', slots: { customerName: 'Mallory' } }),
    ).rejects.toThrow(/not found/);
  });
});
