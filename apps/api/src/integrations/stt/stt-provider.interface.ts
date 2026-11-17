/**
 * Streaming speech recognition.
 *
 * Modelled as a long-lived session rather than a request/response call, because
 * the two signals that matter for a natural conversation only exist in a stream:
 * *when the caller started talking* (which is what triggers barge-in, and has to
 * arrive within a couple of hundred milliseconds) and *when they stopped*
 * (which is what ends the turn).
 */

export interface SttSessionCallbacks {
  /**
   * The caller has begun speaking. Fires before any words are recognised.
   * This is the barge-in trigger: if the receptionist is talking, it must stop.
   */
  onSpeechStarted?: () => void;
  /** A provisional transcript. Useful for interruption, not for extraction. */
  onInterimTranscript?: (text: string) => void;
  /**
   * A part of the utterance that will not change, reported while the
   * utterance may still be going on. From providers that settle a long
   * utterance in parts; a listener that wants every word as early as it is
   * known reads these instead of waiting for the final transcript.
   */
  onSettledSegment?: (text: string) => void;
  /** A settled transcript for one utterance. This drives a conversation turn. */
  onFinalTranscript: (text: string, confidence?: number) => void;
  /** The caller has stopped speaking long enough to treat the turn as over. */
  onUtteranceEnd?: () => void;
  onError: (error: Error) => void;
  onClose?: () => void;
}

export interface SttSession {
  /** Feed raw audio. Encoding is fixed by the session's configuration. */
  write(chunk: Buffer): void;
  /** Signal end of input and let the provider flush any pending transcript. */
  finish(): Promise<void>;
  close(): void;
}

export interface SttSessionOptions {
  /** Telephony audio is 8 kHz mu-law; nothing else is used here today. */
  encoding: 'mulaw';
  sampleRate: 8000;
  language: string;
  /**
   * Words the caller is likely to say — service areas, landmarks, vehicle
   * makes, towing terms. Providers that support biasing use it; others ignore it.
   */
  vocabularyHint?: string;
  callbacks: SttSessionCallbacks;
}

export interface SttProvider {
  readonly name: string;
  open(options: SttSessionOptions): Promise<SttSession>;
}

export const STT_PROVIDER = Symbol('STT_PROVIDER');
