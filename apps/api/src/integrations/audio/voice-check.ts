/**
 * Tests the real speech providers without a phone call.
 *
 *   npm run voice:check
 *   npm run voice:check -- --text "I'm stuck on the motorway, it's a Honda City"
 *
 * 1. Synthesises a caller sentence with AI_TTS_MODEL, exactly as a reply would
 *    be synthesised, and converts it to 8 kHz μ-law.
 * 2. Saves it as voice-check.wav — what a caller hears, at phone quality.
 * 3. Streams that audio into AI_TRANSCRIPTION_MODEL at real speaking speed,
 *    exactly as Twilio would, and prints what came back and how fast.
 *
 * Costs a fraction of a cent. It is the quickest way to hear a voice change, or
 * to prove the API keys, formats and audio conversion work before dialling.
 */

import '../../database/load-env';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { mulawToWav } from './g711';
import { OpenAiRealtimeSttProvider } from '../stt/openai-realtime-stt.provider';
import { buildVocabularyHint } from '../stt/vocabulary-hint';
import { DEFAULT_TTS_INSTRUCTIONS, OpenAiTtsProvider } from '../tts/openai-tts.provider';

const args = process.argv.slice(2);
const textArg = args.indexOf('--text');
const SENTENCE =
  textArg >= 0 && args[textArg + 1]
    ? args[textArg + 1]!
    : "My car broke down near Liberty Market and it has to be towed. It's a Suzuki Mehran.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Share of the sentence's words that came back, ignoring case and punctuation. */
function wordMatch(expected: string, actual: string): number {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const heard = new Set(words(actual));
  const wanted = words(expected);
  return wanted.filter((w) => heard.has(w)).length / wanted.length;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const ttsModel = process.env.AI_TTS_MODEL?.trim() || 'gpt-4o-mini-tts';
  const sttModel = process.env.AI_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe';
  const voice = process.env.AI_TTS_VOICE?.trim() || 'marin';

  if (!apiKey) fail('OPENAI_API_KEY is not set in .env.');

  // ---- 1. Synthesis --------------------------------------------------------
  console.log(`Voice:          ${ttsModel} (${voice})`);
  console.log(`Sentence:       "${SENTENCE}"`);

  const tts = new OpenAiTtsProvider({
    apiKey,
    model: ttsModel,
    voice,
    instructions: process.env.AI_TTS_INSTRUCTIONS?.trim() || DEFAULT_TTS_INSTRUCTIONS,
  });

  const started = Date.now();
  let firstAudioMs: number | null = null;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of tts.stream({ text: SENTENCE })) {
      firstAudioMs ??= Date.now() - started;
      chunks.push(chunk);
    }
  } catch (error) {
    fail(`Synthesis failed: ${error instanceof Error ? error.message : error}`);
  }
  const audio = Buffer.concat(chunks);
  const audioSeconds = audio.length / 8000;

  console.log(
    `  ✓ first audio after ${firstAudioMs} ms, complete after ${Date.now() - started} ms ` +
      `(${audioSeconds.toFixed(1)} s of speech)`,
  );

  // The same phrase again: served from the cache, as repeated questions are on a call.
  const cachedStarted = Date.now();
  for await (const _chunk of tts.stream({ text: SENTENCE })) {
    // drain
  }
  console.log(`  ✓ same phrase again: ${Date.now() - cachedStarted} ms (cached)`);

  const wavPath = resolve(process.cwd(), 'voice-check.wav');
  writeFileSync(wavPath, mulawToWav(audio));
  console.log(`  ✓ saved ${wavPath} — this is how it sounds on a phone line`);

  // ---- 2. Recognition ------------------------------------------------------
  console.log(`\nRecognition:    ${sttModel}`);

  const stt = new OpenAiRealtimeSttProvider({
    apiKey,
    model: sttModel,
    silenceMs: Number(process.env.AI_TRANSCRIPTION_SILENCE_MS) || 600,
  });

  let speechStartedAt: number | null = null;
  let audioEndedAt = 0;
  let firstFinalAt: number | null = null;
  let lastError: string | null = null;
  const finals: string[] = [];
  let resolveFinal!: () => void;
  const gotFinal = new Promise<void>((r) => (resolveFinal = r));

  const session = await stt.open({
    encoding: 'mulaw',
    sampleRate: 8000,
    language: 'en',
    vocabularyHint: buildVocabularyHint({
      name: 'Liberty Towing',
      serviceAreas: ['Lahore', 'Gulberg', 'DHA', 'Model Town', 'Johar Town'],
    }),
    callbacks: {
      onSpeechStarted: () => {
        speechStartedAt ??= Date.now();
      },
      onFinalTranscript: (text) => {
        firstFinalAt ??= Date.now();
        finals.push(text);
        resolveFinal();
      },
      onError: (error) => {
        lastError = error.message;
        console.error(`  ! ${error.message}`);
      },
    },
  });

  const streamStarted = Date.now();
  // Twilio sends 20 ms frames in real time; do the same, then some silence so
  // voice-activity detection hears the caller stop.
  for (let offset = 0; offset < audio.length; offset += 160) {
    session.write(audio.subarray(offset, offset + 160));
    await sleep(20);
  }
  audioEndedAt = Date.now();
  const silence = Buffer.alloc(160, 0xff);
  const silenceUntil = Date.now() + 2_000;
  const pumpSilence = (async () => {
    while (Date.now() < silenceUntil && finals.length === 0) {
      session.write(silence);
      await sleep(20);
    }
  })();

  const timedOut = await Promise.race([
    gotFinal.then(() => false),
    sleep(15_000).then(() => true),
  ]);
  await pumpSilence;
  // Allow a trailing segment to arrive.
  await sleep(1_000);
  session.close();

  if (timedOut && finals.length === 0) {
    fail(
      `No transcript within 15 s${lastError ? ` (last error: ${lastError})` : ''}. ` +
        'Check that the key has access to the Realtime API.',
    );
  }

  const transcript = finals.join(' ');
  const match = wordMatch(SENTENCE, transcript);
  console.log(
    `  ✓ caller's speech detected ${
      speechStartedAt ? `${speechStartedAt - streamStarted} ms` : '(no speech_started event)'
    } after streaming began (includes connecting to OpenAI and the pause before the voice starts)`,
  );
  console.log(`  ✓ heard:        "${transcript}"`);
  console.log(`  ✓ words matched ${Math.round(match * 100)}%`);
  console.log(
    `  ✓ first transcript ${firstFinalAt ? firstFinalAt - audioEndedAt : '?'} ms ` +
      'after the caller stopped (includes the pause needed to detect they finished)',
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
