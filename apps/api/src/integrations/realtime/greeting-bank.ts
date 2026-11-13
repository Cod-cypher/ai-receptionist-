/**
 * The greeting in the call voice, recorded before the call, so it can play
 * the instant the stream starts instead of after the session connects and
 * the model speaks (1.5 to 2.5 s of dead air on a real call).
 *
 * Each greeting is recorded with the filler bank's take logic: one take at a
 * time, out of band, kept only when its own transcript shows it is the line.
 * The voice (and speed) is the process's, through the same session factory as
 * the calls, so one recording per greeting text is enough.
 *
 * Every business's greeting is recorded at start-up. A greeting first seen
 * on a call (a business added, or its greeting changed, since) is spoken by
 * the model on that call, as it always was, and recorded for the next one.
 */

import { Injectable, Logger } from '@nestjs/common';

import { renderTemplate } from '../../conversation/response-templates';
import { comparable, recordLines, type Filler } from './filler-bank';
import type { RealtimeConversationFactory } from './openai-realtime-conversation';

/**
 * Greetings kept. One per business today; past the cap, the greeting no call
 * has used for longest is dropped, and recorded again if a call needs it.
 */
const MAX_GREETINGS = 50;
/**
 * A greeting is a sentence or two, 8 to 15 words: 3 to 6 s at a calm 150
 * words a minute, so 8 s covers it with room to spare. A longer one an
 * operator wrote gets 0.6 s a word (a digit of a phone number counts as a
 * word), slower than that calm pace of 0.4 s, so only a take with something
 * added runs past it.
 */
const MAX_GREETING_MS = 8_000;
const MS_PER_WORD = 600;
/** Time allowed per greeting in a batch, and for the whole batch. Greetings not reached are recorded on their first call. */
const TIME_PER_GREETING_MS = 15_000;
const MAX_BATCH_MS = 5 * 60_000;
/**
 * A greeting that could not be recorded is not tried again for this long:
 * every call to that business would otherwise open a recording session of
 * its own, alongside the call's.
 */
const RETRY_AFTER_MS = 10 * 60_000;

/**
 * Number words a phone number in a greeting may be read back as. Read the
 * same way on both sides, so "oh" in "Oh, hello" costs nothing.
 */
const DIGIT_WORDS: Record<string, string> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  // "three", once the comparable form has folded its double letter.
  thre: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/**
 * The words of a greeting, as compared: the comparable form, with letters
 * split from digits ("A1 Towing" is "A-1 Towing") and every number, written
 * in digits or in words, as single digits, so "555-0123" read as "five five
 * five, oh one two three" is the same words.
 */
export function greetingWords(text: string): string[] {
  return comparable(text)
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .flatMap((word) => (/^\p{N}+$/u.test(word) ? [...word] : [DIGIT_WORDS[word] ?? word]));
}

/** How many words two lines share in the same order: the longest common subsequence. */
function sharedInOrder(a: readonly string[], b: readonly string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    const row = [0];
    for (let j = 0; j < b.length; j += 1) {
      row.push(word === b[j] ? previous[j]! + 1 : Math.max(previous[j + 1]!, row[j]!));
    }
    previous = row;
  }
  return previous[b.length]!;
}

/**
 * Whether a take of a greeting said the greeting.
 *
 * Looser than a filler's exact match, because a greeting carries a business
 * name and sometimes a phone number the model may read slightly differently.
 * Up to one word in ten of the greeting may be missing or different (at least
 * one word for any greeting), and up to one word in ten of the greeting's
 * length may be added: so 90% of the words of a long greeting must be there
 * in order. Both directions matter. The first catches a take that drops the
 * end ("How can I help?" is four of nine words); the second a take that says
 * the greeting and then adds a question of its own, which would be played to
 * every caller.
 */
export function saysGreeting(said: string, line: string): boolean {
  const heard = greetingWords(said);
  const meant = greetingWords(line);
  if (heard.length === 0 || meant.length === 0) return false;
  const slack = Math.max(1, Math.floor(meant.length / 10));
  const shared = sharedInOrder(heard, meant);
  return shared >= meant.length - slack && heard.length - shared <= slack;
}

/** What the greeting warm-up needs to know about the businesses calls can reach. */
export interface GreetingDirectory {
  /** Every business a phone number routes calls to. */
  routedBusinessIds(): Promise<readonly string[]>;
  /** The configuration a call to that business loads (`BusinessConfigService.load`). */
  load(businessId: string): Promise<{
    business: { status: string };
    flow: { greeting: string | null; facts: { name: string } };
  }>;
}

/**
 * The greeting a call to that business opens with, word for word: on the
 * chatgpt pipeline the voice webhook renders the GREET template unphrased,
 * so it is the configured greeting, or the default made from the name.
 */
export function greetingFor(flow: { greeting: string | null; facts: { name: string } }): string {
  return renderTemplate({ kind: 'GREET' }, { businessName: flow.facts.name, greeting: flow.greeting }).trim();
}

/**
 * The greeting of every active business a call can reach, each once. A
 * business whose configuration fails to load is left out (its first call
 * records it); a failure to list the businesses rejects.
 */
export async function listGreetings(
  directory: GreetingDirectory,
  logger: Pick<Logger, 'warn'> = new Logger('RealtimeGreetings'),
): Promise<string[]> {
  const greetings = new Set<string>();
  for (const businessId of await directory.routedBusinessIds()) {
    try {
      const config = await directory.load(businessId);
      if (config.business.status !== 'active') continue;
      const greeting = greetingFor(config.flow);
      if (greeting) greetings.add(greeting);
    } catch (error) {
      logger.warn(`Greeting of business ${businessId} not loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...greetings];
}

@Injectable()
export class GreetingBank {
  private readonly logger = new Logger('RealtimeGreetings');
  /** By text, least recently used first: a Map keeps insertion order, and a greeting used moves to the end. */
  private readonly greetings = new Map<string, Filler>();
  /** The recording each greeting being recorded will end with, so a second ask waits for the first. */
  private readonly recording = new Map<string, Promise<Filler | null>>();
  private readonly failedAt = new Map<string, number>();
  /**
   * One recording session at a time: the warm-up and greetings recorded on
   * demand queue behind each other instead of competing for the realtime API.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly createConversation: RealtimeConversationFactory,
    /** The call voice, for the logs: it is set per process (AI_REALTIME_VOICE). */
    private readonly voice: string | null = null,
  ) {}

  get size(): number {
    return this.greetings.size;
  }

  /** The recorded greeting for `text`, or null when none is ready: the gateway then plays the model's. */
  get(text: string): Filler | null {
    const key = text.trim();
    const greeting = this.greetings.get(key);
    if (!greeting) return null;
    this.greetings.delete(key);
    this.greetings.set(key, greeting);
    return greeting;
  }

  /** Records every greeting given, in the call voice. Resolves when done or given up; never rejects. */
  async warmUp(greetings: readonly string[]): Promise<void> {
    const todo = [...new Set(greetings.map((greeting) => greeting.trim()).filter(Boolean))]
      .filter((greeting) => !this.greetings.has(greeting) && !this.recording.has(greeting))
      .slice(0, MAX_GREETINGS);
    if (todo.length === 0) return;
    await this.recordBatch(todo);
  }

  /**
   * Records one greeting first seen on a call, for the calls after it.
   * Resolves with the recording, or null when it could not be made; never
   * rejects. Asked again while it is being made, it returns the same
   * recording; once made, the one kept.
   */
  record(text: string): Promise<Filler | null> {
    const key = text.trim();
    if (!key) return Promise.resolve(null);
    const ready = this.greetings.get(key);
    if (ready) return Promise.resolve(ready);
    const inFlight = this.recording.get(key);
    if (inFlight) return inFlight;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return Promise.resolve(null);
    void this.recordBatch([key]);
    return this.recording.get(key)!;
  }

  private recordBatch(texts: readonly string[]): Promise<void> {
    const settle = new Map<string, (take: Filler | null) => void>();
    for (const text of texts) {
      this.recording.set(text, new Promise<Filler | null>((resolve) => settle.set(text, resolve)));
    }
    const done = (text: string, take: Filler | null) => {
      const resolve = settle.get(text);
      if (!resolve) return;
      settle.delete(text);
      this.recording.delete(text);
      if (take) {
        this.keep(take);
        this.failedAt.delete(text);
      } else {
        this.failedAt.set(text, Date.now());
        if (this.failedAt.size > MAX_GREETINGS) this.failedAt.delete(this.failedAt.keys().next().value!);
      }
      resolve(take);
    };

    const run = this.queue
      .then(async () => {
        this.logger.log(`Recording ${texts.length} greeting(s) in voice ${this.voice ?? '(default)'}`);
        await recordLines(this.createConversation, texts, {
          label: 'greeting-warm-up',
          instructions:
            'You are recording the opening line of a telephone receptionist, played when a call is answered. ' +
            'Each request names one line. Say that line exactly, warmly and naturally, as you would answer the phone, ' +
            'and nothing else: no words of your own before or after it.',
          logger: this.logger,
          maxMs: Math.min(TIME_PER_GREETING_MS * texts.length, MAX_BATCH_MS),
          noun: 'Greeting',
          withoutThem: 'The model will speak them on calls.',
          maxTakeMs: (line) => Math.max(MAX_GREETING_MS, greetingWords(line).length * MS_PER_WORD),
          isLine: saysGreeting,
          onLine: (take) => done(take.text, take),
        });
      })
      .catch((error: unknown) => {
        this.logger.warn(`Greetings not recorded: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        for (const text of [...settle.keys()]) done(text, null);
      });
    this.queue = run;
    return run;
  }

  private keep(take: Filler): void {
    this.greetings.delete(take.text);
    this.greetings.set(take.text, take);
    while (this.greetings.size > MAX_GREETINGS) {
      this.greetings.delete(this.greetings.keys().next().value!);
    }
  }
}
