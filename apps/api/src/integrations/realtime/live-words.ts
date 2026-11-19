/**
 * The caller's words while they are still speaking.
 *
 * The realtime session transcribes a caller's turn only once the turn has
 * ended, and the text lands 400 to 560 ms after that. The first reply to a
 * turn waits for it (AI_REALTIME_WORDS_WAIT_MS), so every reply started
 * about half a second later than it had to. A streaming transcriber fed the
 * same audio has the words as they are said: when the turn ends they are
 * already here, and the reply is asked for at once.
 *
 * These words steer the reply (the note quotes them, and they decide whether
 * the line is a question, a detail or a sound of thinking). The call's
 * transcript and the judge still read the realtime session's own
 * transcription, which arrives as before.
 *
 * Never in the way of a call: if the transcriber cannot be reached or fails
 * mid-call, there are simply no live words, and the reply waits as before.
 */

import { Logger } from '@nestjs/common';

import { DeepgramSttProvider } from '../stt/deepgram.provider';
import type { SttProvider, SttSession } from '../stt/stt-provider.interface';

/** The transcriber that listens beside the realtime session, when one is set up. */
export const REALTIME_LIVE_WORDS = Symbol('REALTIME_LIVE_WORDS');

export type LiveWordsSetting = 'off' | 'deepgram';

/** Audio that arrives before the transcriber's connection is open: 5 s of 20 ms frames. */
const EARLY_FRAMES = 250;

/**
 * The transcriber AI_REALTIME_LIVE_WORDS names, or null for none. Deepgram
 * only: it sends the words of a sentence while the sentence is still being
 * said, which a transcriber that works turn by turn cannot.
 */
export function createLiveWordsProvider(env: { setting?: string; deepgramApiKey?: string; deepgramModel?: string }): SttProvider | null {
  if (env.setting !== 'deepgram') return null;
  if (!env.deepgramApiKey) {
    new Logger('LiveWords').warn('AI_REALTIME_LIVE_WORDS=deepgram needs DEEPGRAM_API_KEY; replies will wait for the words as before.');
    return null;
  }
  return new DeepgramSttProvider({ apiKey: env.deepgramApiKey, model: env.deepgramModel });
}

interface Heard {
  text: string;
  at: number;
}

export interface LiveWordsOptions {
  /** The call, for the log. */
  label: string;
  /** New words have come in: a reply held for the caller's words may be able to go. */
  onWords: () => void;
}

export class LiveWords {
  private readonly logger = new Logger('LiveWords');
  private session: SttSession | null = null;
  private early: Buffer[] = [];
  private closed = false;
  private failed = false;
  /** Parts of what was said that will not change, oldest first. */
  private readonly settled: Heard[] = [];
  /** The part being said now, as far as it has been made out. */
  private interim: Heard | null = null;
  /** The transcriber reports each settled part itself; a whole utterance reported on top of them is not counted twice. */
  private inParts = false;

  constructor(
    provider: SttProvider,
    private readonly options: LiveWordsOptions,
  ) {
    provider
      .open({
        encoding: 'mulaw',
        sampleRate: 8000,
        language: 'en',
        callbacks: {
          onInterimTranscript: (text) => {
            this.interim = { text, at: Date.now() };
            this.options.onWords();
          },
          onSettledSegment: (text) => {
            this.inParts = true;
            this.settle(text);
          },
          onFinalTranscript: (text) => {
            if (!this.inParts) this.settle(text);
          },
          onError: (error) => this.fail(error.message),
          onClose: () => {
            if (!this.closed) this.fail('the connection closed');
          },
        },
      })
      .then((session) => {
        if (this.closed) {
          session.close();
          return;
        }
        this.session = session;
        for (const frame of this.early) session.write(frame);
        this.early = [];
      })
      .catch((error: unknown) => this.fail(error instanceof Error ? error.message : String(error)));
  }

  private settle(text: string): void {
    this.settled.push({ text, at: Date.now() });
    this.interim = null;
    this.options.onWords();
  }

  private fail(why: string): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.early = [];
    this.logger.warn(`Call ${this.options.label}: the live transcriber is not available (${why}); replies wait for the caller's words as before.`);
  }

  /** The transcriber is connected and hearing the call: what it has not made out was probably not said. */
  get listening(): boolean {
    return this.session !== null && !this.failed && !this.closed;
  }

  /** One frame of the caller's audio, as Twilio sent it. */
  write(frame: Buffer): void {
    if (this.closed || this.failed) return;
    if (this.session) this.session.write(frame);
    else if (this.early.length < EARLY_FRAMES) this.early.push(frame);
  }

  /**
   * What has been made out of the caller's speech since `since` (a time in
   * ms), the part still being said included. Empty when nothing has, or
   * when the transcriber is not available.
   */
  words(since: number): string {
    if (this.failed) return '';
    // Anything older was said before this turn's speech began (a noise that
    // never became a turn): it belongs to no turn, and is let go.
    while (this.settled.length > 0 && this.settled[0]!.at < since) this.settled.shift();
    const parts = this.settled.map((part) => part.text);
    if (this.interim && this.interim.at >= since) parts.push(this.interim.text);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /** The words so far have been used, or belong to no turn: the next turn starts from nothing. */
  clear(): void {
    this.settled.length = 0;
    this.interim = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.early = [];
    this.session?.close();
    this.session = null;
  }
}
