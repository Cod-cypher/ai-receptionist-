/**
 * Reliability benchmark for the realtime receptionist.
 *
 *   npm run realtime:eval -- --pilot                  3 runs of every scenario, reports tokens per run
 *   npm run realtime:eval -- --label baseline         the focused plan: 30 runs targeted, 5 the rest
 *   npm run realtime:eval -- --label after --compare realtime-eval-results/baseline.json
 *   npm run realtime:eval -- --scenario hello --runs 1
 *
 * Every run is a real gpt-realtime session driven through the production
 * gateway (see eval/harness.ts). Results are saved as JSON so two benchmarks
 * can be compared. Costs are printed when REALTIME_PRICE_* are set in .env.
 */

import '../../database/load-env';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { OpenAiTtsProvider } from '../tts/openai-tts.provider';
import { runCall, type HarnessOptions } from './eval/harness';
import { SCENARIOS, type Scenario } from './eval/scenarios';
import { scoreRun, type Failure, type FailureCategory } from './eval/score';
import { describeUsage, emptyUsage, estimateCost, mergeUsage, pricesFromEnv, type UsageTotals } from './usage';

interface ScenarioResult {
  name: string;
  group: string;
  targeted: boolean;
  runs: number;
  passed: number;
  categories: Partial<Record<FailureCategory, number>>;
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

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error('\n✗ OPENAI_API_KEY is not set in .env.\n');
    process.exit(1);
  }
  const args = parseArgs();
  const model = process.env.AI_REALTIME_MODEL?.trim() || 'gpt-realtime-mini';
  const scenarios = SCENARIOS.filter((s) => !args.only || args.only.has(s.name));
  if (scenarios.length === 0) {
    console.error(`\n✗ No such scenario. Choose from: ${SCENARIOS.map((s) => s.name).join(', ')}\n`);
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
    transcriptionModel: process.env.AI_REALTIME_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe',
    speed: args.speed,
    callerAudio,
  };

  const totalRuns = scenarios.reduce((n, s) => n + runsFor(s), 0);
  console.log(`Model ${model} · ${scenarios.length} scenarios · ${totalRuns} runs · ${args.concurrency} at a time · playback ×${args.speed}\n`);

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
    const usage = emptyUsage();
    const has = (fs: Failure[], c: FailureCategory) => fs.some((f) => f.category === c);
    for (const o of mine) {
      mergeUsage(usage, o.run.usage);
      for (const c of new Set(o.failures.map((f) => f.category))) categories[c] = (categories[c] ?? 0) + 1;
    }
    return {
      name: scenario.name,
      group: scenario.group,
      targeted: scenario.targeted,
      runs: mine.length,
      passed: mine.filter((o) => o.failures.length === 0).length,
      categories,
      missingFieldRate: mine.filter((o) => has(o.failures, 'FIELD_OMITTED')).length / Math.max(1, mine.length),
      wrongPriorityRate: mine.filter((o) => has(o.failures, 'RESPONSE_DID_NOT_FOLLOW_ACTION')).length / Math.max(1, mine.length),
      wrongSpecificityRate: mine.filter((o) => has(o.failures, 'WRONG_SPECIFICITY')).length / Math.max(1, mine.length),
      usage,
      sampleFailures: mine.flatMap((o) => o.failures.map((f) => `[${f.category} · ${f.source}] ${f.detail}`)).slice(0, 4),
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
    if (args.verbose) for (const f of r.sampleFailures) console.log(`      ${f}`);
  }

  const total = emptyUsage();
  for (const r of results) mergeUsage(total, r.usage);
  const passed = results.reduce((n, r) => n + r.passed, 0);
  const runs = results.reduce((n, r) => n + r.runs, 0);
  console.log(`\nOverall ${passed}/${runs} (${pct(passed, runs)}) · * = targeted scenario`);
  console.log(`Rate limit: ${retries} retries; ${excludedRuns} run(s) still cut short and left out of the scores.`);
  console.log(`Tokens: ${describeUsage(total)}`);
  console.log(`Per run: ${Math.round((total.textIn + total.audioIn + total.textOut + total.audioOut) / Math.max(1, runs))} tokens`);
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
