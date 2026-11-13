/**
 * A live gpt-realtime session: one WebSocket per call that hears the caller,
 * holds the conversation, calls backend tools, and speaks.
 *
 * The model runs the conversation itself: server voice activity detection
 * ends the caller's turn, and the model replies in audio, calling tools when
 * it needs the backend. This class only moves events. It decides nothing
 * about the call — the gateway starts every reply, decides whether caller
 * speech is an interruption, executes tools, and tracks what was actually
 * played to the caller.
 *
 * Audio is G.711 μ-law both ways, matching Twilio, so nothing is resampled.
 *
 * Every session logs one line when it closes: how long it lasted, how many
 * responses it asked OpenAI for and why, and the rate limits OpenAI reported.
 * That line is how to tell what a call — or a benchmark — cost in requests.
 */

import { Logger } from '@nestjs/common';
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
  /** Why a failed response failed, as OpenAI reported it: "rate_limit_exceeded: ...". */
  failure?: string;
}

export interface RealtimeConversationCallbacks {
  /** Caller voice activity began: possibly a barge-in. */
  onSpeechStarted: () => void;
  /** Caller voice activity ended; `durationMs` is how long it lasted. */
  onSpeechStopped?: (durationMs: number) => void;
  /** A caller turn ended and was added to the conversation; its text follows later. */
  onCallerTurn: (itemId: string) => void;
  /** The transcription of a caller turn, or null if it failed. */
  onCallerTranscript: (itemId: string, text: string | null) => void;
  /**
   * A response started. `requested` is false when the model started it on its
   * own. `reason` is the reason given with the request it answers: a reply
   * can start long after it was asked for, and the caller of this needs to
   * know which request has finally been answered.
   */
  onResponseStarted: (responseId: string, requested: boolean, reason?: string, tag?: string) => void;
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

export type TurnDetectionMode = 'server_vad' | 'semantic_vad';
export type TurnEagerness = 'low' | 'medium' | 'high' | 'auto';
export type NoiseReduction = 'near_field' | 'far_field' | 'off';

export interface RealtimeConversationOptions {
  apiKey: string;
  model: string;
  voice: string;
  /** Caller silence that ends their turn (server VAD only). */
  silenceMs: number;
  /**
   * `server_vad` ends the turn after `silenceMs` of quiet. `semantic_vad`
   * also judges from the words whether the caller has finished, so a pause
   * to think ("it's near... um") does not end their turn.
   */
  turnDetection?: TurnDetectionMode;
  /** How quickly semantic VAD ends a turn. */
  eagerness?: TurnEagerness;
  /** OpenAI's input noise reduction. Phones are near-field; `off` disables it. */
  noiseReduction?: NoiseReduction;
  /**
   * Playback speed of the receptionist's audio (`session.audio.output.speed`),
   * 0.25 to 1.5. Unset sends nothing and leaves OpenAI's default of 1. Set
   * from `AI_REALTIME_SPEED`, which is unset by default: a knob for later
   * tuning, not a fix. A value outside the range is clamped to it, because
   * OpenAI would refuse the whole session.update and the call would never start.
   */
  speed?: number;
  /** Model used to transcribe the caller for the call record. */
  transcriptionModel: string;
  /** Vocabulary for the transcriber: the business, its areas, common vehicles. */
  transcriptionPrompt?: string;
  instructions: string;
  callbacks: RealtimeConversationCallbacks;
  /** Names the call in the logs, so each session can be traced to the call that opened it. */
  label?: string;
}

export interface ResponseRequest {
  /** Replaces the session instructions for this one response. */
  instructions?: string;
  /** `none` for lines that must be spoken without tool use. */
  toolChoice?: 'auto' | 'none';
  /** Why the response is wanted. Never sent to OpenAI; counted in the session's log line. */
  reason?: string;
  /**
   * The caller's own label for this request, handed back when its response
   * starts, so a reply asked for under a plan that has since changed can be
   * recognised and dropped. Never sent to OpenAI.
   */
  tag?: string;
  /**
   * Not added to the conversation, and not seen by the next response: for
   * lines recorded one by one, where a bad take must not become the context
   * the next one is made in.
   */
  outOfBand?: boolean;
}

/** The `response.create` event for a request; `metadata.request` comes back on the response it creates. */
export function responseCreateEvent(id: string, request: ResponseRequest): Record<string, unknown> {
  return {
    type: 'response.create',
    event_id: id,
    response: {
      metadata: { request: id },
      ...(request.instructions ? { instructions: request.instructions } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(request.outOfBand ? { conversation: 'none' } : {}),
    },
  };
}

/** One live session. An interface so the call gateway can be tested with a fake. */
export interface RealtimeConversation {
  appendAudio(chunk: Buffer): void;
  /** Asks for a response now, or as soon as the one in progress finishes. */
  requestResponse(request?: ResponseRequest): void;
  /**
   * Returns tool results to the model and lets it continue, after an optional
   * note, with optional one-off instructions. `null`: the results only, with
   * no reply asked for, because the reply that answers them has been asked
   * for already (the goodbye, when the call has ended).
   */
  submitToolResults(results: Array<{ callId: string; output: unknown }>, note?: string, request?: ResponseRequest | null): void;
  /**
   * Adds a system note to the conversation. A `pinned` note is the backend's
   * state and required action: there is one at a time, and adding the next
   * removes the last, so a long call does not carry every state it has been in.
   */
  addNote(text: string, options?: { pinned?: boolean }): void;
  /**
   * Adds a message the assistant is to be taken as having said already (a
   * greeting played from a recording), so the model carries on from it.
   * Optional: a conversation without it is told the same in a note.
   */
  addAssistantMessage?(text: string): void;
  /**
   * Stops the response in progress, if any, and drops the request waiting
   * behind it. `keepQueued` keeps that request: for stopping a reply that is
   * out of date without losing the one that replaces it.
   */
  cancelResponse(options?: { keepQueued?: boolean }): void;
  /** Tells the model how much of an assistant message the caller actually heard. */
  truncate(itemId: string, audioEndMs: number): void;
  close(): void;
}

export type RealtimeConversationFactory = (
  options: Pick<RealtimeConversationOptions, 'instructions' | 'callbacks' | 'label' | 'transcriptionPrompt'>,
) => RealtimeConversation;

export const REALTIME_CONVERSATION_FACTORY = Symbol('REALTIME_CONVERSATION_FACTORY');

/** Everything this process has asked of the realtime API, across all sessions. */
const processTotals = { sessions: 0, responsesRequested: 0, responsesCreated: 0 };

/** Longest wait for OpenAI to accept the connection, and then to confirm the session's settings. */
const CONNECT_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 8_000;

/**
 * Caller audio held from before the session is configured: 3 s of 8 kHz
 * μ-law, one byte a sample. The session takes 1.5 to 2.5 s to be ready on a
 * real call, so 3 s covers it with room to spare.
 */
const EARLY_AUDIO_MAX_BYTES = 24_000;

/** OpenAI's range for `session.audio.output.speed`. */
const MIN_SPEED = 0.25;
const MAX_SPEED = 1.5;

/** A copy of the process-wide totals, for scripts that report what a run cost. */
export const realtimeTotals = () => ({ ...processTotals });

interface RateLimit {
  name?: string;
  limit?: number;
  remaining?: number;
  reset_seconds?: number;
}

interface ServerEvent {
  type?: string;
  event_id?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  usage?: unknown;
  audio_start_ms?: number;
  audio_end_ms?: number;
  response?: {
    usage?: unknown;
    id?: string;
    status?: string;
    status_details?: { type?: string; reason?: string; error?: { type?: string; code?: string; message?: string } | null } | null;
    metadata?: Record<string, string> | null;
    output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>;
  };
  rate_limits?: RateLimit[];
  error?: { message?: string; code?: string; event_id?: string };
}

/**
 * The events that add a note, replacing the pinned note before it if there is
 * one. Every reply re-reads the whole conversation, and OpenAI's rate limit
 * counts all of it: on a real 3.5-minute call, thirty state notes that were
 * each out of date one turn later helped push the call past 40,000 tokens a
 * minute, and replies began taking 16 s to start. Only the note just before
 * the newest turn is removed, so everything earlier stays cached.
 */
export function noteEvents(text: string, id: string, replaces: string | null): Array<Record<string, unknown>> {
  return [
    ...(replaces ? [{ type: 'conversation.item.delete', event_id: `del-${replaces}`, item_id: replaces }] : []),
    { type: 'conversation.item.create', item: { id, type: 'message', role: 'system', content: [{ type: 'input_text', text }] } },
  ];
}

/**
 * The event that adds a line the receptionist has already said (a greeting
 * played from a recording) as the assistant's own message, so the model
 * carries on from it instead of greeting the caller a second time.
 *
 * Checked 13 Oct 2026 against OpenAI's realtime API reference (client events,
 * `conversation.item.create`, developers.openai.com/api/reference/resources/realtime/client-events):
 * an assistant message's content is `output_text` or `output_audio`, a system
 * message's is `input_text` only, and a client's `event_id` "will be passed
 * back if there is an error with the event", which is how a refusal of this
 * line is told apart from any other error. A live probe the same day on
 * gpt-realtime-mini, with audio-only output, confirmed both: this line was
 * added as `output_text`, and an assistant item sent with `input_text` was
 * refused ("Value must be 'output_text'") with its event_id echoed.
 */
export function assistantMessageEvent(text: string, eventId: string): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    event_id: eventId,
    item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  };
}

/** What the model is told instead when OpenAI refuses the line as the assistant's own. */
export function alreadySaidNote(text: string): string {
  return `You already greeted the caller with: "${text}". Do not greet them again.`;
}

/** The speed to send, inside OpenAI's range; undefined to send none. */
export function outputSpeed(speed: number | undefined): number | undefined {
  if (speed === undefined || !Number.isFinite(speed)) return undefined;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/** The `turn_detection` block of the session, for the configured mode. */
export function turnDetectionConfig(
  options: Pick<RealtimeConversationOptions, 'silenceMs' | 'turnDetection' | 'eagerness'>,
): Record<string, unknown> {
  // The gateway starts each reply itself, right after pinning the backend's
  // required action, so the model never replies blind. It also decides what
  // caller speech interrupts: a word of acknowledgement must not cut the
  // receptionist off, so OpenAI is not allowed to cancel responses on its own.
  const shared = { create_response: false, interrupt_response: false };
  if (options.turnDetection === 'semantic_vad') {
    return { type: 'semantic_vad', eagerness: options.eagerness ?? 'auto', ...shared };
  }
  return {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: options.silenceMs,
    ...shared,
  };
}

export class OpenAiRealtimeConversation implements RealtimeConversation {
  private readonly logger = new Logger('OpenAiRealtime');
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
  /** Where in the input buffer the current caller speech began. */
  private speechStartMs: number | null = null;
  private notes = 0;
  /** The state note currently in the conversation, replaced by the next one. */
  private pinnedNote: string | null = null;
  /** Lines added as the assistant's own, by the event that added them, in case OpenAI refuses one. */
  private readonly saidLines = new Map<string, string>();
  private said = 0;
  /** OpenAI refused a line as the assistant's own: the next ones go straight to a note. */
  private assistantLinesRefused = false;
  /** Caller audio received before the session was configured, oldest first. */
  private readonly earlyAudio: Buffer[] = [];
  private earlyAudioBytes = 0;

  /** For the line logged when the session closes. */
  private readonly tag: string;
  private readonly openedAt = Date.now();
  private readonly sentByReason = new Map<string, number>();
  private created = 0;
  private unrequested = 0;
  private cancelled = 0;
  private firstLimits: RateLimit[] | null = null;
  private lastLimits: RateLimit[] | null = null;
  /** Why the session was given up on before it was usable, for the error reported in its place. */
  private rejection: string | null = null;
  private readyTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RealtimeConversationOptions) {
    const { callbacks } = options;

    processTotals.sessions += 1;
    this.tag = `session #${processTotals.sessions}${options.label ? ` for call ${options.label}` : ''}`;
    this.logger.log(`${this.tag}: connecting to ${options.model}`);

    // Deliberately not OPENAI_BASE_URL, which may point at a text-only gateway.
    this.socket = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`,
      { headers: { Authorization: `Bearer ${options.apiKey}` }, handshakeTimeout: CONNECT_TIMEOUT_MS },
    );

    this.socket.on('open', () => {
      // Settings sent and never confirmed leave a session that cannot be used
      // and never closes; the caller would wait on it in silence.
      this.readyTimer = setTimeout(() => this.giveUp(`OpenAI realtime session was not ready ${READY_TIMEOUT_MS / 1000}s after connecting`), READY_TIMEOUT_MS);
      const noise = options.noiseReduction ?? 'near_field';
      const speed = outputSpeed(options.speed);
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
                // Phone audio is close-mic. Without this, road noise and the
                // caller's own breathing start turns and interrupt the receptionist.
                noise_reduction: noise === 'off' ? null : { type: noise },
                transcription: {
                  model: options.transcriptionModel,
                  language: 'en',
                  ...(options.transcriptionPrompt ? { prompt: options.transcriptionPrompt } : {}),
                },
                turn_detection: turnDetectionConfig(options),
              },
              output: { format: { type: 'audio/pcmu' }, voice: options.voice, ...(speed !== undefined ? { speed } : {}) },
            },
            tools: REALTIME_TOOLS,
            tool_choice: 'auto',
          },
        }),
      );
    });

    this.socket.on('message', (raw) => this.handle(raw));
    this.socket.on('error', (error) => callbacks.onError(this.rejection ? new Error(this.rejection) : error));
    // With this listened for, `ws` leaves a rejected handshake open and never
    // closes: on a real outage the call sat in silence for a minute and a
    // half, then ended as the caller having gone quiet. The socket is ended
    // here, so a rejection is a close like any other.
    this.socket.on('unexpected-response', (_request, response) => {
      this.giveUp(`OpenAI realtime connection rejected: HTTP ${response.statusCode}`);
    });
    this.socket.on('close', (code, reason) => {
      this.closed = true;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.logSummary(code, reason.toString());
      callbacks.onClose?.();
    });
  }

  /** Ends a session that never became usable; the error and close events follow from `ws`. */
  private giveUp(why: string): void {
    if (this.closed) return;
    this.rejection = why;
    this.socket.terminate();
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
          if (this.readyTimer) clearTimeout(this.readyTimer);
          this.readyTimer = null;
          for (const message of this.outbox) this.socket.send(message);
          this.outbox.length = 0;
          // After the outbox, so a greeting added as already said comes
          // before anything the caller said over it.
          this.flushEarlyAudio();
        }
        break;

      case 'rate_limits.updated':
        if (event.rate_limits?.length) {
          this.firstLimits ??= event.rate_limits;
          this.lastLimits = event.rate_limits;
        }
        break;

      case 'input_audio_buffer.speech_started':
        this.speechStartMs = typeof event.audio_start_ms === 'number' ? event.audio_start_ms : null;
        callbacks.onSpeechStarted();
        break;

      case 'input_audio_buffer.speech_stopped': {
        const start = this.speechStartMs;
        this.speechStartMs = null;
        const end = typeof event.audio_end_ms === 'number' ? event.audio_end_ms : null;
        callbacks.onSpeechStopped?.(start !== null && end !== null ? Math.max(0, end - start) : 0);
        break;
      }

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
        this.created += 1;
        processTotals.responsesCreated += 1;
        const reason = requested ? this.awaitingPayload?.reason : undefined;
        const tag = requested ? this.awaitingPayload?.tag : undefined;
        if (requested) {
          this.awaitingRequest = null;
        } else {
          this.unrequested += 1;
          if (this.queued) {
            // The model is already answering, with the latest tool results in
            // context. A queued follow-up would talk over it.
            this.queued = null;
          }
        }
        callbacks.onResponseStarted(id, requested, reason, tag);
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
        if (response?.status === 'cancelled') this.cancelled += 1;
        if (response?.usage) callbacks.onUsage?.({ kind: 'response', usage: response.usage });
        const failed = response?.status === 'failed' ? response.status_details?.error : null;
        callbacks.onResponseDone({
          id: response?.id ?? '',
          status: response?.status ?? 'completed',
          ...(response?.status === 'failed'
            ? { failure: [failed?.code ?? failed?.type, failed?.message].filter(Boolean).join(': ') || 'no reason given' }
            : {}),
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
          // Lost a race with a response already starting. Try again when that
          // one ends, unless it makes this one unnecessary (see response.created).
          this.awaitingRequest = null;
          this.queued = this.awaitingPayload;
          this.flushQueued();
          break;
        }
        if (code === 'response_cancel_not_active') break;
        // A note that was already gone: nothing was lost by failing to remove it.
        if (event.error?.event_id?.startsWith('del-')) break;
        const refused = event.error?.event_id ? this.saidLines.get(event.error.event_id) : undefined;
        if (refused !== undefined) {
          // The greeting was played either way; the model is told in a note
          // instead, so it does not greet the caller again. Once: the note is
          // a system message, which OpenAI accepts.
          this.saidLines.delete(event.error!.event_id!);
          this.assistantLinesRefused = true;
          this.logger.warn(
            `${this.tag}: OpenAI refused a line as the assistant's own (${event.error?.message ?? 'no reason given'}${code ? `, ${code}` : ''}); told the model in a note instead`,
          );
          this.addNote(alreadySaidNote(refused));
          break;
        }
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
    const reason = request.reason ?? 'unspecified';
    this.sentByReason.set(reason, (this.sentByReason.get(reason) ?? 0) + 1);
    processTotals.responsesRequested += 1;
    this.send(responseCreateEvent(id, request));
  }

  /** One line per session: what it asked of OpenAI, and the limits OpenAI reported. */
  private logSummary(code: number, reason: string): void {
    const seconds = Math.round((Date.now() - this.openedAt) / 1000);
    const sent = [...this.sentByReason.values()].reduce((sum, n) => sum + n, 0);
    const byReason = [...this.sentByReason.entries()].map(([why, n]) => `${why} ${n}`).join(', ');
    const limits = (list: RateLimit[] | null) =>
      list ? list.map((l) => `${l.name} ${l.remaining}/${l.limit}`).join(', ') : 'not reported';
    this.logger.log(
      `${this.tag}: closed after ${seconds}s (code ${code}${reason ? `, ${reason}` : ''}) · ` +
        `response.create sent ${sent}${byReason ? ` (${byReason})` : ''} · ` +
        `responses created ${this.created}${this.unrequested ? ` (${this.unrequested} not requested)` : ''}, ` +
        `cancelled ${this.cancelled} · rate limits first ${limits(this.firstLimits)}, last ${limits(this.lastLimits)}`,
    );
  }

  appendAudio(chunk: Buffer): void {
    if (this.closed) return;
    if (!this.ready) {
      // Sent before configuration, it would be decoded with the wrong format,
      // so it is held instead. It used to be dropped, which cost nothing while
      // the model spoke the greeting after the session was ready; with the
      // greeting played from a recording the instant the call connects, the
      // caller can answer it before the session is configured, and that
      // answer must be heard.
      this.holdEarlyAudio(chunk);
      return;
    }
    this.send({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
  }

  /**
   * Keeps the latest audio, up to the cap: what is appended at ready then
   * runs straight on into the live audio after it, without a gap in the
   * middle of a word.
   */
  private holdEarlyAudio(chunk: Buffer): void {
    this.earlyAudio.push(chunk);
    this.earlyAudioBytes += chunk.length;
    while (this.earlyAudioBytes > EARLY_AUDIO_MAX_BYTES) {
      const excess = this.earlyAudioBytes - EARLY_AUDIO_MAX_BYTES;
      const oldest = this.earlyAudio[0]!;
      if (oldest.length <= excess) {
        this.earlyAudio.shift();
        this.earlyAudioBytes -= oldest.length;
      } else {
        this.earlyAudio[0] = oldest.subarray(excess);
        this.earlyAudioBytes -= excess;
      }
    }
  }

  /** Appends the held audio, in the order it came, as one event. */
  private flushEarlyAudio(): void {
    if (!this.earlyAudio.length) return;
    const audio = Buffer.concat(this.earlyAudio);
    this.earlyAudio.length = 0;
    this.earlyAudioBytes = 0;
    this.logger.log(`${this.tag}: appended ${Math.round(audio.length / 8)} ms of caller audio received before the session was ready`);
    this.send({ type: 'input_audio_buffer.append', audio: audio.toString('base64') });
  }

  requestResponse(request: ResponseRequest = {}): void {
    if (this.activeResponseId || this.awaitingRequest) {
      this.queued = request;
      return;
    }
    this.sendRequest(request);
  }

  submitToolResults(results: Array<{ callId: string; output: unknown }>, note?: string, request?: ResponseRequest | null): void {
    for (const result of results) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: result.callId, output: JSON.stringify(result.output) },
      });
    }
    if (note) this.addNote(note, { pinned: true });
    if (request === null) return;
    this.requestResponse({ ...request, reason: request?.reason ?? 'tool-results' });
  }

  addNote(text: string, options: { pinned?: boolean } = {}): void {
    const id = `note_${++this.notes}`;
    for (const event of noteEvents(text, id, options.pinned ? this.pinnedNote : null)) this.send(event);
    if (options.pinned) this.pinnedNote = id;
  }

  /**
   * Adds a line as the assistant's own, already said. If OpenAI refuses it,
   * the model is told the same in a note (see the `error` case), so the
   * greeting is right either way.
   */
  addAssistantMessage(text: string): void {
    if (this.assistantLinesRefused) {
      this.addNote(alreadySaidNote(text));
      return;
    }
    const id = `said-${++this.said}`;
    this.saidLines.set(id, text);
    this.send(assistantMessageEvent(text, id));
  }

  cancelResponse(options: { keepQueued?: boolean } = {}): void {
    if (!options.keepQueued) this.queued = null;
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
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}
