/**
 * The real telephony path, end to end, with signature validation switched ON.
 *
 * The text simulator bypasses Twilio entirely, which is exactly how a bug in
 * this path went unnoticed: the call-status webhook required a call id that
 * Twilio has no way to send, so every real hang-up was silently ignored. These
 * tests drive the controller the way Twilio does — form-encoded bodies, signed
 * with Twilio's own `getExpectedTwilioSignature`, following the action URLs the
 * TwiML hands back — so what passes here is what a real call does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { getExpectedTwilioSignature } from 'twilio';

import { testDatabaseUrls } from './global-setup';

const AUTH_TOKEN = 'test-twilio-auth-token-0123456789abcdef';
const PUBLIC_BASE_URL = 'https://tunnel.example.test';
const TWILIO_NUMBER = '+14155550199';
const CALLER = '+923001234567';

let app: INestApplication;
let server: ReturnType<INestApplication['getHttpServer']>;
let accessToken: string;

/** POSTs a form body to a path, signed the way Twilio signs it. */
function twilioPost(pathAndQuery: string, params: Record<string, string>) {
  const signature = getExpectedTwilioSignature(
    AUTH_TOKEN,
    `${PUBLIC_BASE_URL}${pathAndQuery}`,
    params,
  );
  return request(server)
    .post(pathAndQuery)
    .type('form')
    .set('X-Twilio-Signature', signature)
    .send(params);
}

/** The path and query of the next turn, taken from TwiML as Twilio would. */
function actionPath(twiml: string): string {
  const match = twiml.match(/action="([^"]+)"/);
  if (!match?.[1]) throw new Error(`No <Gather action> in TwiML:\n${twiml}`);
  const url = new URL(match[1].replace(/&amp;/g, '&'));
  expect(url.origin).toBe(PUBLIC_BASE_URL);
  return url.pathname + url.search;
}

function say(twiml: string): string {
  return twiml.match(/<Say[^>]*>([\s\S]*?)<\/Say>/)?.[1] ?? '';
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
    VOICE_PIPELINE: 'gather',
    PUBLIC_BASE_URL,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    // The whole point of this file: validation on, as in production.
    TWILIO_VALIDATE_SIGNATURE: 'true',
    ENABLE_DEV_SIMULATOR: 'false',
  });

  const { AppModule } = await import('../src/app.module');
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
  server = app.getHttpServer();

  const register = await request(server)
    .post('/api/auth/register')
    .send({
      businessName: 'Webhook Towing',
      email: 'webhooks@example.test',
      password: 'a-sufficiently-long-password',
      name: 'Owner',
      timezone: 'Asia/Karachi',
    })
    .expect(201);
  accessToken = register.body.accessToken;

  await request(server)
    .post('/api/business/phone-numbers')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ e164: TWILIO_NUMBER })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
});

describe('Twilio signature validation', () => {
  const params = { CallSid: 'CA_unsigned', From: CALLER, To: TWILIO_NUMBER };

  it('rejects a webhook with no signature', async () => {
    await request(server)
      .post('/api/telephony/twilio/voice')
      .type('form')
      .send(params)
      .expect(403);
  });

  it('rejects a webhook signed with the wrong token', async () => {
    const forged = getExpectedTwilioSignature(
      'not-the-real-token',
      `${PUBLIC_BASE_URL}/api/telephony/twilio/voice`,
      params,
    );
    await request(server)
      .post('/api/telephony/twilio/voice')
      .type('form')
      .set('X-Twilio-Signature', forged)
      .send(params)
      .expect(403);
  });

  it('rejects a genuine signature replayed against different parameters', async () => {
    const signature = getExpectedTwilioSignature(
      AUTH_TOKEN,
      `${PUBLIC_BASE_URL}/api/telephony/twilio/voice`,
      params,
    );
    await request(server)
      .post('/api/telephony/twilio/voice')
      .type('form')
      .set('X-Twilio-Signature', signature)
      .send({ ...params, From: '+10000000000' })
      .expect(403);
  });
});

describe('a real call through the Twilio webhooks', () => {
  it('answers, follows its own action URLs, and creates the lead', async () => {
    const callSid = 'CA_full_call_0001';

    const answer = await twilioPost('/api/telephony/twilio/voice', {
      CallSid: callSid,
      From: CALLER,
      To: TWILIO_NUMBER,
    }).expect(200);

    expect(answer.headers['content-type']).toContain('xml');
    expect(answer.text).toContain('<Gather input="speech"');
    expect(say(answer.text)).toContain('Webhook Towing');

    let next = actionPath(answer.text);
    let last = answer.text;

    // What Twilio's speech recognition delivers: punctuated and capitalised.
    for (const speech of [
      'My car broke down near Liberty Market.',
      "It's a Toyota Corolla.",
      "It can't move.",
      'Ahmed.',
      'Yes.',
      "Yes, that's right.",
    ]) {
      const turn = await twilioPost(next, {
        CallSid: callSid,
        SpeechResult: speech,
        Confidence: '0.92',
      }).expect(200);
      last = turn.text;
      if (turn.text.includes('<Hangup/>')) break;
      next = actionPath(turn.text);
    }

    expect(last).toContain('<Hangup/>');
    expect(say(last)).toContain('recorded the details');

    const calls = await request(server)
      .get('/api/calls')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const call = calls.body.items.find(
      (c: { fromNumber: string; outcome: string }) =>
        c.fromNumber === CALLER && c.outcome === 'lead_created',
    );
    expect(call).toBeDefined();

    const detail = await request(server)
      .get(`/api/calls/${call.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(detail.body.lead).toMatchObject({
      customerName: 'Ahmed',
      location: 'Liberty Market',
      vehicleMake: 'Toyota',
      vehicleMovable: false,
    });
  });

  it('treats an empty speech result as silence rather than an answer', async () => {
    const callSid = 'CA_silence_0001';
    const answer = await twilioPost('/api/telephony/twilio/voice', {
      CallSid: callSid,
      From: CALLER,
      To: TWILIO_NUMBER,
    }).expect(200);

    // Twilio posts the action with no SpeechResult when nothing was heard.
    const turn = await twilioPost(actionPath(answer.text), { CallSid: callSid }).expect(200);
    expect(say(turn.text)).toContain('still there');
  });

  it('finalises a call when the caller hangs up, using only what Twilio sends', async () => {
    // The bug this guards: the status URL is configured once on the number, so
    // it carries no call id. The call must be found from To and CallSid.
    const callSid = 'CA_hangup_0001';
    const answer = await twilioPost('/api/telephony/twilio/voice', {
      CallSid: callSid,
      From: CALLER,
      To: TWILIO_NUMBER,
    }).expect(200);

    await twilioPost(actionPath(answer.text), {
      CallSid: callSid,
      SpeechResult: 'My car broke down near Mall Road.',
    }).expect(200);

    // Caller hangs up. This is the exact shape of Twilio's status callback.
    await twilioPost('/api/telephony/twilio/status', {
      CallSid: callSid,
      CallStatus: 'completed',
      From: CALLER,
      To: TWILIO_NUMBER,
      Direction: 'inbound',
    }).expect(204);

    const calls = await request(server)
      .get('/api/calls')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const call = calls.body.items.find(
      (c: { providerCallSid: string }) => c.providerCallSid === callSid,
    );

    // Not left "in progress": finalised, and the partial details kept.
    expect(call).toMatchObject({ status: 'completed', outcome: 'callback_created' });

    const detail = await request(server)
      .get(`/api/calls/${call.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(detail.body.callbackRequests).toHaveLength(1);
    expect(detail.body.extractedInformation).toMatchObject({ location: 'Mall Road' });
  });

  it('apologises after a stream that ended in failure, and only then', async () => {
    // Media stream calls come back here once their stream closes. After the
    // goodbye there is nothing to add; after the receptionist itself failed,
    // the caller is told so instead of hearing the line drop.
    const callSid = 'CA_after_stream_0001';
    await twilioPost('/api/telephony/twilio/voice', { CallSid: callSid, From: CALLER, To: TWILIO_NUMBER }).expect(200);
    const calls = await request(server).get('/api/calls').set('Authorization', `Bearer ${accessToken}`).expect(200);
    const call = calls.body.items.find((c: { providerCallSid: string }) => c.providerCallSid === callSid);
    const path = `/api/telephony/twilio/after-stream?businessId=${call.businessId}&callId=${call.id}`;

    const fine = await twilioPost(path, { CallSid: callSid }).expect(200);
    expect(say(fine.text)).toBe('');
    expect(fine.text).toContain('<Hangup/>');

    const { CallSessionService } = await import('../src/call-session/call-session.service');
    await app.get(CallSessionService).handleEvent(call.businessId, call.id, { kind: 'PROVIDER_ERROR', message: 'OpenAI realtime session closed mid-call' });

    const failed = await twilioPost(path, { CallSid: callSid }).expect(200);
    expect(say(failed.text)).toContain('something went wrong on our end');
    expect(failed.text).toContain('<Hangup/>');

    const detail = await request(server).get(`/api/calls/${call.id}`).set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(detail.body.callbackRequests).toHaveLength(1);
  });

  it('answers politely, rather than dropping the caller, on an unrouted number', async () => {
    const response = await twilioPost('/api/telephony/twilio/voice', {
      CallSid: 'CA_unrouted_0001',
      From: CALLER,
      To: '+14155550000',
    }).expect(200);

    // The apostrophe arrives XML-escaped (isn&apos;t); Twilio decodes it.
    expect(response.text).toContain('set up to take calls');
    expect(response.text).toContain('<Hangup/>');
  });
});
