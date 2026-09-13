/**
 * Points a Twilio number at this API and routes it to a business.
 *
 *   npm run twilio:connect                  # the only number on the account
 *   npm run twilio:connect -- --number +14155550199
 *   npm run twilio:connect -- --business "Rapid Recovery"
 *   npm run twilio:connect -- --dry-run     # show what would change
 *
 * Exists because a free tunnel URL changes on every restart, and the number's
 * webhooks, PUBLIC_BASE_URL and Twilio's signature all have to agree exactly.
 * Doing that by hand in the console each time is how a first test call ends in
 * "403 Invalid Twilio signature".
 *
 * Before touching Twilio it confirms PUBLIC_BASE_URL actually reaches this API
 * with its database up — a tunnel pointing at the wrong program is otherwise
 * indistinguishable from a broken app.
 */

import '../../../database/load-env';
import { Client } from 'pg';
import twilio, { getExpectedTwilioSignature } from 'twilio';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const DRY_RUN = flag('dry-run');
const REQUESTED_NUMBER = option('number') ?? process.env.TWILIO_PHONE_NUMBER;
const BUSINESS_NAME = option('business') ?? 'Liberty Towing';

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  const dbUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;

  if (!sid || !token) {
    fail(
      'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env.\n' +
        '  Both are on the Twilio console home page: https://console.twilio.com',
    );
  }
  if (!base || !/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) {
    fail(
      `PUBLIC_BASE_URL is "${base ?? ''}". Twilio needs a public https address.\n` +
        '  Start a tunnel (cloudflared tunnel --url http://localhost:3000),\n' +
        '  put its https URL in .env as PUBLIC_BASE_URL, and restart the API.',
    );
  }
  if (!dbUrl) fail('DATABASE_MIGRATION_URL is not set in .env.');

  // 1. The tunnel reaches this API, and the API is running with this URL.
  console.log(`Checking ${base}/health ...`);
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
    const body = (await response.json()) as { database?: string };
    if (body.database !== 'up') throw new Error(`unexpected response ${JSON.stringify(body)}`);
  } catch (error) {
    fail(
      `Could not reach this API through ${base} (${
        error instanceof Error ? error.message : error
      }).\n` +
        '  Is the tunnel running, pointed at port 3000, and is `npm run start:api` up?',
    );
  }
  console.log('✓ tunnel reaches the API and its database is up');

  // 2. Signature validation works through the tunnel, with these credentials.
  //
  // The health check above passes even if the API was started before
  // PUBLIC_BASE_URL was set — but that API validates signatures against the
  // old URL and will 403 every real call. So sign a request exactly as Twilio
  // would and send it. A "ringing" status is acknowledged and ignored, so the
  // probe has no side effects.
  const probeUrl = `${base}/api/telephony/twilio/status`;
  const probe = { CallSid: 'CA00000000000000000000000000000000', CallStatus: 'ringing' };
  const probeResponse = await fetch(probeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': getExpectedTwilioSignature(token, probeUrl, probe),
    },
    body: new URLSearchParams(probe).toString(),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => {
    fail(`Signature probe failed to send: ${error instanceof Error ? error.message : error}`);
  });

  if (probeResponse.status === 403) {
    fail(
      'The API rejected a correctly signed Twilio request.\n' +
        '  The running API was almost certainly started before PUBLIC_BASE_URL\n' +
        '  (or TWILIO_AUTH_TOKEN) was set in .env. Restart it — Ctrl+C in its\n' +
        '  terminal, then `npm run start:api` — and run this again.\n' +
        '  Every real call would have been rejected the same way.',
    );
  }
  if (!probeResponse.ok) {
    fail(`Signature probe got HTTP ${probeResponse.status} from ${probeUrl}.`);
  }
  console.log('✓ a Twilio-signed request is accepted through the tunnel');

  // 3. Which Twilio number.
  const client = twilio(sid, token);
  let numbers;
  try {
    numbers = await client.incomingPhoneNumbers.list({ limit: 50 });
  } catch (error) {
    fail(
      `Twilio rejected the credentials (${error instanceof Error ? error.message : error}).\n` +
        '  Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.',
    );
  }

  if (numbers.length === 0) fail('This Twilio account has no phone numbers.');

  const chosen = REQUESTED_NUMBER
    ? numbers.find((n) => n.phoneNumber === REQUESTED_NUMBER)
    : numbers.length === 1
      ? numbers[0]
      : undefined;

  if (!chosen) {
    fail(
      (REQUESTED_NUMBER
        ? `${REQUESTED_NUMBER} is not on this account.`
        : 'This account has several numbers; choose one with --number.') +
        '\n  Numbers on the account:\n' +
        numbers.map((n) => `    ${n.phoneNumber}  ${n.friendlyName}`).join('\n'),
    );
  }

  console.log(`✓ Twilio number ${chosen.phoneNumber}`);

  // 4. Route the number to a business.
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  let businessName: string;
  try {
    const existing = await db.query<{ name: string }>(
      `SELECT b.name FROM phone_numbers p JOIN businesses b ON b.id = p.business_id
        WHERE p.e164 = $1`,
      [chosen.phoneNumber],
    );

    if (existing.rows[0]) {
      businessName = existing.rows[0].name;
      console.log(`✓ already routed to "${businessName}"`);
    } else {
      const business = await db.query<{ id: string; name: string }>(
        'SELECT id, name FROM businesses WHERE name = $1 LIMIT 1',
        [BUSINESS_NAME],
      );
      if (!business.rows[0]) {
        fail(`No business named "${BUSINESS_NAME}". Run \`npm run seed\`, or pass --business.`);
      }
      businessName = business.rows[0].name;

      if (DRY_RUN) {
        console.log(`• would route ${chosen.phoneNumber} to "${businessName}"`);
      } else {
        await db.query(
          `INSERT INTO phone_numbers (business_id, e164, provider, provider_sid)
           VALUES ($1, $2, 'twilio', $3)`,
          [business.rows[0].id, chosen.phoneNumber, chosen.sid],
        );
        console.log(`✓ routed ${chosen.phoneNumber} to "${businessName}"`);
      }
    }
  } finally {
    await db.end();
  }

  // 5. Point the number's webhooks here.
  const voiceUrl = `${base}/api/telephony/twilio/voice`;
  const statusCallback = `${base}/api/telephony/twilio/status`;

  console.log('');
  console.log(`  voice webhook   ${chosen.voiceUrl || '(none)'}`);
  console.log(`              →   ${voiceUrl}`);
  console.log(`  status callback ${chosen.statusCallback || '(none)'}`);
  console.log(`              →   ${statusCallback}`);

  if (chosen.voiceApplicationSid) {
    // Twilio ignores voiceUrl while a TwiML app is attached.
    console.log(
      `  TwiML app ${chosen.voiceApplicationSid} is attached and would override the webhook; it will be detached.`,
    );
  }
  if (chosen.trunkSid) {
    console.log(
      `  ! This number belongs to SIP trunk ${chosen.trunkSid}; Twilio routes it through the trunk and will ignore these webhooks.`,
    );
  }

  if (DRY_RUN) {
    console.log('\nDry run: nothing was changed.\n');
    return;
  }

  await client.incomingPhoneNumbers(chosen.sid).update({
    voiceUrl,
    voiceMethod: 'POST',
    statusCallback,
    statusCallbackMethod: 'POST',
    ...(chosen.voiceApplicationSid ? { voiceApplicationSid: '' } : {}),
  });

  console.log(`
✓ Connected. Call ${chosen.phoneNumber} now.

  Watch it happen:  the terminal running \`npm run start:api\`
  Afterwards:       http://localhost:4200 → Calls  (answering as "${businessName}")

  Remember: the tunnel URL changes when cloudflared restarts. When it does,
  update PUBLIC_BASE_URL, restart the API, and run this again.
`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
