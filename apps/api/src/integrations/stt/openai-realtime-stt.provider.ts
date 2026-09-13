/**
 * OpenAI live transcription (gpt-4o-mini-transcribe) over the Realtime API.
 *
 * Twilio's 8 kHz μ-law frames are forwarded untouched: the Realtime API accepts
 * G.711 μ-law ("audio/pcmu") natively, so there is no conversion on the
 * listening side at all.
 *
 * OpenAI's voice-activity detection supplies the two signals a natural call
 * needs: `speech_started` the moment the caller begins talking (barge-in), and
 * a completed transcript shortly after they stop (the turn).
 *
 * Protocol shapes are taken from the openai-node SDK types:
 *   wss://api.openai.com/v1/realtime?intent=transcription
 *   session.update { session: { type: 'transcription', audio: { input: … } } }
 *   input_audio_buffer.append / .speech_started
 *   conversation.item.input_audio_transcription.delta / .completed
 */

import { Logger } from '@nestjs/common';
import WebSocket from 'ws';

import type {
  SttProvider,
  SttSession,
  SttSessionOptions,
} from './stt-provider.interface';

export interface OpenAiSttOptions {
  apiKey: string;
  model: string;
  /**
   * Silence that ends a turn. Short feels responsive; too short splits a
   * sentence where the caller pauses to think ("I'm at… Liberty Market").
   */
  silenceMs?: number;
}

/** If the session acknowledgement never arrives, start streaming anyway. */
const CONFIGURE_TIMEOUT_MS = 2_000;
/** Roughly 10 seconds of 20ms frames. */
const MAX_QUEUED_FRAMES = 500;

interface RealtimeEvent {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string; code?: string };
}

class OpenAiRealtimeSttSession implements SttSession {
  private readonly logger = new Logger('OpenAiStt');
  private readonly queue: string[] = [];
  private readonly partial = new Map<string, string>();
  private ready = false;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly options: SttSessionOptions,
    config: OpenAiSttOptions,
  ) {
    const callbacks = options.callbacks;

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcmu' },
                transcription: {
                  model: config.model,
                  language: options.language.slice(0, 2),
                  // Domain vocabulary: the difference between "towed" and "told".
                  ...(options.vocabularyHint ? { prompt: options.vocabularyHint } : {}),
                },
                noise_reduction: { type: 'near_field' },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: config.silenceMs ?? 600,
                },
              },
            },
          },
        }),
      );
      setTimeout(() => this.startStreaming(), CONFIGURE_TIMEOUT_MS).unref?.();
    });

    socket.on('message', (raw) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(raw.toString()) as RealtimeEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case 'session.updated':
        case 'session.created':
        case 'transcription_session.updated':
          if (event.type !== 'session.created') this.startStreaming();
          break;

        case 'input_audio_buffer.speech_started':
          callbacks.onSpeechStarted?.();
          break;

        case 'conversation.item.input_audio_transcription.delta': {
          const id = event.item_id ?? '';
          const text = (this.partial.get(id) ?? '') + (event.delta ?? '');
          this.partial.set(id, text);
          callbacks.onInterimTranscript?.(text);
          break;
        }

        case 'conversation.item.input_audio_transcription.completed': {
          this.partial.delete(event.item_id ?? '');
          const text = event.transcript?.trim();
          if (text) callbacks.onFinalTranscript(text);
          break;
        }

        case 'error':
          callbacks.onError(
            new Error(
              `OpenAI realtime error${event.error?.code ? ` (${event.error.code})` : ''}: ${
                event.error?.message ?? 'unknown'
              }`,
            ),
          );
          break;

        default:
          break;
      }
    });

    socket.on('error', (error) => {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    });

    socket.on('unexpected-response', (_request, response) => {
      callbacks.onError(
        new Error(`OpenAI realtime connection rejected: HTTP ${response.statusCode}`),
      );
    });

    socket.on('close', () => {
      this.closed = true;
      callbacks.onClose?.();
    });
  }

  /**
   * Audio sent before the session is configured would be read as the default
   * format and transcribed as noise, so it is held until OpenAI confirms.
   */
  private startStreaming(): void {
    if (this.ready || this.closed) return;
    this.ready = true;
    for (const payload of this.queue) this.sendAppend(payload);
    this.queue.length = 0;
  }

  private sendAppend(payload: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
    }
  }

  write(chunk: Buffer): void {
    if (this.closed) return;
    const payload = chunk.toString('base64');
    if (this.ready) {
      this.sendAppend(payload);
    } else if (this.queue.length < MAX_QUEUED_FRAMES) {
      this.queue.push(payload);
    }
  }

  async finish(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
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

export class OpenAiRealtimeSttProvider implements SttProvider {
  readonly name = 'openai';

  constructor(private readonly options: OpenAiSttOptions) {}

  async open(sessionOptions: SttSessionOptions): Promise<SttSession> {
    // Deliberately not OPENAI_BASE_URL, which may point at a text-only gateway.
    const socket = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
    return new OpenAiRealtimeSttSession(socket, sessionOptions, this.options);
  }
}
