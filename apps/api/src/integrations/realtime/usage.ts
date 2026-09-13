/**
 * Token usage for a call, from what OpenAI reports after every response and
 * every caller transcription.
 *
 * Prices are not hard-coded: they change, and differ by model. Set them in
 * `.env` (US dollars per million tokens, from OpenAI's pricing page) to get a
 * cost estimate; without them, usage is reported in tokens only.
 */

export interface UsageTotals {
  responses: number;
  /** Input text tokens, including the cached ones counted below. */
  textIn: number;
  cachedTextIn: number;
  audioIn: number;
  cachedAudioIn: number;
  textOut: number;
  audioOut: number;
  transcriptionAudioIn: number;
  transcriptionTextIn: number;
  transcriptionTextOut: number;
}

export const emptyUsage = (): UsageTotals => ({
  responses: 0,
  textIn: 0,
  cachedTextIn: 0,
  audioIn: 0,
  cachedAudioIn: 0,
  textOut: 0,
  audioOut: 0,
  transcriptionAudioIn: 0,
  transcriptionTextIn: 0,
  transcriptionTextOut: 0,
});

type Loose = Record<string, unknown> | undefined;
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const obj = (value: unknown): Loose => (value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined);

export function addResponseUsage(totals: UsageTotals, usage: unknown): void {
  const u = obj(usage);
  if (!u) return;
  const input = obj(u.input_token_details);
  const cached = obj(input?.cached_tokens_details);
  const output = obj(u.output_token_details);

  totals.responses += 1;
  totals.textIn += num(input?.text_tokens);
  totals.audioIn += num(input?.audio_tokens);
  totals.cachedTextIn += num(cached?.text_tokens);
  totals.cachedAudioIn += num(cached?.audio_tokens);
  totals.textOut += num(output?.text_tokens);
  totals.audioOut += num(output?.audio_tokens);
}

export function addTranscriptionUsage(totals: UsageTotals, usage: unknown): void {
  const u = obj(usage);
  if (!u) return;
  const input = obj(u.input_token_details);
  totals.transcriptionAudioIn += num(input?.audio_tokens);
  totals.transcriptionTextIn += num(input?.text_tokens);
  totals.transcriptionTextOut += num(u.output_tokens);
}

export function mergeUsage(into: UsageTotals, from: UsageTotals): void {
  for (const key of Object.keys(into) as Array<keyof UsageTotals>) into[key] += from[key];
}

export interface UsagePrices {
  textIn: number;
  cachedTextIn: number;
  audioIn: number;
  cachedAudioIn: number;
  textOut: number;
  audioOut: number;
  transcriptionAudioIn: number;
  transcriptionTextIn: number;
  transcriptionTextOut: number;
}

const PRICE_ENV: Record<keyof UsagePrices, string> = {
  textIn: 'REALTIME_PRICE_TEXT_IN',
  cachedTextIn: 'REALTIME_PRICE_CACHED_TEXT_IN',
  audioIn: 'REALTIME_PRICE_AUDIO_IN',
  cachedAudioIn: 'REALTIME_PRICE_CACHED_AUDIO_IN',
  textOut: 'REALTIME_PRICE_TEXT_OUT',
  audioOut: 'REALTIME_PRICE_AUDIO_OUT',
  transcriptionAudioIn: 'TRANSCRIBE_PRICE_AUDIO_IN',
  transcriptionTextIn: 'TRANSCRIBE_PRICE_TEXT_IN',
  transcriptionTextOut: 'TRANSCRIBE_PRICE_TEXT_OUT',
};

/** Null unless the realtime prices are set; transcription prices default to 0. */
export function pricesFromEnv(env: NodeJS.ProcessEnv = process.env): UsagePrices | null {
  const prices = {} as UsagePrices;
  for (const [key, name] of Object.entries(PRICE_ENV) as Array<[keyof UsagePrices, string]>) {
    const value = Number(env[name]);
    if (!env[name] || !Number.isFinite(value)) {
      if (key.startsWith('transcription')) {
        prices[key] = 0;
        continue;
      }
      return null;
    }
    prices[key] = value;
  }
  return prices;
}

/** US dollars. Cached tokens are billed at the cached rate, the rest at the full rate. */
export function estimateCost(t: UsageTotals, p: UsagePrices): number {
  const perToken = (count: number, pricePerMillion: number) => (count * pricePerMillion) / 1_000_000;
  return (
    perToken(t.textIn - t.cachedTextIn, p.textIn) +
    perToken(t.cachedTextIn, p.cachedTextIn) +
    perToken(t.audioIn - t.cachedAudioIn, p.audioIn) +
    perToken(t.cachedAudioIn, p.cachedAudioIn) +
    perToken(t.textOut, p.textOut) +
    perToken(t.audioOut, p.audioOut) +
    perToken(t.transcriptionAudioIn, p.transcriptionAudioIn) +
    perToken(t.transcriptionTextIn, p.transcriptionTextIn) +
    perToken(t.transcriptionTextOut, p.transcriptionTextOut)
  );
}

export function describeUsage(t: UsageTotals): string {
  return (
    `text in ${t.textIn} (${t.cachedTextIn} cached), audio in ${t.audioIn} (${t.cachedAudioIn} cached), ` +
    `text out ${t.textOut}, audio out ${t.audioOut}; transcription audio ${t.transcriptionAudioIn}`
  );
}
