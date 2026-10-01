/**
 * Prints one call as a timeline: what the caller said, what the judge made
 * of it, what was saved, what the receptionist was told to do next and why,
 * the note it was given, and every word it said, turn by turn.
 *
 *   npm run call:trace -- latest
 *   npm run call:trace -- <callId> [--notes] [--only NEXT_ACTION,AI_RESPONSE] [--json]
 *
 * Reads with DATABASE_MIGRATION_URL (the table owner, which sees every
 * business). With only DATABASE_URL, the app role sees nothing until it is
 * told which business: pass --business <uuid>. Read-only.
 */

import '../database/load-env';

import { Client } from 'pg';

import { renderTimeline, type TraceCall, type TraceEvent, type TraceTranscriptLine } from './trace-format';

interface Args {
  call: string;
  business?: string;
  only?: string[];
  notes: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = { call: '', notes: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--notes') args.notes = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--business') args.business = argv[++i];
    else if (arg === '--only') args.only = (argv[++i] ?? '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
    else if (!arg.startsWith('--')) args.call = arg;
  }
  return args.call ? args : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('\nUsage: npm run call:trace -- <callId|latest> [--notes] [--only TYPE,TYPE] [--json] [--business <uuid>]\n');
    process.exit(1);
  }

  const owner = process.env.DATABASE_MIGRATION_URL?.trim();
  const url = owner || process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('\n✗ Set DATABASE_MIGRATION_URL (or DATABASE_URL with --business) in .env.\n');
    process.exit(1);
  }
  if (!owner && !args.business) {
    console.error('\n✗ Only DATABASE_URL is set, and the app role sees no business until told which: pass --business <uuid>.\n');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    if (args.business) await client.query(`SELECT set_config('app.business_id', $1, false)`, [args.business]);

    const callRows =
      args.call === 'latest'
        ? await client.query(
            `SELECT id, from_number, started_at, duration_seconds, outcome, final_state, error FROM calls ORDER BY started_at DESC LIMIT 1`,
          )
        : await client.query(
            `SELECT id, from_number, started_at, duration_seconds, outcome, final_state, error FROM calls WHERE id = $1`,
            [args.call],
          );
    const row = callRows.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      console.error(`\n✗ No call ${args.call === 'latest' ? 'found' : args.call}.\n`);
      process.exit(1);
    }
    const call: TraceCall = {
      id: String(row.id),
      fromNumber: row.from_number as string | null,
      startedAt: row.started_at as Date | null,
      durationSeconds: row.duration_seconds as number | null,
      outcome: row.outcome as string | null,
      finalState: row.final_state as string | null,
      error: row.error as string | null,
    };

    const transcript: TraceTranscriptLine[] = (
      await client.query(`SELECT turn_index, speaker, text, created_at FROM transcripts WHERE call_id = $1 ORDER BY turn_index`, [call.id])
    ).rows.map((r: Record<string, unknown>) => ({
      turnIndex: Number(r.turn_index),
      speaker: String(r.speaker),
      text: String(r.text),
      createdAt: r.created_at as Date,
    }));
    const events: TraceEvent[] = (
      await client.query(`SELECT sequence, type, payload, created_at FROM call_events WHERE call_id = $1 ORDER BY sequence`, [call.id])
    ).rows.map((r: Record<string, unknown>) => ({
      sequence: Number(r.sequence),
      type: String(r.type),
      payload: (r.payload as Record<string, unknown> | null) ?? null,
      createdAt: r.created_at as Date,
    }));

    if (args.json) {
      console.log(JSON.stringify({ call, transcript, events }, null, 2));
    } else {
      console.log(renderTimeline(call, transcript, events, { notes: args.notes, only: args.only }));
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
