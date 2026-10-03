/**
 * Plays one benchmark scenario through the real model and prints everything
 * the receptionist did — every reply, every tool call and its result, every
 * call event, the reply latency, and how the run was scored.
 *
 *   npm run realtime:explain -- partial-location-before-phone [--verbose]
 *
 * --verbose also prints each note given to the model and each reply asked for.
 *
 * For working out why a scenario fails, or what a real call would sound like,
 * without dialling. Uses the same settings as a live call (.env).
 */

import '../../database/load-env';

import { createCallJudge } from '../judgment/judgment.module';
import { OpenAiTtsProvider } from '../tts/openai-tts.provider';
import { formatEvent } from '../../call-session/trace-format';
import { runCall, type HarnessOptions } from './eval/harness';
import { SCENARIOS } from './eval/scenarios';
import { scoreRun } from './eval/score';
import type { NoiseReduction, TurnDetectionMode, TurnEagerness } from './openai-realtime-conversation';

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error('\n✗ OPENAI_API_KEY is not set in .env.\n');
    process.exit(1);
  }
  const name = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const verbose = process.argv.includes('--verbose');
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) {
    console.error(`\nUsage: npm run realtime:explain -- <scenario>\nScenarios: ${SCENARIOS.map((s) => s.name).join(', ')}\n`);
    process.exit(1);
  }

  const tts = new OpenAiTtsProvider({ apiKey, model: 'gpt-4o-mini-tts', voice: 'ash' });
  const callerAudio = async (line: string) => {
    const chunks: Buffer[] = [];
    for await (const chunk of tts.stream({ text: line })) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T =>
    allowed.find((a) => a === value?.trim()) ?? fallback;

  const options: HarnessOptions = {
    apiKey,
    model: process.env.AI_REALTIME_MODEL?.trim() || 'gpt-realtime-mini',
    voice: process.env.AI_REALTIME_VOICE?.trim() || 'marin',
    silenceMs: Number(process.env.AI_REALTIME_SILENCE_MS) || 900,
    turnDetection: pick<TurnDetectionMode>(process.env.AI_REALTIME_TURN_DETECTION, ['server_vad', 'semantic_vad'], 'server_vad'),
    eagerness: pick<TurnEagerness>(process.env.AI_REALTIME_VAD_EAGERNESS, ['low', 'medium', 'high', 'auto'], 'auto'),
    noiseReduction: pick<NoiseReduction>(process.env.AI_REALTIME_NOISE_REDUCTION, ['near_field', 'far_field', 'off'], 'near_field'),
    transcriptionModel: process.env.AI_REALTIME_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-transcribe',
    speed: 3,
    callerAudio,
    // As on a live call: Jev when TYPESAFE_API_KEY is set, the rules otherwise. Every judgment is printed.
    judge: createCallJudge(
      {
        apiKey: process.env.TYPESAFE_API_KEY?.trim(),
        model: process.env.TYPESAFE_MODEL?.trim() || undefined,
        timeoutMs: Number(process.env.TYPESAFE_TIMEOUT_MS) || undefined,
      },
      { log: (m: string) => console.log(m), warn: (m: string) => console.warn(m), debug: (m: string) => console.log(`  ${m}`) },
    ),
  };
  console.log(`${scenario.name} on ${options.model} (${options.turnDetection}, noise reduction ${options.noiseReduction})\n`);

  const run = await runCall(options, scenario.lines);

  for (const [i, turn] of run.turns.entries()) {
    console.log(`Turn ${i + 1}`);
    console.log(`  caller: ${turn.caller}`);
    for (const reply of turn.replies) console.log(`  receptionist: ${reply}`);
    // The replies are printed above; a stopped one is shown again with how much was heard.
    const quiet = new Set(['CUSTOMER_SPEECH', ...(verbose ? [] : ['MODEL_NOTE', 'REPLY_REQUESTED'])]);
    const events = run.events.filter(
      (e) => e.turn === i + 1 && !quiet.has(e.type) && !(e.type === 'AI_RESPONSE' && !(e.payload as { stopped?: unknown } | undefined)?.stopped),
    );
    for (const event of events) {
      const text = formatEvent(event.type, (event.payload as Record<string, unknown> | undefined) ?? null, { notes: verbose });
      console.log(text.split('\n').map((line) => `  ${line}`).join('\n'));
    }
    console.log('');
  }
  for (const error of run.errors) console.log(`error: ${error}`);
  console.log(`Reply latency after each caller turn: ${run.replyLatencyMs.map((ms) => `${ms}ms`).join(', ') || 'none'}`);
  const failures = scoreRun(scenario, run);
  console.log(failures.length === 0 ? 'Scored: pass' : `Scored: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  [${f.category} · ${f.source}] ${f.detail}`);
  process.exit(0);
}

void main();
