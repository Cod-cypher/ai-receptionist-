/**
 * Tests VOICE_PIPELINE=chatgpt against the live API, without a phone call.
 *
 *   npm run realtime:check
 *
 * Opens a real gpt-realtime-mini session exactly as a call does, then:
 *   1. speaks the greeting             — how fast, and exactly what it said
 *   2. streams a caller's line in       — as Twilio would, at real speed
 *   3. extracts the details             — the fields the workflow receives
 *   4. speaks the next question
 *   5. interrupts a long line           — barge-in
 *
 * The caller's line is synthesised with gpt-4o-mini-tts purely as test input;
 * on a real call it is the caller's own voice. Costs a few cents.
 */

import '../../database/load-env';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BusinessFacts } from '@towai/shared';

import { mulawToWav } from '../audio/g711';
import { OpenAiTtsProvider } from '../tts/openai-tts.provider';
import { OpenAiRealtimeConversation } from './openai-realtime-conversation';
import { normaliseCallerTurn } from './realtime-extraction';
import { buildRealtimeExtractionInstructions, buildSpeakInstructions } from './realtime-instructions';

const CALLER_LINE =
  "Yeah hi, my car broke down near Liberty Market. It's a Suzuki Mehran and it won't move.";

const FACTS: BusinessFacts = {
  name: 'Liberty Towing',
  phone: null,
  website: null,
  address: null,
  serviceAreas: ['Lahore', 'Gulberg', 'DHA', 'Model Town'],
  services: ['Local towing', 'Flatbed towing', 'Jump starts'],
  businessHoursText: null,
  isOpenNow: true,
  pricingInfo: null,
  emergencyContact: null,
  faq: [],
  tone: 'friendly',
  businessInstructions: null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) fail('OPENAI_API_KEY is not set in .env.');

  const model = process.env.AI_REALTIME_MODEL?.trim() || 'gpt-realtime-mini';
  const voice = process.env.AI_REALTIME_VOICE?.trim() || 'marin';
  console.log(`Model: ${model}   voice: ${voice}\n`);

  // Test input only: a synthetic caller.
  const caller: Buffer[] = [];
  const tts = new OpenAiTtsProvider({ apiKey, model: 'gpt-4o-mini-tts', voice: 'ash' });
  for await (const chunk of tts.stream({ text: CALLER_LINE })) caller.push(chunk);
  const callerAudio = Buffer.concat(caller);

  let audio: Buffer[] = [];
  let firstAudioAt = 0;
  let callerTurns = 0;
  let speechStarted = 0;
  const errors: string[] = [];

  const session = new OpenAiRealtimeConversation({
    apiKey,
    model,
    voice,
    silenceMs: Number(process.env.AI_TRANSCRIPTION_SILENCE_MS) || 600,
    callbacks: {
      onSpeechStarted: () => {
        speechStarted += 1;
      },
      onCallerTurn: () => {
        callerTurns += 1;
      },
      onAudio: (chunk) => {
        firstAudioAt ||= Date.now();
        audio.push(chunk);
      },
      onSpokenText: () => undefined,
      onError: (error) => {
        errors.push(error.message);
        console.error(`  ! ${error.message}`);
      },
    },
  });

  const speak = async (label: string, line: string) => {
    audio = [];
    firstAudioAt = 0;
    const started = Date.now();
    const outcome = await session.speak(line, buildSpeakInstructions('friendly'));
    const bytes = Buffer.concat(audio);
    console.log(`${label}`);
    console.log(`  asked to say:  "${line}"`);
    console.log(`  said:          "${outcome.spoken}"`);
    console.log(
      `  first audio ${firstAudioAt ? firstAudioAt - started : '—'} ms, ` +
        `${(bytes.length / 8000).toFixed(1)} s of speech, status ${outcome.status}`,
    );
    return { outcome, bytes };
  };

  // 1. Greeting (includes connecting and configuring the session)
  const greeting = await speak(
    '1. Greeting (first request also connects and configures the session)',
    'Thanks for calling Liberty Towing. How can I help?',
  );
  if (greeting.bytes.length === 0) fail('No audio came back for the greeting.');
  const wavPath = resolve(process.cwd(), 'realtime-check.wav');
  writeFileSync(wavPath, mulawToWav(greeting.bytes));
  console.log(`  saved ${wavPath}\n`);

  // 2. Caller speaks
  console.log('2. Caller speaking (streamed at real speed)');
  const turnsBefore = callerTurns;
  for (let offset = 0; offset < callerAudio.length; offset += 160) {
    session.appendAudio(callerAudio.subarray(offset, offset + 160));
    await sleep(20);
  }
  const stoppedAt = Date.now();
  const silence = Buffer.alloc(160, 0xff);
  while (callerTurns === turnsBefore && Date.now() - stoppedAt < 4_000) {
    session.appendAudio(silence);
    await sleep(20);
  }
  if (callerTurns === turnsBefore) fail('The end of the caller\'s turn was never detected.');
  console.log(`  speech detected: ${speechStarted > 0 ? 'yes' : 'no'}; turn ended ${Date.now() - stoppedAt} ms after the caller stopped\n`);

  // 3. Extraction
  const extractStarted = Date.now();
  const args = await session.extract(
    buildRealtimeExtractionInstructions({
      facts: FACTS,
      filledSlots: {},
      pendingRequirement: 'serviceType',
      recentTurns: [{ speaker: 'ai', text: 'Thanks for calling Liberty Towing. How can I help?' }],
    }),
  );
  const turn = normaliseCallerTurn(args);
  const filled = Object.entries(turn.extraction.slots).filter(([, v]) => v !== null);
  console.log(`3. Extraction (${Date.now() - extractStarted} ms)`);
  console.log(`  function call: ${args ? 'yes' : 'NO'}`);
  console.log(`  heard:   "${turn.heard}"`);
  console.log(`  intent:  ${turn.extraction.intent}`);
  console.log(`  details: ${filled.map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}\n`);

  // 4. Next question
  await speak('4. Next question', 'Got it. Can I get your name?');
  console.log('');

  // 5. Barge-in
  audio = [];
  firstAudioAt = 0;
  const long = session.speak(
    'Let me read that back: location Liberty Market, vehicle Suzuki Mehran, vehicle movable no. Is that all correct?',
    buildSpeakInstructions('friendly'),
  );
  while (!firstAudioAt) await sleep(10);
  const cancelledAt = Date.now();
  session.cancelSpeech();
  const interrupted = await long;
  console.log('5. Barge-in');
  console.log(`  status ${interrupted.status}, acknowledged ${Date.now() - cancelledAt} ms after cancelling`);

  session.close();

  const ok =
    greeting.bytes.length > 0 &&
    args !== null &&
    turn.extraction.slots.location !== null &&
    interrupted.status === 'cancelled';
  console.log(
    `\nResponses matched by metadata: ${session.metadataMatched ? 'yes' : 'no (fell back to request order)'}`,
  );
  console.log(ok ? '\n✓ gpt-realtime-mini pipeline works end to end' : '\n✗ something above did not work');
  if (errors.length > 0) console.log(`  ${errors.length} error event(s) — see above`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
