/**
 * Reliability benchmark for the realtime receptionist.
 *
 *   npm run realtime:eval -- --pilot                  3 runs of every scenario, reports tokens per run
 *   npm run realtime:eval -- --label baseline         the focused plan: 30 runs targeted, 5 the rest
 *   npm run realtime:eval -- --label after --compare realtime-eval-results/baseline.json
 *   npm run realtime:eval -- --scenario hello --runs 1
 *   npm run realtime:eval -- --group conversation --runs 2 [--verbose]
 *
 * --group takes any scenario group (comma-separated for several); --scenario
 * takes names. --verbose prints sample failures and, for each scenario, every
 * line of up to three runs (failed runs first), so the replies can be read.
 *
 * Every run is a real gpt-realtime session driven through the production
 * gateway (see eval/harness.ts). Results are saved as JSON so two benchmarks
 * can be compared. Costs are printed when REALTIME_PRICE_* are set in .env.
 */

import '../../database/load-env';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createCallJudge } from '../judgment/judgment.module';
import { OpenAiTtsProvider } from '../tts/openai-tts.provider';
import {
  OpenAiRealtimeConversation,
  readReasoningEffort,
  realtimeTotals,
  reasoningLabel,
  type RealtimeConversationFactory,
} from './openai-realtime-conversation';
import { RealtimeFillerBank } from './filler-bank';
import { runCall, type HarnessOptions, type RunRecord } from './eval/harness';
import { SCENARIOS, type Scenario } from './eval/scenarios';
import { OVERLONG_WORDS, scoreRun, type Failure, type FailureCategory } from './eval/score';
import { describeUsage, emptyUsage, estimateCost, mergeUsage, pricesFromEnv, type UsageTotals } from './usage';

interface ScenarioResult {
  name: string;
  group: string;
  targeted: boolean;
  runs: number;
  /** Runs with no failure; a soft one (`notes`) does not fail a run. */
  passed: number;
  categories: Partial<Record<FailureCategory, number>>;
  /** Runs on which each soft category was reported. */
  notes: Partial<Record<FailureCategory, number>>;
  missingFieldRate: number;
  wrongPriorityRate: number;
  wrongSpecificityRate: number;
  usage: UsageTotals;
  sampleFailures: string[];
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    pilot: argv.includes('--pilot'),
    runs: value('--runs') ? Math.max(1, Number(value('--runs'))) : null,
    only: value('--scenario') ? new Set(value('--scenario')!.split(',').map((s) => s.trim())) : null,
    groups: value('--group') ? new Set(value('--group')!.split(',').map((g) => g.trim())) : null,
    // gpt-realtime-mini accounts start at 40,000 tokens per minute; at about
    // 4-5k tokens per run, more than two at once hits the limit.
    concurrency: Math.max(1, Number(value('--concurrency')) || 2),
    speed: Math.max(1, Number(value('--speed')) || 3),
    label: value('--label') ?? 'run',
    compare: value('--compare') ?? null,
    verbose: argv.includes('--verbose'),
  };
}

const TARGETED_RUNS = 30;
const OTHER_RUNS = 5;

async function pool<T>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]!();
      }
    }),
  );
  return results;
}

const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Retries for a run cut short by the rate limit, with a growing pause. */
const RATE_LIMIT_RETRIES = 4;

/**
 * How human the replies sound, summed over every run. A reply that ignored
 * the caller passed the older checks (the call of 12 October, 6d1304af);
 * these are what moves when the voice gets better or worse.
 */
const HUMAN_NESS: Array<[FailureCategory, string]> = [
  ['IGNORED_CALLER', 'a line that needed a reply got none, or got the next question first'],
  ['ROBOTIC_PHRASING', 'form language ("Could you describe ...")'],
  ['REPEATED_OPENER', 'two replies in a row starting with the same two words'],
  ['OVERLONG_REPLY', `more than ${OVERLONG_WORDS} words in a turn, outside the read-back`],
  ['NO_ACK_AFTER_DETAIL', 'a detail met cold; soft, except where a scenario requires the ack'],
  ['STOPPED_REPLY', 'a reply the gateway had to stop (off the plan, or a broken rule); the caller heard at most part of it; soft'],
];

/** Runs per scenario printed line by line with --verbose. */
const VERBOSE_SAMPLE_RUNS = 3;

const failedRun = (failures: Failure[]) => failures.some((f) => !f.soft);

/** Every line of a run: what the caller said, and every reply the receptionist generated to it. */
function printRun(run: RunRecord, label: string): void {
  console.log(`      ${label}`);
  run.turns.forEach((turn, i) => {
    console.log(`        ${i + 1}. caller: ${turn.caller}`);
    if (turn.replies.length === 0) console.log('           receptionist: (nothing)');
    for (const reply of turn.replies) console.log(`           receptionist: ${reply}`);
  });
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error('\n✗ OPENAI_API_KEY is not set in .env.\n');
    process.exit(1);
  }
  const args = parseArgs();
  const model = process.env.AI_REALTIME_MODEL?.trim() || 'gpt-realtime-mini';
  const scenarios = SCENARIOS.filter((s) => (!args.only || args.only.has(s.name)) && (!args.groups || args.groups.has(s.group)));
  if (scenarios.length === 0) {
    console.error(
      `\n✗ No such scenario. Choose from: ${SCENARIOS.map((s) => s.name).join(', ')}\n` +
        `  or a --group: ${[...new Set(SCENARIOS.map((s) => s.group))].join(', ')}\n`,
    );
    process.exit(1);
  }
  const runsFor = (s: Scenario) => args.runs ?? (args.pilot ? 3 : s.targeted ? TARGETED_RUNS : OTHER_RUNS);

  // Test input only: a synthetic caller voice, synthesised once per line.
  const tts = new OpenAiTtsProvider({ apiKey, model: 'gpt-4o-mini-tts', voice: 'ash' });
  const audio = new Map<string, Promise<Buffer>>();
  const callerAudio = (line: string) => {
    if (!audio.has(line)) {
      audio.set(
        line,
        (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of tts.stream({ text: line })) chunks.push(chunk);
          return Buffer.concat(chunks);
        })(),
      );
    }
    return audio.get(line)!;
  };

  const options: HarnessOptions = {
    apiKey,
    model,
    voice: process.env.AI_REALTIME_VOICE?.trim() || 'marin',
    silenceMs: Number(process.env.AI_REALTIME_SILENCE_MS) || 900,
    turnDetection: process.env.AI_REALTIME_TURN_DETECTION?.trim() === 'semantic_vad' ? 'semantic_vad' : 'server_vad',
    eagerness: (['low', 'medium', 'high', 'auto'] as const).find((e) => e === process.env.AI_REALTIME_VAD_EAGERNESS?.trim()) ?? 'auto',
    noiseReduction:
      (['near_field', 'far_field', 'off'] as const).find((n) => n === process.env.AI_REALTIME_NOISE_REDUCTION?.trim()) ?? 'near_field',
    reasoningEffort: readReasoningEffort(process.env.AI_REALTIME_REASONING_EFFORT),
    transcriptionModel: process.env.AI_REALTIME_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-transcribe',
    speed: args.speed,
    callerAudio,
    // As on a live call: Jev when TYPESAFE_API_KEY is set, the rules otherwise.
    judge: createCallJudge(
      {
        apiKey: process.env.TYPESAFE_API_KEY?.trim(),
        model: process.env.TYPESAFE_MODEL?.trim() || undefined,
        timeoutMs: Number(process.env.TYPESAFE_TIMEOUT_MS) || undefined,
      },
      { log: (m: string) => console.log(m), warn: (m: string) => console.warn(m), debug: () => {} },
    ),
  };

  // The filler lines a live call plays while a reply is slow, synthesised
  // once for the whole benchmark, so a run measures what ships.
  const fillerFactory: RealtimeConversationFactory = ({ instructions, callbacks, label }) =>
    new OpenAiRealtimeConversation({
      apiKey,
      model,
      voice: options.voice,
      silenceMs: options.silenceMs,
      reasoningEffort: options.reasoningEffort,
      transcriptionModel: options.transcriptionModel,
      instructions,
      callbacks,
      label,
    });
  const fillers = new RealtimeFillerBank(fillerFactory);
  await fillers.warmUp();
  options.fillers = fillers;

  const totalRuns = scenarios.reduce((n, s) => n + runsFor(s), 0);
  const reasoning = reasoningLabel(model, options.reasoningEffort);
  console.log(`Model ${model}${reasoning ? ` (${reasoning})` : ''} · ${scenarios.length} scenarios · ${totalRuns} runs · ${args.concurrency} at a time · playback ×${args.speed}\n`);

  const prices = pricesFromEnv();
  const started = Date.now();
  let finished = 0;
  let retries = 0;
  const tasks = scenarios.flatMap((scenario) =>
    Array.from({ length: runsFor(scenario) }, () => async () => {
      let run = await runCall(options, scenario.lines);
      for (let attempt = 1; run.rateLimited && attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
        retries += 1;
        await sleep(15_000 * attempt);
        run = await runCall(options, scenario.lines);
      }
      // A run the rate limit still cut short measures the account, not the
      // receptionist: it is reported, never scored.
      const excluded = run.rateLimited;
      const failures = excluded ? [] : scoreRun(scenario, run);
      finished += 1;
      if (finished % 10 === 0 || finished === totalRuns) {
        process.stdout.write(`  ${finished}/${totalRuns} runs (${Math.round((Date.now() - started) / 1000)}s, ${retries} rate-limit retries)\n`);
      }
      return { scenario, run, failures, excluded };
    }),
  );
  const outcomes = await pool(tasks, args.concurrency);
  const excludedRuns = outcomes.filter((o) => o.excluded).length;

  const results: ScenarioResult[] = scenarios.map((scenario) => {
    const mine = outcomes.filter((o) => o.scenario === scenario && !o.excluded);
    const categories: Partial<Record<FailureCategory, number>> = {};
    const notes: Partial<Record<FailureCategory, number>> = {};
    const usage = emptyUsage();
    const has = (fs: Failure[], c: FailureCategory) => fs.some((f) => f.category === c && !f.soft);
    for (const o of mine) {
      mergeUsage(usage, o.run.usage);
      for (const c of new Set(o.failures.filter((f) => !f.soft).map((f) => f.category))) categories[c] = (categories[c] ?? 0) + 1;
      for (const c of new Set(o.failures.filter((f) => f.soft).map((f) => f.category))) notes[c] = (notes[c] ?? 0) + 1;
    }
    // Failures first; soft notes only fill what is left of the sample.
    const samples = [...mine.flatMap((o) => o.failures.filter((f) => !f.soft)), ...mine.flatMap((o) => o.failures.filter((f) => f.soft))];
    return {
      name: scenario.name,
      group: scenario.group,
      targeted: scenario.targeted,
      runs: mine.length,
      passed: mine.filter((o) => !failedRun(o.failures)).length,
      categories,
      notes,
      missingFieldRate: mine.filter((o) => has(o.failures, 'FIELD_OMITTED')).length / Math.max(1, mine.length),
      wrongPriorityRate: mine.filter((o) => has(o.failures, 'RESPONSE_DID_NOT_FOLLOW_ACTION')).length / Math.max(1, mine.length),
      wrongSpecificityRate: mine.filter((o) => has(o.failures, 'WRONG_SPECIFICITY')).length / Math.max(1, mine.length),
      usage,
      sampleFailures: samples.slice(0, 4).map((f) => `[${f.category} · ${f.source}${f.soft ? ' · soft' : ''}] ${f.detail}`),
    };
  });

  // ---- Report ----
  const baseline: ScenarioResult[] | null = args.compare
    ? (JSON.parse(readFileSync(resolve(process.cwd(), args.compare), 'utf8')) as { results: ScenarioResult[] }).results
    : null;

  console.log('\nScenario                                   Pass      Missing  Priority  Specific  Tokens/run');
  for (const r of results) {
    const before = baseline?.find((b) => b.name === r.name);
    const tokens = Math.round((r.usage.textIn + r.usage.audioIn + r.usage.textOut + r.usage.audioOut) / Math.max(1, r.runs));
    const delta = before ? ` (was ${pct(before.passed, before.runs)})` : '';
    console.log(
      `${(r.targeted ? '* ' : '  ') + r.name.padEnd(41)}${`${pct(r.passed, r.runs)} ${r.passed}/${r.runs}`.padEnd(10)}${pct(r.missingFieldRate, 1).padEnd(9)}${pct(r.wrongPriorityRate, 1).padEnd(10)}${pct(r.wrongSpecificityRate, 1).padEnd(10)}${tokens}${delta}`,
    );
    const cats = Object.entries(r.categories).map(([c, n]) => `${c}×${n}`).join(', ');
    if (cats) console.log(`      failures: ${cats}`);
    const notes = Object.entries(r.notes).map(([c, n]) => `${c}×${n}`).join(', ');
    if (notes) console.log(`      notes (soft, not failed): ${notes}`);
    if (args.verbose) {
      for (const f of r.sampleFailures) console.log(`      ${f}`);
      // The replies themselves: a score says a reply was wrong, only the words say how.
      const mine = outcomes.filter((o) => o.scenario.name === r.name && !o.excluded);
      const sample = [...mine.filter((o) => failedRun(o.failures)), ...mine.filter((o) => !failedRun(o.failures))].slice(0, VERBOSE_SAMPLE_RUNS);
      for (const o of sample) printRun(o.run, `run ${mine.indexOf(o) + 1} of ${mine.length} (${failedRun(o.failures) ? 'failed' : 'passed'})`);
    }
  }

  const total = emptyUsage();
  for (const r of results) mergeUsage(total, r.usage);
  const passed = results.reduce((n, r) => n + r.passed, 0);
  const runs = results.reduce((n, r) => n + r.runs, 0);
  console.log(`\nOverall ${passed}/${runs} (${pct(passed, runs)}) · * = targeted scenario`);
  const scored = outcomes.filter((o) => !o.excluded);
  console.log(`Human-ness, runs with each (of ${scored.length}):`);
  for (const [category, meaning] of HUMAN_NESS) {
    const failed = scored.filter((o) => o.failures.some((f) => f.category === category && !f.soft)).length;
    const noted = scored.filter((o) => o.failures.some((f) => f.category === category && f.soft)).length;
    console.log(`  ${category.padEnd(21)}${`${failed} failed${noted > 0 ? `, ${noted} noted` : ''}`.padEnd(22)}${meaning}`);
  }
  console.log(`Rate limit: ${retries} retries; ${excludedRuns} run(s) still cut short and left out of the scores.`);
  console.log(`Tokens: ${describeUsage(total)}`);
  // What the run cost against OpenAI's request limits, which live calls share.
  const openai = realtimeTotals();
  console.log(
    `OpenAI requests: ${openai.sessions} realtime sessions, ${openai.responsesRequested} responses requested, ` +
      `${openai.responsesCreated} created`,
  );
  console.log(`Per run: ${Math.round((total.textIn + total.audioIn + total.textOut + total.audioOut) / Math.max(1, runs))} tokens`);
  // How long callers wait for a reply once they stop talking (the model's
  // time; playback speed does not affect it). The bar is ElevenLabs-class: ~1s.
  const spread = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
    return sorted.length > 0 ? `median ${at(0.5)}ms, p90 ${at(0.9)}ms, max ${sorted.at(-1)}ms (${sorted.length} turns)` : null;
  };
  const latency = spread(outcomes.flatMap((o) => o.run.replyLatencyMs));
  if (latency) console.log(`Reply latency after the caller's turn ends: ${latency}`);
  // What the caller actually waits: from the end of their line, so the turn
  // detector's own delay is in it. That delay is in audio time, and so
  // shorter here than on a call whenever playback is faster than real time.
  const endpoint = spread(outcomes.flatMap((o) => o.run.endpointMs));
  const heard = spread(outcomes.flatMap((o) => o.run.lastWordToReplyMs));
  const compressed = args.speed === 1 ? '' : ` [turn detection compressed by playback ×${args.speed}]`;
  if (endpoint) console.log(`Turn ended after the caller's last word: ${endpoint}${compressed}`);
  if (heard) console.log(`Reply after the caller's last word: ${heard}${compressed}`);
  if (prices) {
    const cost = estimateCost(total, prices);
    console.log(`Estimated cost: $${cost.toFixed(2)} total, $${(cost / runs).toFixed(4)} per run`);
  } else {
    console.log('Set REALTIME_PRICE_* in .env (USD per 1M tokens) to see the cost.');
  }

  const dir = resolve(process.cwd(), 'realtime-eval-results');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${args.label}.json`);
  writeFileSync(file, JSON.stringify({ model, label: args.label, at: new Date().toISOString(), results }, null, 2));
  console.log(`Saved ${file}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
