/**
 * Live evaluation of the realtime receptionist — conversational behaviour a
 * unit test cannot pin down, because it is the model's.
 *
 *   npm run realtime:eval                          every scenario, 3 runs each
 *   npm run realtime:eval -- --runs 1 --scenario hello,multi-info
 *   npm run realtime:check                         the quick version
 *
 * Each run opens a real session with the production prompt and tools, plays
 * the caller's lines as synthesised speech at real speed, and executes tool
 * calls against the real intake rules (in memory — no database, no phone).
 * The model is not deterministic, so each scenario reports a pass rate.
 * Costs a few cents per run.
 */

import '../../database/load-env';
import type { BusinessFacts } from '@towai/shared';

import { checkReply } from '../../conversation/guardrails';
import { applyIntake } from '../../conversation/intake';
import { DEFAULT_FLOW_LIMITS, initialContext, type ConversationContext, type FlowConfig } from '../../conversation/types';
import { OpenAiTtsProvider } from '../tts/openai-tts.provider';
import { OpenAiRealtimeConversation, type RealtimeToolCall } from './openai-realtime-conversation';
import { buildReceptionistInstructions, greetingInstructions } from './realtime-instructions';
import { TOOL, toIntakeOperation } from './realtime-tools';

const FACTS: BusinessFacts = {
  name: 'Liberty Towing',
  phone: null,
  website: null,
  address: null,
  serviceAreas: ['Dallas', 'Fort Worth', 'Arlington'],
  services: ['Local towing', 'Heavy-duty towing', 'Jump starts', 'Lockouts'],
  businessHoursText: 'Open 24 hours, 7 days a week',
  isOpenNow: true,
  pricingInfo: null,
  emergencyContact: null,
  faq: [],
  tone: 'friendly',
  businessInstructions: null,
};
const CONFIG: FlowConfig = { facts: FACTS, greeting: null, fallbackBehavior: 'callback', ...DEFAULT_FLOW_LIMITS };
const CALLER_NUMBER = '+18174098408';
const GREETING = 'Thanks for calling Liberty Towing. How can I help?';

const MISUNDERSTOOD = /\b(?:did ?n[o']?t|did not|could ?n[o']?t|could not|can ?n[o']?t|cannot) (?:quite )?(?:catch|understand|make out|get) (?:that|you|what)/i;

interface ToolRecord {
  name: string;
  args: Record<string, unknown>;
  output: Record<string, unknown>;
}

interface RunRecord {
  /** The receptionist's lines after each caller line. */
  replies: string[][];
  tools: ToolRecord[];
  errors: string[];
}

interface Scenario {
  name: string;
  what: string;
  turns: string[];
  /** Failures, empty when the run passed. */
  check(run: RunRecord): string[];
}

const allReplies = (run: RunRecord) => run.replies.flat();
const updates = (run: RunRecord) =>
  Object.assign({}, ...run.tools.filter((t) => t.name === TOOL.UPDATE).map((t) => t.args)) as Record<string, unknown>;

/** Rules every scenario must keep. */
function baseline(run: RunRecord): string[] {
  const failures: string[] = [];
  for (const reply of allReplies(run)) {
    const verdict = checkReply(reply);
    if (!verdict.ok) {
      const codes = verdict.violations.map((v) => v.code).filter((c) => c !== 'too_long');
      if (codes.length > 0) failures.push(`broke a rule (${codes.join(', ')}): "${reply}"`);
    }
  }
  run.replies.forEach((lines, i) => {
    if (lines.length === 0) failures.push(`no reply to caller line ${i + 1}`);
  });
  if (run.errors.length > 0) failures.push(`errors: ${run.errors.join('; ')}`);
  return failures;
}

function understood(run: RunRecord, turn: number): string[] {
  const reply = (run.replies[turn] ?? []).join(' ');
  return MISUNDERSTOOD.test(reply) ? [`said it did not understand: "${reply}"`] : [];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'hello',
    what: 'A bare "Hello?" gets a natural acknowledgement',
    turns: ['Hello?'],
    check: (run) => [...baseline(run), ...understood(run, 0)],
  },
  {
    name: 'small-talk',
    what: '"How are you?" gets a brief natural answer',
    turns: ['Hi, how are you doing today?'],
    check: (run) => [...baseline(run), ...understood(run, 0)],
  },
  {
    name: 'can-you-hear-me',
    what: 'A connection check mid-intake is answered, not treated as a wrong answer',
    turns: ['My car broke down and I need a tow.', 'Hello? Can you hear me?'],
    check: (run) => {
      const reply = (run.replies[1] ?? []).join(' ');
      return [
        ...baseline(run),
        ...understood(run, 1),
        ...(/\b(hear|here)\b/i.test(reply) ? [] : [`did not reassure the caller it can hear them: "${reply}"`]),
      ];
    },
  },
  {
    name: 'multi-info',
    what: 'Several details in one sentence are all saved, and a road-only location is clarified',
    turns: ['I need a tow. My name is Mike and my semi truck broke down on I-95.'],
    check: (run) => {
      const saved = updates(run);
      const failures = baseline(run);
      if (!/mike/i.test(String(saved.customerName ?? ''))) failures.push(`name not saved (got ${JSON.stringify(saved.customerName)})`);
      if (!/semi/i.test(String(saved.vehicleType ?? ''))) failures.push(`vehicle not saved (got ${JSON.stringify(saved.vehicleType)})`);
      if (!/95/.test(String(saved.location ?? ''))) failures.push(`location not saved (got ${JSON.stringify(saved.location)})`);
      const reply = allReplies(run).join(' ');
      if (!/\b(exit|cross|landmark|address|mile ?marker|near|where|intersection)\b/i.test(reply)) {
        failures.push(`did not ask to narrow down the location: "${reply}"`);
      }
      if (/\bwhat(?:'s| is) your name\b/i.test(reply)) failures.push('asked for the name it was given');
      return failures;
    },
  },
  {
    name: 'stressed',
    what: 'A stressed caller is acknowledged, not re-asked blindly',
    turns: ['My car broke down on the highway.', "I'm really stressed, I have a delivery to make."],
    check: (run) => {
      const reply = (run.replies[1] ?? []).join(' ');
      return [
        ...baseline(run),
        ...understood(run, 1),
        ...(/\b(understand|sorry|stress|okay|ok|help|hear you|take care|of course)\b/i.test(reply)
          ? []
          : [`did not acknowledge the caller: "${reply}"`]),
      ];
    },
  },
  {
    name: 'price-eta',
    what: 'Price and arrival questions are looked up, and nothing is invented',
    turns: ['How much will a tow cost, and how soon can you get here?'],
    check: (run) => {
      const failures = baseline(run);
      if (!run.tools.some((t) => t.name === TOOL.BUSINESS)) failures.push('answered without looking up the business information');
      return failures;
    },
  },
];

/* -------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const audioCache = new Map<string, Buffer>();

async function callerAudio(tts: OpenAiTtsProvider, line: string): Promise<Buffer> {
  const cached = audioCache.get(line);
  if (cached) return cached;
  const chunks: Buffer[] = [];
  for await (const chunk of tts.stream({ text: line })) chunks.push(chunk);
  const audio = Buffer.concat(chunks);
  audioCache.set(line, audio);
  return audio;
}

async function runScenario(apiKey: string, model: string, tts: OpenAiTtsProvider, scenario: Scenario): Promise<RunRecord> {
  const record: RunRecord = { replies: [], tools: [], errors: [] };
  let context: ConversationContext = initialContext({ customerPhone: CALLER_NUMBER });
  const instructions = buildReceptionistInstructions({ facts: FACTS, callerNumber: CALLER_NUMBER });

  const texts = new Map<string, string>();
  const itemOrder: string[] = [];
  let active = 0;
  let responsesDone = 0;
  let toolsPending = 0;
  let callerTurns = 0;
  let lastEvent = Date.now();
  const touch = () => (lastEvent = Date.now());

  const conversation: OpenAiRealtimeConversation = new OpenAiRealtimeConversation({
    apiKey,
    model,
    voice: process.env.AI_REALTIME_VOICE?.trim() || 'marin',
    silenceMs: Number(process.env.AI_REALTIME_SILENCE_MS) || 900,
    transcriptionModel: process.env.AI_REALTIME_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe',
    instructions,
    callbacks: {
      onSpeechStarted: touch,
      onCallerTurn: () => {
        callerTurns += 1;
        touch();
      },
      onCallerTranscript: touch,
      onResponseStarted: () => {
        active += 1;
        touch();
      },
      onAudio: touch,
      onSpokenText: (itemId, text) => {
        if (!texts.has(itemId)) itemOrder.push(itemId);
        texts.set(itemId, text);
        touch();
      },
      onResponseDone: (response) => {
        active = Math.max(0, active - 1);
        responsesDone += 1;
        touch();
        if (response.toolCalls.length > 0) {
          toolsPending += 1;
          conversation.submitToolResults(response.toolCalls.map((call) => execute(call)));
          toolsPending -= 1;
        }
      },
      onError: (error) => record.errors.push(error.message),
    },
  });

  function execute(call: RealtimeToolCall): { callId: string; output: unknown } {
    const op = toIntakeOperation(call.name, call.arguments);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
    } catch {
      /* recorded as empty */
    }
    if (!op) {
      const output = { error: `Could not use ${call.name} with those arguments.` };
      record.tools.push({ name: call.name, args, output });
      return { callId: call.callId, output };
    }
    const result = applyIntake(context, op, CONFIG, { defaultRegionPrefix: '+1' });
    context = result.context;
    record.tools.push({ name: call.name, args, output: result.output });
    return { callId: call.callId, output: result.output };
  }

  /** At least one response has finished since `after` had. */
  async function responded(after: number, limitMs = 15_000): Promise<void> {
    const started = Date.now();
    while (responsesDone <= after && Date.now() - started < limitMs) await sleep(50);
  }

  /** The receptionist has finished: nothing generating, and a moment of quiet. */
  async function quiet(limitMs = 25_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < limitMs) {
      if (active === 0 && toolsPending === 0 && Date.now() - lastEvent > 1_500) return;
      await sleep(100);
    }
  }

  try {
    conversation.requestResponse({
      instructions: `${instructions}\n\nRIGHT NOW\n${greetingInstructions(GREETING)}`,
      toolChoice: 'none',
    });
    await responded(0);
    await quiet();

    const silence = Buffer.alloc(160, 0xff);
    for (const line of scenario.turns) {
      const before = itemOrder.length;
      const turnsBefore = callerTurns;
      const doneBefore = responsesDone;
      const audio = await callerAudio(tts, line);

      for (let offset = 0; offset < audio.length; offset += 160) {
        conversation.appendAudio(audio.subarray(offset, offset + 160));
        await sleep(20);
      }
      const stoppedAt = Date.now();
      while (callerTurns === turnsBefore && Date.now() - stoppedAt < 5_000) {
        conversation.appendAudio(silence);
        await sleep(20);
      }
      touch();
      await responded(doneBefore);
      await quiet();
      record.replies.push(itemOrder.slice(before).map((id) => texts.get(id) ?? '').filter(Boolean));
    }
  } finally {
    conversation.close();
  }
  return record;
}

function parseArgs(): { runs: number; only: Set<string> | null } {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const runs = Math.max(1, Number(value('--runs')) || 3);
  const scenario = value('--scenario');
  return { runs, only: scenario ? new Set(scenario.split(',').map((s) => s.trim())) : null };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error('\n✗ OPENAI_API_KEY is not set in .env.\n');
    process.exit(1);
  }
  const model = process.env.AI_REALTIME_MODEL?.trim() || 'gpt-realtime-mini';
  const { runs, only } = parseArgs();
  const scenarios = SCENARIOS.filter((s) => !only || only.has(s.name));
  if (scenarios.length === 0) {
    console.error(`\n✗ No such scenario. Choose from: ${SCENARIOS.map((s) => s.name).join(', ')}\n`);
    process.exit(1);
  }

  // Test input only: a synthetic caller voice.
  const tts = new OpenAiTtsProvider({ apiKey, model: 'gpt-4o-mini-tts', voice: 'ash' });
  console.log(`Model: ${model}   runs per scenario: ${runs}\n`);

  let allPassed = true;
  for (const scenario of scenarios) {
    let passed = 0;
    const notes: string[] = [];

    for (let i = 1; i <= runs; i += 1) {
      const run = await runScenario(apiKey, model, tts, scenario);
      const failures = scenario.check(run);
      if (failures.length === 0) passed += 1;

      notes.push(`  run ${i}: ${failures.length === 0 ? 'pass' : 'FAIL'}`);
      scenario.turns.forEach((line, t) => {
        notes.push(`    caller:       ${line}`);
        for (const reply of run.replies[t] ?? []) notes.push(`    receptionist: ${reply}`);
      });
      for (const tool of run.tools) notes.push(`    tool:         ${tool.name} ${JSON.stringify(tool.args)}`);
      for (const failure of failures) notes.push(`    ✗ ${failure}`);
    }

    allPassed &&= passed === runs;
    console.log(`${passed === runs ? '✓' : '✗'} ${scenario.name} — ${passed}/${runs} — ${scenario.what}`);
    console.log(notes.join('\n'));
    console.log('');
  }

  console.log(allPassed ? '✓ every scenario passed every run' : '✗ some runs failed — see above');
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
