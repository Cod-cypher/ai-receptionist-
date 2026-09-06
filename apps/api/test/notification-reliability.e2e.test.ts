/**
 * The reliability promise: a WhatsApp outage costs a notification, never a lead.
 *
 * This is the one failure mode that would quietly destroy the product's value —
 * a towing company that stops trusting the notifications has no reason to keep
 * paying — so it is tested against a real database with a provider that is
 * genuinely failing, rather than against a mock of the happy path.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { testDatabaseUrls } from './global-setup';
import {
  WHATSAPP_PROVIDER,
  WhatsAppSendError,
  type WhatsAppMessage,
  type WhatsAppProvider,
  type WhatsAppSendResult,
} from '../src/integrations/whatsapp/whatsapp-provider.interface';

/** A provider whose behaviour the test drives. */
class ControllableWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'controllable';
  mode: 'ok' | 'transient' | 'permanent' = 'ok';
  readonly sent: WhatsAppMessage[] = [];
  attempts = 0;

  async send(message: WhatsAppMessage): Promise<WhatsAppSendResult> {
    this.attempts += 1;

    if (this.mode === 'transient') {
      throw new WhatsAppSendError('upstream 503 from WhatsApp', true);
    }
    if (this.mode === 'permanent') {
      throw new WhatsAppSendError('21211 invalid To number', false);
    }

    this.sent.push(message);
    return { providerMessageId: `test-${this.attempts}` };
  }
}

let app: INestApplication;
let server: ReturnType<INestApplication['getHttpServer']>;
let whatsapp: ControllableWhatsAppProvider;
let database: import('../src/database/database.module').DatabaseService;
let schema: typeof import('../src/database/schema');

let accessToken: string;
let businessId: string;
let phoneNumber = '+924235000201';

/** Runs a complete call that ends in a lead. */
async function runCallToLead(callerId: string): Promise<void> {
  const start = await request(server)
    .post('/api/dev/conversations')
    .send({ toNumber: phoneNumber, fromNumber: callerId })
    .expect(201);

  const callId: string = start.body.callId;

  for (const text of [
    'My car broke down near Liberty Market',
    "It's a Toyota Corolla",
    "It can't move",
    'Ahmed',
    'Yes',
    "Yes that's right",
  ]) {
    await request(server)
      .post('/api/dev/conversations/turn')
      .send({ businessId, callId, text })
      .expect(201);
  }
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
  schema = await import('../src/database/schema');

  whatsapp = new ControllableWhatsAppProvider();

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(WHATSAPP_PROVIDER)
    .useValue(whatsapp)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
  server = app.getHttpServer();
  database = moduleRef.get(DatabaseService);

  const register = await request(server)
    .post('/api/auth/register')
    .send({
      businessName: 'Reliability Towing',
      email: 'reliability@example.test',
      password: 'a-sufficiently-long-password',
      name: 'Owner',
      timezone: 'Asia/Karachi',
    })
    .expect(201);

  accessToken = register.body.accessToken;
  businessId = register.body.businessId;

  await request(server)
    .put('/api/business')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ whatsappNumber: '+923000000009' })
    .expect(200);

  await request(server)
    .post('/api/business/phone-numbers')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ e164: phoneNumber })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  whatsapp.mode = 'ok';
  whatsapp.attempts = 0;
});

describe('when WhatsApp delivery fails', () => {
  it('keeps the lead and records the notification as failed', async () => {
    whatsapp.mode = 'transient';

    await runCallToLead('+923001111101');

    // The lead exists regardless of the delivery outcome. This is the guarantee.
    const leads = await request(server)
      .get('/api/leads')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const lead = leads.body.items.find(
      (l: { customerPhone: string }) => l.customerPhone === '+923001111101',
    );
    expect(lead).toBeDefined();
    expect(lead.customerName).toBe('Ahmed');
    expect(lead.location).toBe('Liberty Market');

    // And the failure is visible rather than silent.
    const notifications = await request(server)
      .get('/api/notifications?status=failed')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const notification = notifications.body.items.find(
      (n: { leadId: string }) => n.leadId === lead.id,
    );
    expect(notification).toBeDefined();
    expect(notification.status).toBe('failed');
    expect(notification.attempts).toBeGreaterThanOrEqual(1);
    expect(notification.lastError).toContain('503');
    // Scheduled for another attempt rather than abandoned.
    expect(notification.nextRetryAt).not.toBeNull();
  });

  it('delivers on a later attempt once the provider recovers', async () => {
    whatsapp.mode = 'transient';
    await runCallToLead('+923001111102');

    const leadId = await findLeadId('+923001111102');
    let notificationId = await findNotificationId(leadId);

    expect(await notificationStatus(notificationId)).toBe('failed');

    // The provider comes back; the sweeper is what notices.
    whatsapp.mode = 'ok';
    await makeRetryDue(notificationId);

    const { NotificationsService } = await import(
      '../src/modules/notifications/notifications.service'
    );
    const service = app.get(NotificationsService);
    await service.sweep();

    expect(await notificationStatus(notificationId)).toBe('sent');
    expect(whatsapp.sent.some((m) => m.body.includes('Ahmed'))).toBe(true);
  });

  it('gives up on a permanently invalid number instead of retrying forever', async () => {
    whatsapp.mode = 'permanent';
    await runCallToLead('+923001111103');

    const leadId = await findLeadId('+923001111103');
    const notificationId = await findNotificationId(leadId);

    // A bad number does not become valid by waiting, so it is marked dead on
    // the first attempt and surfaced for the operator to fix.
    expect(await notificationStatus(notificationId)).toBe('dead');
    const row = await notificationRow(notificationId);
    expect(row.attempts).toBe(1);
    expect(row.nextRetryAt).toBeNull();

    // The lead is still intact.
    expect(leadId).toBeTruthy();
  });

  it('lets an operator retry a dead notification from the dashboard', async () => {
    whatsapp.mode = 'permanent';
    await runCallToLead('+923001111104');

    const leadId = await findLeadId('+923001111104');
    const notificationId = await findNotificationId(leadId);
    expect(await notificationStatus(notificationId)).toBe('dead');

    // The operator fixes the number and asks for another attempt.
    whatsapp.mode = 'ok';
    const response = await request(server)
      .post(`/api/notifications/${notificationId}/retry`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);

    expect(response.body.status).toBe('sent');
    expect(await notificationStatus(notificationId)).toBe('sent');
  });
});

describe('the notification body', () => {
  it('is built from the stored lead, not from anything the model said', async () => {
    whatsapp.mode = 'ok';
    await runCallToLead('+923001111105');

    const message = whatsapp.sent.at(-1);
    expect(message).toBeDefined();

    const leadId = await findLeadId('+923001111105');
    const lead = await request(server)
      .get(`/api/leads/${leadId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Every value in the message is traceable to a validated column.
    expect(message!.body).toContain(lead.body.customerName);
    expect(message!.body).toContain(lead.body.location);
    expect(message!.body).toContain('Toyota Corolla');
    expect(message!.body).toContain('Vehicle movable:\nNo');
    // Fields the caller never gave say so, rather than being invented.
    expect(message!.body).toContain('Destination:\nNot provided');
  });
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

async function findLeadId(customerPhone: string): Promise<string> {
  const response = await request(server)
    .get('/api/leads')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);

  const lead = response.body.items.find(
    (l: { customerPhone: string }) => l.customerPhone === customerPhone,
  );
  expect(lead, `no lead for ${customerPhone}`).toBeDefined();
  return lead.id;
}

async function findNotificationId(leadId: string): Promise<string> {
  const response = await request(server)
    .get('/api/notifications')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);

  const notification = response.body.items.find(
    (n: { leadId: string }) => n.leadId === leadId,
  );
  expect(notification, `no notification for lead ${leadId}`).toBeDefined();
  return notification.id;
}

async function notificationRow(id: string) {
  return database.withTenant(businessId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, id))
      .limit(1);
    return rows[0]!;
  });
}

async function notificationStatus(id: string): Promise<string> {
  return (await notificationRow(id)).status;
}

/** Brings a scheduled retry forward so the sweeper picks it up immediately. */
async function makeRetryDue(id: string): Promise<void> {
  await database.withTenant(businessId, (tx) =>
    tx
      .update(schema.notifications)
      .set({ nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(schema.notifications.id, id)),
  );
}
