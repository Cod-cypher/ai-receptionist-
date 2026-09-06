/**
 * Deepgram streaming speech recognition.
 *
 * Talks to Deepgram's WebSocket API directly rather than through their SDK. The
 * protocol is a handful of JSON messages, and a raw socket keeps the audio path
 * — which is the latency-critical part of a call — free of an abstraction whose
 * buffering behaviour we would not control.
 *
 * Mu-law is passed straight through: Twilio delivers 8 kHz mu-law and Deepgram
 * accepts it, so there is no transcoding step in either direction.
 */

import { Logger } from '@nestjs/common';
import WebSocket from 'ws';

import type {
  SttProvider,
  SttSession,
  SttSessionOptions,
} from './stt-provider.interface';

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
}

/**
 * How long Deepgram waits after speech stops before finalising an utterance.
 * Short enough that the caller is not left hanging, long enough that a pause
 * mid-sentence ("I'm at… Liberty Market") is not cut in two.
 */
const ENDPOINTING_MS = 400;

interface DeepgramTranscriptMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
  };
}

class DeepgramSession implements SttSession {
  private readonly logger = new Logger('Deepgram');
  /** Audio that arrived before the socket finished opening. */
  private readonly pending: Buffer[] = [];
  private open = false;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly options: SttSessionOptions,
  ) {
    socket.on('open', () => {
      this.open = true;
      for (const chunk of this.pending) socket.send(chunk);
      this.pending.length = 0;
    });

    socket.on('message', (raw) => this.handleMessage(raw));

    socket.on('error', (error) => {
      this.options.callbacks.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });

    socket.on('close', () => {
      this.closed = true;
      this.options.callbacks.onClose?.();
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let message: DeepgramTranscriptMessage;
    try {
      message = JSON.parse(raw.toString()) as DeepgramTranscriptMessage;
    } catch {
      return;
    }

    // Fires as soon as voice is detected, before any words exist. This is the
    // signal barge-in depends on.
    if (message.type === 'SpeechStarted') {
      this.options.callbacks.onSpeechStarted?.();
      return;
    }

    if (message.type === 'UtteranceEnd') {
      this.options.callbacks.onUtteranceEnd?.();
      return;
    }

    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    if (!text) return;

    // `speech_final` means Deepgram believes the caller has finished, which is
    // stronger than `is_final` (that only means this segment will not change).
    if (message.speech_final) {
      this.options.callbacks.onFinalTranscript(text, alternative?.confidence);
    } else if (!message.is_final) {
      this.options.callbacks.onInterimTranscript?.(text);
    }
  }

  write(chunk: Buffer): void {
    if (this.closed) return;
    if (!this.open) {
      // Bounded: a socket that never opens must not grow this without limit.
      if (this.pending.length < 200) this.pending.push(chunk);
      return;
    }
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(chunk);
  }

  async finish(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      // Asks Deepgram to flush rather than dropping a half-recognised utterance.
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
  }

  close(): void {
    this.closed = true;
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }
}

export class DeepgramSttProvider implements SttProvider {
  readonly name = 'deepgram';

  constructor(private readonly options: DeepgramOptions) {}

  async open(sessionOptions: SttSessionOptions): Promise<SttSession> {
    const params = new URLSearchParams({
      model: this.options.model ?? 'nova-3',
      encoding: sessionOptions.encoding,
      sample_rate: String(sessionOptions.sampleRate),
      channels: '1',
      language: sessionOptions.language,
      // Punctuation and smart formatting make the transcript readable in the
      // dashboard and give the extraction model cleaner input.
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      vad_events: 'true',
      endpointing: String(ENDPOINTING_MS),
    });

    const socket = new WebSocket(
      `wss://api.deepgram.com/v1/listen?${params.toString()}`,
      { headers: { Authorization: `Token ${this.options.apiKey}` } },
    );

    return new DeepgramSession(socket, sessionOptions);
  }
}
