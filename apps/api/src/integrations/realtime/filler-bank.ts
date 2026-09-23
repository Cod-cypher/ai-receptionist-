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

/** Neutral: right after any caller turn, before the reply is known. */
export const FILLER_LINES = ['Mm-hm.', 'Okay.', 'One moment.', 'Let me just check that.'] as const;

export interface Filler {
  text: string;
  /** μ-law audio, as the gateway sends it to Twilio. */
  audio: Buffer;
}

const WARM_UP_LIMIT_MS = 20_000;
/** A filler longer than this is the model adding words of its own, not the line. */
const MAX_FILLER_MS = 2_500;

/** Comparable form of a line: case, punctuation and spacing ignored. */
const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

@Injectable()
export class RealtimeFillerBank {
  private readonly logger = new Logger('RealtimeFillers');
  private readonly fillers: Filler[] = [];
  private cursor = 0;

  constructor(private readonly createConversation: RealtimeConversationFactory) {}

  get size(): number {
    return this.fillers.length;
  }

  /** The next filler, rotating so a caller does not hear the same one twice running. */
  next(): Filler | null {
    if (this.fillers.length === 0) return null;
    const filler = this.fillers[this.cursor % this.fillers.length]!;
    this.cursor += 1;
    return filler;
  }

  /** Synthesises every line through one short-lived session. Resolves when done or given up. */
  async warmUp(lines: readonly string[] = FILLER_LINES): Promise<void> {
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

      const request = () => {
        currentItems = [];
        conversation?.requestResponse({
          instructions: `Say exactly this and nothing else: "${lines[index]}"`,
          toolChoice: 'none',
          reason: 'filler',
        });
      };

      conversation = this.createConversation({
        label: 'filler-warm-up',
        instructions: 'You are a telephone receptionist. Say exactly the line you are given, naturally, and nothing else.',
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
          onResponseDone: () => {
            const line = lines[index]!;
            const audio = Buffer.concat(currentItems.flatMap((id) => chunks.get(id) ?? []));
            const said = currentItems.map((id) => spoken.get(id) ?? '').join(' ');
            const ms = audio.length / 8;
            // The model sometimes adds words of its own; a filler that is not the
            // line, or runs long, is worse than silence.
            if (audio.length === 0 || ms > MAX_FILLER_MS || (said && comparable(said) !== comparable(line))) {
              this.logger.warn(`Filler "${line}" rejected: model said "${said || '?'}" in ${Math.round(ms)}ms`);
            } else {
              this.fillers.push({ text: line, audio });
            }
            index += 1;
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
