/**
 * A live gpt-realtime session: one WebSocket per call that hears the caller,
 * holds the conversation, calls backend tools, and speaks.
 *
 * The model runs the conversation itself: server voice activity detection ends
 * the caller's turn and starts a response automatically, and the model replies
 * in audio, calling tools when it needs the backend. This class only moves
 * events. It decides nothing about the call — the gateway executes tools, and
 * tracks what was actually played to the caller.
 *
 * Audio is G.711 μ-law both ways, matching Twilio, so nothing is resampled.
 */

import WebSocket from 'ws';

import { REALTIME_TOOLS } from './realtime-tools';

export interface RealtimeToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface RealtimeResponseSummary {
  id: string;
  status: 'completed' | 'cancelled' | 'failed' | 'incomplete' | string;
  toolCalls: RealtimeToolCall[];
}

export interface RealtimeConversationCallbacks {
  /** Caller voice activity began: barge-in. */
  onSpeechStarted: () => void;
  /** A caller turn ended and was added to the conversation; its text follows later. */
  onCallerTurn: (itemId: string) => void;
  /** The transcription of a caller turn, or null if it failed. */
  onCallerTranscript: (itemId: string, text: string | null) => void;
  /** A response started. `requested` is false when voice activity started it. */
  onResponseStarted: (responseId: string, requested: boolean) => void;
  /** μ-law audio of one assistant message. */
  onAudio: (itemId: string, chunk: Buffer) => void;
  /** The running transcript of one assistant message. */
  onSpokenText: (itemId: string, textSoFar: string) => void;
  onResponseDone: (response: RealtimeResponseSummary) => void;
  /** Token usage reported for one response or one caller transcription. */
  onUsage?: (usage: { kind: 'response' | 'transcription'; usage: unknown }) => void;
  onError: (error: Error) => void;
  onClose?: () => void;
}

export interface RealtimeConversationOptions {
  apiKey: string;
  model: string;
  voice: string;
  /** Caller silence that ends their turn. */
  silenceMs: number;
  /** Model used to transcribe the caller for the call record. */
  transcriptionModel: string;
  instructions: string;
  callbacks: RealtimeConversationCallbacks;
}

export interface ResponseRequest {
  /** Replaces the session instructions for this one response. */
  instructions?: string;
  /** `none` for lines that must be spoken without tool use. */
  toolChoice?: 'auto' | 'none';
}

/** One live session. An interface so the call gateway can be tested with a fake. */
export interface RealtimeConversation {
  appendAudio(chunk: Buffer): void;
  /** Asks for a response now, or as soon as the one in progress finishes. */
  requestResponse(request?: ResponseRequest): void;
  /** Returns tool results to the model and lets it continue, after an optional note. */
  submitToolResults(results: Array<{ callId: string; output: unknown }>, note?: string): void;
  /** Adds a system note to the conversation: the backend's state and required action. */
  addNote(text: string): void;
  /** Stops the response in progress, if any. */
  cancelResponse(): void;
  /** Tells the model how much of an assistant message the caller actually heard. */
  truncate(itemId: string, audioEndMs: number): void;
  close(): void;
}

export type RealtimeConversationFactory = (
  options: Pick<RealtimeConversationOptions, 'instructions' | 'callbacks'>,
) => RealtimeConversation;

export const REALTIME_CONVERSATION_FACTORY = Symbol('REALTIME_CONVERSATION_FACTORY');

interface ServerEvent {
  type?: string;
  event_id?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  usage?: unknown;
  response?: {
    usage?: unknown;
    id?: string;
    status?: string;
    metadata?: Record<string, string> | null;
    output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>;
  };
  error?: { message?: string; code?: string; event_id?: string };
}

export class OpenAiRealtimeConversation implements RealtimeConversation {
  private readonly socket: WebSocket;
  private readonly outbox: string[] = [];
  private readonly spoken = new Map<string, string>();
  private ready = false;
  private closed = false;
  private sequence = 0;

  private activeResponseId: string | null = null;
  /** A response.create sent and not yet acknowledged. */
  private awaitingRequest: string | null = null;
  private awaitingPayload: ResponseRequest | null = null;
  /** The latest request that could not be sent while a response was active. */
  private queued: ResponseRequest | null = null;

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
            instructions: options.instructions,
            output_modalities: ['audio'],
            audio: {
              input: {
                format: { type: 'audio/pcmu' },
                transcription: { model: options.transcriptionModel, language: 'en' },
                turn_detection: {
                  type: 'server_vad',
                  // The gateway starts each reply itself, right after pinning the
                  // backend's required action, so the model never replies blind.
                  create_response: false,
                  interrupt_response: true,
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: options.silenceMs,
                },
              },
              output: { format: { type: 'audio/pcmu' }, voice: options.voice },
            },
            tools: REALTIME_TOOLS,
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
        if (event.item_id) callbacks.onCallerTurn(event.item_id);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.item_id) callbacks.onCallerTranscript(event.item_id, event.transcript?.trim() || null);
        if (event.usage) callbacks.onUsage?.({ kind: 'transcription', usage: event.usage });
        break;

      case 'conversation.item.input_audio_transcription.failed':
        if (event.item_id) callbacks.onCallerTranscript(event.item_id, null);
        break;

      case 'response.created': {
        const id = event.response?.id;
        if (!id) break;
        this.activeResponseId = id;
        const requested =
          this.awaitingRequest !== null && event.response?.metadata?.request === this.awaitingRequest;
        if (requested) {
          this.awaitingRequest = null;
        } else if (this.queued) {
          // The caller spoke and the model is already answering, with the latest
          // tool results in context. A queued follow-up would talk over it.
          this.queued = null;
        }
        callbacks.onResponseStarted(id, requested);
        break;
      }

      case 'response.output_audio.delta':
        if (event.item_id && event.delta) callbacks.onAudio(event.item_id, Buffer.from(event.delta, 'base64'));
        break;

      case 'response.output_audio_transcript.delta':
        if (event.item_id && event.delta) {
          const text = (this.spoken.get(event.item_id) ?? '') + event.delta;
          this.spoken.set(event.item_id, text);
          callbacks.onSpokenText(event.item_id, text);
        }
        break;

      case 'response.done': {
        const response = event.response;
        if (response?.id === this.activeResponseId) this.activeResponseId = null;
        if (response?.usage) callbacks.onUsage?.({ kind: 'response', usage: response.usage });
        callbacks.onResponseDone({
          id: response?.id ?? '',
          status: response?.status ?? 'completed',
          toolCalls: (response?.output ?? [])
            .filter((item) => item.type === 'function_call' && item.call_id && item.name)
            .map((item) => ({ callId: item.call_id!, name: item.name!, arguments: item.arguments ?? '' })),
        });
        this.flushQueued();
        break;
      }

      case 'error': {
        const code = event.error?.code;
        if (code === 'conversation_already_has_active_response' && event.error?.event_id === this.awaitingRequest) {
          // Lost a race with voice activity. Try again when that response ends,
          // unless it makes this one unnecessary (see response.created).
          this.awaitingRequest = null;
          this.queued = this.awaitingPayload;
          this.flushQueued();
          break;
        }
        if (code === 'response_cancel_not_active') break;
        callbacks.onError(
          new Error(`OpenAI realtime: ${event.error?.message ?? 'unknown error'}${code ? ` (${code})` : ''}`),
        );
        break;
      }

      default:
        break;
    }
  }

  /** Queues until the session is configured: earlier messages would use defaults. */
  private send(message: Record<string, unknown>): void {
    if (this.closed) return;
    const serialised = JSON.stringify(message);
    if (this.ready && this.socket.readyState === WebSocket.OPEN) this.socket.send(serialised);
    else this.outbox.push(serialised);
  }

  private flushQueued(): void {
    if (!this.queued || this.activeResponseId || this.awaitingRequest) return;
    const request = this.queued;
    this.queued = null;
    this.sendRequest(request);
  }

  private sendRequest(request: ResponseRequest): void {
    const id = `req-${++this.sequence}`;
    this.awaitingRequest = id;
    this.awaitingPayload = request;
    this.send({
      type: 'response.create',
      event_id: id,
      response: {
        metadata: { request: id },
        ...(request.instructions ? { instructions: request.instructions } : {}),
        ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      },
    });
  }

  appendAudio(chunk: Buffer): void {
    // Caller audio before configuration would be decoded with the wrong format.
    if (!this.ready || this.closed) return;
    this.send({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
  }

  requestResponse(request: ResponseRequest = {}): void {
    if (this.activeResponseId || this.awaitingRequest) {
      this.queued = request;
      return;
    }
    this.sendRequest(request);
  }

  submitToolResults(results: Array<{ callId: string; output: unknown }>, note?: string): void {
    for (const result of results) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: result.callId, output: JSON.stringify(result.output) },
      });
    }
    if (note) this.addNote(note);
    this.requestResponse();
  }

  addNote(text: string): void {
    // Appended, never inserted or edited, so earlier context stays cached.
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
  }

  cancelResponse(): void {
    this.queued = null;
    if (this.activeResponseId) this.send({ type: 'response.cancel', response_id: this.activeResponseId });
  }

  truncate(itemId: string, audioEndMs: number): void {
    this.send({
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.round(audioEndMs)),
    });
  }

  close(): void {
    this.closed = true;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}
