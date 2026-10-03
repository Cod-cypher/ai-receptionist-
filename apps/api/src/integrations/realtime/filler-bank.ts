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
 */

import { Injectable, Logger } from '@nestjs/common';

import type { RealtimeConversationFactory } from './openai-realtime-conversation';

/**
 * `turn`: a sound of listening, right after any caller turn, before the reply
 * is known. Short, so it never clashes with how the reply itself begins.
 * `stall`: the reply is long overdue; the caller is told they are not alone.
 */
export type FillerKind = 'turn' | 'stall';

export const FILLER_LINES: Record<FillerKind, readonly string[]> = {
  // Several of each: with two lines and one lost at warm-up, a caller heard
  // "Mm-hm." five times in one call.
  turn: ['Mm-hm.', 'Okay.', 'Right.', 'Uh-huh.'],
  stall: ['One moment.', 'Just a moment.', 'Bear with me.'],
};

export interface Filler {
  text: string;
  /** μ-law audio, as the gateway sends it to Twilio. */
  audio: Buffer;
}

const WARM_UP_LIMIT_MS = 45_000;
/** A filler longer than this is the model adding words of its own, not the line. */
const MAX_FILLER_MS = 2_500;
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
const comparable = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/(\p{L})\1+/gu, '$1')
    .trim();

@Injectable()
export class RealtimeFillerBank {
  private readonly logger = new Logger('RealtimeFillers');
  private readonly fillers: Filler[] = [];
  private readonly cursors: Record<FillerKind, number> = { turn: 0, stall: 0 };

  constructor(private readonly createConversation: RealtimeConversationFactory) {}

  get size(): number {
    return this.fillers.length;
  }

  /**
   * The next filler of that kind, rotating so a caller does not hear the same
   * one twice running. A kind with no line of its own ready falls back to
   * whatever is: a sound of any kind beats silence.
   */
  next(kind: FillerKind = 'turn'): Filler | null {
    const lines = FILLER_LINES[kind];
    const ofKind = this.fillers.filter((filler) => lines.includes(filler.text));
    const pool = ofKind.length > 0 ? ofKind : this.fillers;
    if (pool.length === 0) return null;
    const filler = pool[this.cursors[kind] % pool.length]!;
    this.cursors[kind] += 1;
    return filler;
  }

  /** Synthesises every line through one short-lived session. Resolves when done or given up. */
  async warmUp(lines: readonly string[] = [...FILLER_LINES.turn, ...FILLER_LINES.stall]): Promise<void> {
    if (lines.length === 0) return;
    const started = Date.now();

    await new Promise<void>((resolve) => {
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
        if (why) this.logger.warn(`Filler lines not ready: ${why}. Calls will run without them.`);
        conversation?.close();
        resolve();
      };
      const limit = setTimeout(() => finish(`took longer than ${WARM_UP_LIMIT_MS / 1000}s`), WARM_UP_LIMIT_MS);

      let attempt = 0;
      const request = () => {
        currentItems = [];
        attempt += 1;
        conversation?.requestResponse({
          instructions: `Say exactly this and nothing else: "${lines[index]}"`,
          toolChoice: 'none',
          reason: 'filler',
          outOfBand: true,
        });
      };

      conversation = this.createConversation({
        label: 'filler-warm-up',
        instructions:
          'You are recording short sounds for a telephone receptionist. Each request names one line. ' +
          'Say that line and nothing else: no greeting, no question, no offer of help, no extra words.',
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
            const line = lines[index]!;
            const audio = Buffer.concat(currentItems.flatMap((id) => chunks.get(id) ?? []));
            const said = currentItems.map((id) => spoken.get(id) ?? '').join(' ');
            const ms = audio.length / 8;
            // The model sometimes adds words of its own; a filler that is not the
            // line, or runs long, is worse than silence. A clip with no transcript
            // cannot be shown to be the line, so it is not kept either: it would be
            // played to callers and written to the transcript as the line.
            const unverified = !said.trim() || comparable(said) !== comparable(line);
            if (response.status !== 'completed' || audio.length === 0 || ms > MAX_FILLER_MS || unverified) {
              this.logger.warn(`Filler "${line}" rejected: model said "${said || '?'}" in ${Math.round(ms)}ms (attempt ${attempt})`);
              if (attempt < ATTEMPTS_PER_LINE) {
                request();
                return;
              }
            } else {
              this.fillers.push({ text: line, audio });
            }
            index += 1;
            attempt = 0;
            if (index >= lines.length) {
              this.logger.log(`${this.fillers.length} filler lines ready in ${Math.round((Date.now() - started) / 1000)}s`);
              finish(null);
            } else {
              request();
            }
          },
          onError: (error) => finish(error.message),
          onClose: () => finish(finished ? null : 'session closed early'),
        },
      });
      request();
    });
  }
}
