/**
 * Talk to the receptionist from a terminal.
 *
 *   npm run simulate:call
 *
 * You play the caller; type what you would say. Behind it is the identical path
 * a phone call takes — same engine, state machine, database writes, lead and
 * WhatsApp notification. Only the transport is swapped for the dev simulator
 * endpoints, so this needs the API running with ENABLE_DEV_SIMULATOR=true.
 *
 * When the call ends it prints what the tow operator would receive.
 */

import '../../database/load-env';
import { createInterface } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

const API =
  process.env.API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`;

/** The seeded demo company. Override to call a different tenant. */
const TO_NUMBER = process.env.SIM_TO_NUMBER ?? '+924235000001';
const FROM_NUMBER = process.env.SIM_FROM_NUMBER ?? '+923001234567';

const NL = '\n';

const colour = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

interface TurnResult {
  callId: string;
  businessId?: string;
  reply: string;
  ended: boolean;
  state: string;
  outcome: string | null;
}

interface CallResult {
  call: { outcome: string | null; durationSeconds: number | null };
  lead: Record<string, unknown> | null;
  callbackRequests: Array<{ reason: string }>;
  notifications: Array<{ status: string; target: string; payload: string }>;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} from ${path}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

function printReply(result: TurnResult): void {
  if (result.reply) {
    output.write(NL + colour.cyan(colour.bold('Receptionist:')) + ' ' + result.reply + NL);
  }
  output.write(colour.dim(`  [state: ${result.state}]`) + NL);
}

/** Confirms the API is up and can reach Postgres before starting a call. */
async function preflight(): Promise<void> {
  try {
    const response = await fetch(`${API}/health`);
    const body = (await response.json()) as { database?: string };
    if (body.database !== 'up') {
      throw new Error('the API is running but cannot reach Postgres');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    output.write(
      [
        '',
        colour.red(`Could not reach the API at ${API} (${reason}).`),
        '',
        'Start it first, in another terminal:',
        '  npm run start:api',
        '',
        'If it runs on another port, set API_URL first, e.g. in PowerShell:',
        '  $env:API_URL = "http://127.0.0.1:3100"',
        '',
      ].join(NL),
    );
    process.exit(1);
  }
}

async function showOutcome(callId: string, businessId: string): Promise<void> {
  const detail = await request<CallResult>(
    `/api/dev/conversations/${callId}?businessId=${businessId}`,
  );

  output.write(NL + colour.bold('━━━ Call ended ━━━') + NL);
  output.write('Outcome: ' + colour.green(detail.call.outcome ?? 'unknown') + NL);

  if (detail.lead) {
    output.write(NL + colour.bold('Lead saved to the database:') + NL);
    const fields: Array<[string, string]> = [
      ['customerName', 'Customer'],
      ['customerPhone', 'Phone'],
      ['service', 'Service'],
      ['location', 'Location'],
      ['destination', 'Destination'],
      ['vehicleMake', 'Make'],
      ['vehicleModel', 'Model'],
      ['vehicleType', 'Type'],
      ['vehicleMovable', 'Movable'],
      ['vehicleCondition', 'Condition'],
      ['additionalNotes', 'Notes'],
    ];
    for (const [key, label] of fields) {
      const value = detail.lead[key];
      let shown: string;
      if (value === null || value === undefined) shown = colour.dim('(not given)');
      else if (typeof value === 'boolean') shown = value ? 'yes' : 'no';
      else shown = String(value);
      output.write(`  ${label.padEnd(12)} ${shown}` + NL);
    }
  }

  for (const callback of detail.callbackRequests) {
    output.write(NL + colour.yellow('Callback request:') + ' ' + callback.reason + NL);
  }

  for (const message of detail.notifications) {
    output.write(
      NL +
        colour.bold(`WhatsApp to ${message.target}`) +
        ' ' +
        colour.dim(`[${message.status}]`) +
        NL,
    );
    output.write(
      message.payload
        .split(NL)
        .map((line) => `  │ ${line}`)
        .join(NL) + NL,
    );
  }

  const producedRecord = detail.lead !== null || detail.callbackRequests.length > 0;
  if (producedRecord && detail.notifications.length === 0) {
    output.write(
      NL + colour.dim('(No WhatsApp message: this business has no WhatsApp number set.)') + NL,
    );
  }

  output.write(NL + colour.dim('Full transcript and event trail: dashboard → Calls') + NL);
}

async function main(): Promise<void> {
  await preflight();

  output.write(
    colour.bold('Calling the receptionist') +
      ' ' +
      colour.dim(`(${TO_NUMBER}, from ${FROM_NUMBER})`) +
      NL +
      colour.dim('Type what the caller says. Commands: /silence  /hangup  /quit') +
      NL +
      colour.dim('Try: "my car broke down near Liberty Market"') +
      NL,
  );

  const start = await request<TurnResult>('/api/dev/conversations', {
    toNumber: TO_NUMBER,
    fromNumber: FROM_NUMBER,
  });

  const businessId = start.businessId;
  if (!businessId) {
    throw new Error('The API did not return a businessId. Rebuild the API.');
  }

  printReply(start);

  // Iterating lines, rather than calling question() per turn, is what makes
  // piped input work: a pipe delivers every line at once and then closes,
  // which question() cannot survive.
  const rl = createInterface({ input, terminal: input.isTTY ?? false });
  const prompt = () => output.write(NL + colour.bold('You:') + ' ');
  let result = start;

  try {
    prompt();

    for await (const raw of rl) {
      const line = raw.trim();
      // Echo scripted input so the transcript still reads like a conversation.
      if (!input.isTTY) output.write(line + NL);

      if (line === '/quit') {
        output.write(colour.dim('Leaving without hanging up; the call stays open.') + NL);
        return;
      }

      if (line === '/hangup' || line === '/silence') {
        result = await request<TurnResult>('/api/dev/conversations/event', {
          businessId,
          callId: start.callId,
          event: line === '/hangup' ? 'HANGUP' : 'SILENCE',
        });
      } else {
        result = await request<TurnResult>('/api/dev/conversations/turn', {
          businessId,
          callId: start.callId,
          text: line,
        });
      }

      printReply(result);
      if (result.ended) break;
      prompt();
    }

    // Input ran out mid-call (Ctrl+D, or a script that stopped early). That is
    // a caller whose line went dead, so it is finalised like a hang-up — which
    // still creates the lead if every detail had already been given.
    if (!result.ended) {
      output.write(
        NL + colour.dim('(input ended — treating it as the caller hanging up)') + NL,
      );
      result = await request<TurnResult>('/api/dev/conversations/event', {
        businessId,
        callId: start.callId,
        event: 'HANGUP',
      });
    }

    await showOutcome(start.callId, businessId);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  output.write(NL + colour.red(error instanceof Error ? error.message : String(error)) + NL);
  process.exit(1);
});
