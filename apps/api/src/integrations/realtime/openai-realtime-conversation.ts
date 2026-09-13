/**
 * A live gpt-realtime-mini session: one WebSocket that hears the caller,
 * understands them, and speaks.
 *
 * It is driven in two strictly separate kinds of response, a split taken from
 * live testing rather than documentation:
 *
 *  - **Extraction** — in the conversation, text-only, `tool_choice: 'required'`.
 *    The model hears the caller's audio and must answer with a
 *    `report_caller_turn` function call. (Forcing a *named* function silently
 *    produced plain text instead, once with an invented caller line.)
 *
 *  - **Speech** — out of band (`conversation: 'none'`), audio-only, no tools,
 *    given one line to say. When given a line in the conversation instead, the
 *    model ignored it and told the caller help was "on the way"; out of band it
 *    said the line word for word.
 *
 * Audio is G.711 μ-law in both directions, matching Twilio, so nothing is
 * resampled. Event names below were confirmed against the live API.
 */

import WebSocket from 'ws';

import { REPORT_CALLER_TURN_TOOL } from './realtime-extraction';

export interface RealtimeConversationCallbacks {
  /** Voice activity began — barge-in. */
  onSpeechStarted: () => void;
  /** The caller finished a turn and their audio is in the conversation. */
  onCallerTurn: () => void;
  /** μ-law audio for the line currently being spoken. */
  onAudio: (chunk: Buffer) => void;
  /** The running transcript of the line currently being spoken. */
  onSpokenText: (textSoFar: string) => void;
  onError: (error: Error) => void;
  onClose?: () => void;
}

export interface RealtimeConversationOptions {
  apiKey: string;
  model: string;
  voice: string;
  /** Caller silence that ends their turn. */
  silenceMs: number;
  callbacks: RealtimeConversationCallbacks;
}

export interface SpeakOutcome {
  status: 'completed' | 'cancelled' | 'failed' | 'incomplete';
  spoken: string;
}

/** One live session. An interface so the call gateway can be tested with a fake. */
export interface RealtimeConversation {
  appendAudio(chunk: Buffer): void;
  /** Resolves with the raw `report_caller_turn` arguments, or null. */
  extract(instructions: string): Promise<string | null>;
  speak(line: string, instructions: string): Promise<SpeakOutcome>;
  /** Stops the line currently being spoken. */
  cancelSpeech(): void;
  close(): void;
}

export type RealtimeConversationFactory = (
  options: Omit<RealtimeConversationOptions, 'apiKey' | 'model' | 'voice' | 'silenceMs'>,
) => RealtimeConversation;

export const REALTIME_CONVERSATION_FACTORY = Symbol('REALTIME_CONVERSATION_FACTORY');

const SESSION_INSTRUCTIONS =
  'You listen to callers phoning a towing company. After every caller turn, call ' +
  'report_caller_turn with what they said. Never speak to the caller unprompted.';

/** A response that never finishes must not hang the call. */
const RESPONSE_TIMEOUT_MS = 20_000;

interface Pending {
  kind: 'extract' | 'speak';
  responseId?: string;
  functionArguments: string | null;
  spoken: string;
  resolve: (value: { status: SpeakOutcome['status']; spoken: string; args: string | null }) => void;
  timer: NodeJS.Timeout;
}

interface ServerEvent {
  type?: string;
  delta?: string;
  response_id?: string;
  arguments?: string;
  call_id?: string;
  response?: {
    id?: string;
    status?: SpeakOutcome['status'];
    metadata?: Record<string, string> | null;
    output?: Array<{ type?: string; call_id?: string }>;
  };
  error?: { message?: string; code?: string; event_id?: string };
}

export class OpenAiRealtimeConversation implements RealtimeConversation {
  private readonly socket: WebSocket;
  private readonly outbox: string[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly byResponse = new Map<string, string>();
  private ready = false;
  private closed = false;
  private sequence = 0;
  private speakingRequest: string | null = null;
  /** False once any response had to be matched by order instead of metadata. */
  metadataMatched = true;

  constructor(private readonly options: RealtimeConversationOptions) {
    const { callbacks } = options;

    // Deliberately not OPENAI_BASE_URL, which may point at a text-only gateway.
    this.socket = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`,
      { headers: { Authorization: `Bearer ${options.apiKey}` } },
    );

    this.socket.on('open', () => {
      this.socket.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model: options.model,
            instructions: SESSION_INSTRUCTIONS,
            output_modalities: ['audio'],
            audio: {
              input: {
                format: { type: 'audio/pcmu' },
                turn_detection: {
                  type: 'server_vad',
                  // The workflow decides when and how to respond, not the model.
                  create_response: false,
                  interrupt_response: false,
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: options.silenceMs,
                },
              },
              output: { format: { type: 'audio/pcmu' }, voice: options.voice },
            },
            tools: [REPORT_CALLER_TURN_TOOL],
            tool_choice: 'auto',
          },
        }),
      );
    });

    this.socket.on('message', (raw) => this.handle(raw));
    this.socket.on('error', (error) => callbacks.onError(error));
    this.socket.on('unexpected-response', (_request, response) => {
      callbacks.onError(new Error(`OpenAI realtime connection rejected: HTTP ${response.statusCode}`));
    });
    this.socket.on('close', () => {
      this.closed = true;
      for (const id of [...this.pending.keys()]) this.settle(id, 'failed');
      callbacks.onClose?.();
    });
  }

  private handle(raw: WebSocket.RawData): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw.toString()) as ServerEvent;
    } catch {
      return;
    }
    const { callbacks } = this.options;

    switch (event.type) {
      case 'session.updated':
        if (!this.ready) {
          this.ready = true;
          for (const message of this.outbox) this.socket.send(message);
          this.outbox.length = 0;
        }
        break;

      case 'input_audio_buffer.speech_started':
        callbacks.onSpeechStarted();
        break;

      case 'input_audio_buffer.committed':
        callbacks.onCallerTurn();
        break;

      case 'response.created': {
        const responseId = event.response?.id;
        if (!responseId) break;
        // Matched by the metadata tag set on the request. If a model version
        // does not echo metadata, fall back to request order: responses are
        // created in the order they were requested.
        let requestId = event.response?.metadata?.request;
        if (!requestId || !this.pending.has(requestId)) {
          requestId = [...this.pending.entries()].find(([, p]) => !p.responseId)?.[0];
          this.metadataMatched = false;
        }
        if (requestId) {
          this.pending.get(requestId)!.responseId = responseId;
          this.byResponse.set(responseId, requestId);
        }
        break;
      }

      case 'response.output_audio.delta': {
        const request = this.requestFor(event.response_id);
        if (request?.kind === 'speak' && event.delta) {
          callbacks.onAudio(Buffer.from(event.delta, 'base64'));
        }
        break;
      }

      case 'response.output_audio_transcript.delta': {
        const request = this.requestFor(event.response_id);
        if (request?.kind === 'speak' && event.delta) {
          request.spoken += event.delta;
          callbacks.onSpokenText(request.spoken);
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        const request = this.requestFor(event.response_id);
        if (request) request.functionArguments = event.arguments ?? null;
        break;
      }

      case 'response.done': {
        const requestId = event.response?.id ? this.byResponse.get(event.response.id) : undefined;
        // A function call must be answered before the conversation moves on.
        for (const item of event.response?.output ?? []) {
          if (item.type === 'function_call' && item.call_id) {
            this.send({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: item.call_id, output: '{"recorded":true}' },
            });
          }
        }
        if (requestId) this.settle(requestId, event.response?.status ?? 'completed');
        break;
      }

      case 'error': {
        // A rejected response.create names the client event that caused it.
        const failed = event.error?.event_id;
        if (failed && this.pending.has(failed)) this.settle(failed, 'failed');
        callbacks.onError(
          new Error(`OpenAI realtime: ${event.error?.message ?? 'unknown error'}${event.error?.code ? ` (${event.error.code})` : ''}`),
        );
        break;
      }

      default:
        break;
    }
  }

  private requestFor(responseId: string | undefined): Pending | undefined {
    const id = responseId ? this.byResponse.get(responseId) : undefined;
    return id ? this.pending.get(id) : undefined;
  }

  private settle(requestId: string, status: SpeakOutcome['status']): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(requestId);
    if (request.responseId) this.byResponse.delete(request.responseId);
    if (this.speakingRequest === requestId) this.speakingRequest = null;
    request.resolve({ status, spoken: request.spoken, args: request.functionArguments });
  }

  /** Queues until the session is configured: earlier messages would use defaults. */
  private send(message: Record<string, unknown>): void {
    const serialised = JSON.stringify(message);
    if (this.closed) return;
    if (this.ready && this.socket.readyState === WebSocket.OPEN) this.socket.send(serialised);
    else this.outbox.push(serialised);
  }

  private request(
    kind: Pending['kind'],
    response: Record<string, unknown>,
  ): Promise<{ status: SpeakOutcome['status']; spoken: string; args: string | null }> {
    const requestId = `req-${++this.sequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, 'failed'), RESPONSE_TIMEOUT_MS);
      this.pending.set(requestId, { kind, functionArguments: null, spoken: '', resolve, timer });
      if (kind === 'speak') this.speakingRequest = requestId;
      this.send({
        type: 'response.create',
        event_id: requestId,
        response: { ...response, metadata: { request: requestId } },
      });
    });
  }

  appendAudio(chunk: Buffer): void {
    // Caller audio before configuration would be decoded with the wrong format.
    if (!this.ready || this.closed) return;
    this.send({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
  }

  async extract(instructions: string): Promise<string | null> {
    const result = await this.request('extract', {
      output_modalities: ['text'],
      tool_choice: 'required',
      instructions,
    });
    return result.status === 'completed' ? result.args : null;
  }

  async speak(line: string, instructions: string): Promise<SpeakOutcome> {
    const result = await this.request('speak', {
      conversation: 'none',
      output_modalities: ['audio'],
      tool_choice: 'none',
      instructions,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Line to speak: "${line}"` }] },
      ],
    });
    return { status: result.status, spoken: result.spoken };
  }

  cancelSpeech(): void {
    const requestId = this.speakingRequest;
    const responseId = requestId ? this.pending.get(requestId)?.responseId : undefined;
    if (!requestId) return;
    this.send(responseId ? { type: 'response.cancel', response_id: responseId } : { type: 'response.cancel' });
  }

  close(): void {
    this.closed = true;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}
