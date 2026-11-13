/**
 * Short lines in the receptionist's own voice, ready to play the instant a
 * reply is slow: "Mm-hm.", "One moment."
 *
 * A reply takes a second or more when the model saves a detail before
 * answering (two model round trips), and longer when OpenAI is throttling.
 * A person on the phone fills that with a sound; silence reads as a dropped
 * call. The lines are synthesised once, at start-up, by a realtime session
 * that exists only for this, so they match the voice of every call exactly.
 * If that fails, calls simply run without fillers.
 *
 * The way a line is recorded (`recordLines`) is shared with the greeting
 * bank, which records each business's greeting the same way.
 */

import { Injectable, Logger } from '@nestjs/common';

import type { RealtimeConversationFactory } from './openai-realtime-conversation';

/**
 * `turn`: a sound of listening, right after any caller turn, before the reply
 * is known. Short, so it never clashes with how the reply itself begins.
 * `question`: the caller asked something; a sound of thinking, not of
 * agreeing ("Mm-hm." after a question reads as a brush-off).
 * `detail`: the caller gave a detail; a sound of having got it.
 * `stall`: the reply is long overdue; the caller is told they are not alone.
 */
export type FillerKind = 'turn' | 'question' | 'detail' | 'stall';

export const FILLER_LINES: Record<FillerKind, readonly string[]> = {
  // Several of each: with two lines and one lost at warm-up, a caller heard
  // "Mm-hm." five times in one call.
  turn: ['Mm-hm.', 'Okay.', 'Right.', 'Uh-huh.'],
  question: ['Let me see.', 'Hmm.', 'Good question.'],
  detail: ['Okay.', 'Got it.', 'Alright.'],
  stall: ['One moment.', 'Just a moment.', 'Bear with me.'],
};

/**
 * Every filler line once, in the order the warm-up records them. "Okay." is a
 * `turn` and a `detail` line and is recorded once. The stall lines come
 * straight after the turn lines: a reply long overdue is when a filler matters
 * most, and if the warm-up is cut short the lines lost are the ones whose kind
 * another can stand in for.
 */
export const ALL_FILLER_LINES: readonly string[] = [
  ...new Set([...FILLER_LINES.turn, ...FILLER_LINES.stall, ...FILLER_LINES.question, ...FILLER_LINES.detail]),
];

export interface Filler {
  text: string;
  /** μ-law audio, as the gateway sends it to Twilio. */
  audio: Buffer;
}

/** Fillers for one call: its own rotation, so what one call heard last does not decide what the next hears. */
export interface FillerPicker {
  /** The next filler of that kind for this call, or null when none is ready. */
  next(kind?: FillerKind): Filler | null;
}

/** A live warm-up recorded seven lines in 10 s; the twelve now should take about 17 s. */
const WARM_UP_LIMIT_MS = 45_000;
/** A filler longer than this is the model adding words of its own, not the line. */
const MAX_FILLER_MS = 2_500;
/**
 * A take shorter than this is not a line. On a real call "Mm-hm." played as
 * 50 ms of audio: its transcript matched, so it was kept, and the caller
 * heard a click where the sound of listening should have been.
 */
const MIN_TAKE_MS = 150;
/**
 * Tries per line. Asked for "Mm-hm." the model says "Sure, please tell me
 * what kind of issue you're experiencing" about half the time; asked again
 * it usually says the line. Each take is made out of band, so a bad one is
 * not the context of the next: in one warm-up "Okay." drifted into a whole
 * made-up call over three tries.
 */
const ATTEMPTS_PER_LINE = 4;

/**
 * Comparable form of a line: case, punctuation, spacing and doubled letters
 * ignored, so "Mm-hmm." is heard as "Mm-hm.".
 */
export const comparable = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/(\p{L})\1+/gu, '$1')
    .trim();

export interface RecordLinesOptions {
  /** Names the recording session in the logs. */
  label: string;
  /** The recording session's instructions: what the lines are for, and to say each one and nothing else. */
  instructions: string;
  logger: Pick<Logger, 'log' | 'warn'>;
  /** Gives up on the lines not yet recorded after this long. */
  maxMs: number;
  /** What a line is called in the logs. */
  noun?: string;
  /** Logged when lines are missing: what calls do without them. */
  withoutThem?: string;
  /** The longest take kept for a line; longer is the model adding words of its own. */
  maxTakeMs?: (line: string) => number;
  /** Whether the words of a take are the line. Default: the same comparable form. */
  isLine?: (said: string, line: string) => boolean;
  /** Each line as soon as a take of it is kept, so the first can be used before the last is recorded. */
  onLine?: (take: Filler) => void;
}

/**
 * Records each line through one short-lived session, in the call voice, and
 * resolves with the takes kept, by line, when done or given up. Never
 * rejects: a line not recorded is simply missing from the result.
 */
export function recordLines(
  createConversation: RealtimeConversationFactory,
  lines: readonly string[],
  options: RecordLinesOptions,
): Promise<Map<string, Filler>> {
  const takes = new Map<string, Filler>();
  if (lines.length === 0) return Promise.resolve(takes);
  const started = Date.now();
  const noun = options.noun ?? 'Filler';
  const maxTakeMs = options.maxTakeMs ?? (() => MAX_FILLER_MS);
  const isLine = options.isLine ?? ((said: string, line: string) => comparable(said) === comparable(line));

  return new Promise<Map<string, Filler>>((resolve) => {
    let index = 0;
    const chunks = new Map<string, Buffer[]>();
    const spoken = new Map<string, string>();
    let currentItems: string[] = [];
    let finished = false;
    let conversation: ReturnType<RealtimeConversationFactory> | null = null;

    const finish = (why: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(limit);
      if (why) options.logger.warn(`${noun} lines not ready: ${why}. ${options.withoutThem ?? 'Calls will run without them.'}`);
      conversation?.close();
      resolve(takes);
    };
    const limit = setTimeout(() => finish(`took longer than ${Math.round(options.maxMs / 1000)}s`), options.maxMs);

    let attempt = 0;
    const request = () => {
      currentItems = [];
      attempt += 1;
      conversation?.requestResponse({
        instructions: `Say exactly this and nothing else: "${lines[index]}"`,
        toolChoice: 'none',
        reason: noun.toLowerCase(),
        outOfBand: true,
      });
    };

    try {
      conversation = createConversation({
        label: options.label,
        instructions: options.instructions,
        callbacks: {
          onSpeechStarted: () => {},
          onCallerTurn: () => {},
          onCallerTranscript: () => {},
          onResponseStarted: () => {},
          onSpokenText: (itemId, text) => spoken.set(itemId, text),
          onAudio: (itemId, chunk) => {
            if (!chunks.has(itemId)) {
              chunks.set(itemId, []);
              currentItems.push(itemId);
            }
            chunks.get(itemId)!.push(chunk);
          },
          onResponseDone: (response) => {
            // A take that lands after the limit is not kept: the result has
            // already been handed over.
            if (finished) return;
            const line = lines[index]!;
            const audio = Buffer.concat(currentItems.flatMap((id) => chunks.get(id) ?? []));
            const said = currentItems.map((id) => spoken.get(id) ?? '').join(' ');
            const ms = audio.length / 8;
            // The model sometimes adds words of its own; a filler that is not the
            // line, or runs long, is worse than silence. A clip with no transcript
            // cannot be shown to be the line, so it is not kept either: it would be
            // played to callers and written to the transcript as the line.
            const unverified = !said.trim() || !isLine(said, line);
            if (response.status !== 'completed' || audio.length === 0 || ms < MIN_TAKE_MS || ms > maxTakeMs(line) || unverified) {
              options.logger.warn(`${noun} "${line}" rejected: model said "${said || '?'}" in ${Math.round(ms)}ms (attempt ${attempt})`);
              if (attempt < ATTEMPTS_PER_LINE) {
                request();
                return;
              }
            } else {
              const take = { text: line, audio };
              takes.set(line, take);
              options.onLine?.(take);
            }
            index += 1;
            attempt = 0;
            if (index >= lines.length) {
              options.logger.log(`${takes.size} ${noun.toLowerCase()} lines ready in ${Math.round((Date.now() - started) / 1000)}s`);
              finish(null);
            } else {
              request();
            }
          },
          onError: (error) => finish(error.message),
          onClose: () => finish(finished ? null : 'session closed early'),
        },
      });
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
    }
    // A session that failed while opening has already been given up on.
    if (!finished) request();
  });
}

/**
 * Cursors over the bank's lines, one per kind. The filler just played is
 * skipped when there is another: "Okay." is both a `turn` and a `detail`
 * line, and each kind keeps its own cursor.
 */
class FillerRotation implements FillerPicker {
  private readonly cursors: Record<FillerKind, number>;
  private last: Filler | null = null;

  constructor(
    private readonly pool: (kind: FillerKind) => readonly Filler[],
    start: number,
  ) {
    this.cursors = { turn: start, question: start, detail: start, stall: start };
  }

  next(kind: FillerKind = 'turn'): Filler | null {
    const pool = this.pool(kind);
    if (pool.length === 0) return null;
    let filler = pool[this.cursors[kind]++ % pool.length]!;
    if (filler === this.last && pool.length > 1) filler = pool[this.cursors[kind]++ % pool.length]!;
    this.last = filler;
    return filler;
  }
}

@Injectable()
export class RealtimeFillerBank {
  private readonly logger = new Logger('RealtimeFillers');
  private readonly fillers: Filler[] = [];
  /** The process-wide rotation behind `next`, for callers without a picker of their own. */
  private readonly shared = new FillerRotation((kind) => this.pool(kind), 0);
  private calls = 0;

  constructor(private readonly createConversation: RealtimeConversationFactory) {}

  get size(): number {
    return this.fillers.length;
  }

  /**
   * The next filler of that kind, rotating so a caller does not hear the same
   * one twice running. A kind with no line of its own ready falls back to
   * whatever is: a sound of any kind beats silence.
   *
   * One rotation for the whole process: a call takes up where the last one
   * left off. A call should use its own picker from `forCall`.
   */
  next(kind: FillerKind = 'turn'): Filler | null {
    return this.shared.next(kind);
  }

  /**
   * A rotation of its own for one call. Each call starts one line further on
   * than the call before, so two calls in a row do not both open with
   * "Mm-hm.". Lines recorded after the call started are used as they arrive.
   */
  forCall(): FillerPicker {
    const start = this.calls;
    this.calls += 1;
    return new FillerRotation((kind) => this.pool(kind), start);
  }

  /** Synthesises every line through one short-lived session. Resolves when done or given up. */
  async warmUp(lines: readonly string[] = ALL_FILLER_LINES): Promise<void> {
    const todo = [...new Set(lines)].filter((line) => !this.fillers.some((filler) => filler.text === line));
    await recordLines(this.createConversation, todo, {
      label: 'filler-warm-up',
      instructions:
        'You are recording short sounds for a telephone receptionist. Each request names one line. ' +
        'Say that line and nothing else: no greeting, no question, no offer of help, no extra words.',
      logger: this.logger,
      maxMs: WARM_UP_LIMIT_MS,
      noun: 'Filler',
      withoutThem: 'Calls will run without them.',
      // Kept as each one is made, so a call that starts mid warm-up has them.
      onLine: (take) => this.fillers.push(take),
    });
  }

  /** The recorded lines of that kind, in the kind's order; all of them when none of its own is ready. */
  private pool(kind: FillerKind): readonly Filler[] {
    const ofKind = FILLER_LINES[kind].flatMap((line) => this.fillers.find((filler) => filler.text === line) ?? []);
    return ofKind.length > 0 ? ofKind : this.fillers;
  }
}
