/**
 * Twilio Media Streams with gpt-realtime as the receptionist — VOICE_PIPELINE=chatgpt.
 *
 * One continuous realtime session per call holds the conversation: it hears
 * the caller, answers what they mean, and calls backend tools. The backend
 * stays the authority on everything that must be true:
 *
 *   caller ⇄ Twilio ⇄ this gateway ⇄ gpt-realtime
 *                          │ tool calls (bound to this call)
 *                          ▼
 *                 CallSessionService → validation, intake rules, lead,
 *                                      callback, notifications (unchanged)
 *
 * This gateway owns what only it can see:
 *
 *  - Playback. Twilio `mark`s report how much of each reply the caller has
 *    actually heard. On barge-in, Twilio's buffer is cleared and the model's
 *    memory of the reply is truncated to what was played, so neither the
 *    model nor the transcript believes the caller heard words they did not.
 *  - Guardrails. The model's words are checked as they are produced; a reply
 *    that claims a price, arrival time, dispatch or availability is stopped,
 *    and the model is told to continue without it.
 *  - Silence, counted by the backend and phrased by the model.
 *  - Transcript order. Caller text arrives asynchronously, so lines are
 *    written in the order they were spoken, not the order they were ready.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { CallEventType } from '@towai/shared';

import { CallSessionService } from '../../../call-session/call-session.service';
import { checkReply } from '../../../conversation/guardrails';
import { BusinessConfigService } from '../../../modules/businesses/business-config.service';
import {
  REALTIME_CONVERSATION_FACTORY,
  type RealtimeConversation,
  type RealtimeConversationFactory,
  type RealtimeResponseSummary,
  type ResponseRequest,
} from '../../realtime/openai-realtime-conversation';
import {
  SAFE_FALLBACK_LINE,
  SILENCE_CHECK_INSTRUCTIONS,
  SILENCE_GOODBYE_INSTRUCTIONS,
  TURN_LIMIT_GOODBYE_INSTRUCTIONS,
  buildReceptionistInstructions,
  exactLineInstructions,
  greetingInstructions,
  guardrailRecoveryInstructions,
} from '../../realtime/realtime-instructions';
import { TOOL, createToolExecutor, type ToolExecutor } from '../../realtime/realtime-tools';
import type { MediaSocket } from './media-stream.gateway';

export const REALTIME_STREAM_PATH = '/api/telephony/twilio/realtime';

/** Twilio sends 20ms of μ-law per frame: 8000 samples/s × 0.02s = 160 bytes. */
const FRAME_BYTES = 160;
/** μ-law at 8 kHz: 8 bytes per millisecond. */
const BYTES_PER_MS = 8;
/** Silence after the receptionist finishes speaking before it checks in. */
const NO_INPUT_MS = 7_000;
/** How long a caller line may wait for its transcription before it is skipped. */
const TRANSCRIPT_WAIT_MS = 8_000;
/** Longest wait for the goodbye to be spoken and played once the call has ended. */
const GOODBYE_LIMIT_MS = 20_000;

/** Comparable form of a line: case, punctuation and spacing ignored. */
const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The words of a reply the caller heard, by the share of its audio that played. */
export function heardPortion(text: string, playedBytes: number, sentBytes: number): string {
  if (sentBytes <= 0 || playedBytes <= 0) return '';
  const words = text.trim().split(/\s+/).filter(Boolean);
  const count = Math.floor(words.length * Math.min(1, playedBytes / sentBytes));
  return words.slice(0, count).join(' ');
}

interface TwilioMessage {
  event: string;
  streamSid?: string;
  start?: { callSid: string; customParameters?: Record<string, string> };
  media?: { payload: string };
  mark?: { name: string };
}

/** One assistant message: what was generated, sent to Twilio, and played. */
interface AssistantItem {
  id: string;
  responseId: string | null;
  text: string;
  bytesSent: number;
  bytesPlayed: number;
  /** The response that produced it has finished generating. */
  generated: boolean;
  /** Stopped before it finished playing, by barge-in or a guardrail. */
  stopped: 'interrupted' | 'guardrail' | null;
  /** Its transcript line has been settled. */
  settled: boolean;
}

/** A transcript line held in speaking order until its text is known. */
interface PendingLine {
  speaker: 'customer' | 'ai';
  key: string;
  text: string | null;
  ready: boolean;
  timer?: NodeJS.Timeout;
}

class RealtimeCallSession {
  streamSid: string | null = null;
  businessId: string | null = null;
  callId: string | null = null;
  greeting: string | null = null;
  instructions = '';
  conversation: RealtimeConversation | null = null;
  execute: ToolExecutor | null = null;

  readonly items = new Map<string, AssistantItem>();
  readonly marks = new Map<string, { itemId: string; bytes: number }>();
  markCounter = 0;

  currentResponseId: string | null = null;
  greetingResponseId: string | null = null;
  awaitingGreeting = false;
  responding = false;
  toolsRunning = false;

  /** The backend has ended the call; hang up once the goodbye has played. */
  ending = false;
  responsesSinceEnding = 0;
  endTimer: NodeJS.Timeout | null = null;

  guardrailTrips = 0;
  /** A configured pricing fact was given to the model, so it may repeat it. */
  pricingAllowed = false;

  /** Every database operation for this call, strictly in order. */
  ops: Promise<unknown> = Promise.resolve();
  readonly lines: PendingLine[] = [];

  noInputTimer: NodeJS.Timeout | null = null;
  closed = false;

  get playing(): boolean {
    for (const item of this.items.values()) {
      if (!item.stopped && item.bytesPlayed < item.bytesSent) return true;
    }
    return false;
  }
}

@Injectable()
export class RealtimeVoiceGateway {
  private readonly logger = new Logger('RealtimeVoice');
  private server: WebSocketServer | null = null;

  constructor(
    private readonly callSession: CallSessionService,
    private readonly businessConfig: BusinessConfigService,
    @Inject(REALTIME_CONVERSATION_FACTORY)
    private readonly createConversation: RealtimeConversationFactory,
  ) {}

  /** Attached from `main.ts` only when VOICE_PIPELINE=chatgpt. */
  attach(httpServer: import('node:http').Server): void {
    this.server = new WebSocketServer({ server: httpServer, path: REALTIME_STREAM_PATH });
    this.server.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.logger.log(`Realtime voice gateway listening on ${REALTIME_STREAM_PATH}`);
  }

  handleConnection(socket: MediaSocket, _request?: IncomingMessage): void {
    const session = new RealtimeCallSession();

    socket.on('message', (raw: Buffer) => {
      void this.handleMessage(socket, session, raw.toString());
    });
    socket.on('close', () => void this.teardown(session));
    socket.on('error', (error: Error) => {
      this.logger.error(`Socket error on call ${session.callId}: ${error.message}`);
      void this.teardown(session);
    });
  }

  private async handleMessage(socket: MediaSocket, session: RealtimeCallSession, raw: string): Promise<void> {
    let message: TwilioMessage;
    try {
      message = JSON.parse(raw) as TwilioMessage;
    } catch {
      return;
    }

    switch (message.event) {
      case 'start':
        await this.handleStart(socket, session, message);
        break;

      case 'media':
        if (message.media?.payload) {
          session.conversation?.appendAudio(Buffer.from(message.media.payload, 'base64'));
        }
        break;

      case 'mark':
        this.handleMark(socket, session, message.mark?.name);
        break;

      case 'stop':
        await this.teardown(session);
        break;

      default:
        break;
    }
  }

  private async handleStart(socket: MediaSocket, session: RealtimeCallSession, message: TwilioMessage): Promise<void> {
    session.streamSid = message.streamSid ?? null;
    const params = message.start?.customParameters ?? {};
    session.businessId = params['businessId'] ?? null;
    session.callId = params['callId'] ?? null;
    session.greeting = params['greeting'] ?? null;

    if (!session.businessId || !session.callId) {
      this.logger.error('Realtime stream started without businessId/callId parameters; closing.');
      socket.close();
      return;
    }

    const config = await this.businessConfig.load(session.businessId);
    session.instructions = buildReceptionistInstructions({
      facts: config.flow.facts,
      callerNumber: params['callerNumber'] || null,
    });
    // The tools act on this call and no other; nothing the model says changes that.
    session.execute = createToolExecutor({
      callSession: this.callSession,
      businessId: session.businessId,
      callId: session.callId,
    });

    session.conversation = this.createConversation({
      instructions: session.instructions,
      callbacks: {
        onSpeechStarted: () => this.interrupt(socket, session),
        onCallerTurn: (itemId) => this.expectLine(session, 'customer', itemId),
        onCallerTranscript: (itemId, text) => this.callerTranscript(session, itemId, text),
        onResponseStarted: (responseId, requested) => {
          session.responding = true;
          session.currentResponseId = responseId;
          if (requested && session.awaitingGreeting) {
            session.awaitingGreeting = false;
            session.greetingResponseId = responseId;
          }
          this.clearNoInputTimer(session);
        },
        onAudio: (itemId, chunk) => this.forwardAudio(socket, session, itemId, chunk),
        onSpokenText: (itemId, text) => this.monitorSpeech(socket, session, itemId, text),
        onResponseDone: (response) => this.responseDone(socket, session, response),
        onError: (error) => {
          this.logger.error(`Realtime error on call ${session.callId}: ${error.message}`);
          void this.enqueue(session, () => this.recordProviderError(session, 'error', error.message));
        },
        onClose: () => {
          // Without the model the caller would hear only silence. Ending the
          // call finalises it, which turns what was collected into a lead or a
          // callback rather than an abandoned call.
          if (!session.closed) {
            this.logger.error(`Realtime session closed mid-call on ${session.callId}; ending the call.`);
            void this.enqueue(session, () =>
              this.recordProviderError(session, 'session_closed', 'OpenAI realtime session closed mid-call'),
            ).finally(() => socket.close());
          }
        },
      },
    });

    // The greeting was chosen and stored by the voice webhook. Spoken inside the
    // conversation, so the model knows it has greeted the caller.
    if (session.greeting) {
      session.awaitingGreeting = true;
      this.respond(session, { instructions: greetingInstructions(session.greeting), toolChoice: 'none' });
    }
  }

  /** Asks the model to respond, keeping the receptionist's full instructions. */
  private respond(session: RealtimeCallSession, request: ResponseRequest = {}): void {
    session.conversation?.requestResponse({
      ...request,
      instructions: request.instructions ? `${session.instructions}\n\nRIGHT NOW\n${request.instructions}` : undefined,
    });
  }

  /* ------------------------------------------------------------------------ */
  /*  Assistant audio and playback                                            */
  /* ------------------------------------------------------------------------ */

  private item(session: RealtimeCallSession, itemId: string): AssistantItem {
    let item = session.items.get(itemId);
    if (!item) {
      item = {
        id: itemId,
        responseId: session.currentResponseId,
        text: '',
        bytesSent: 0,
        bytesPlayed: 0,
        generated: false,
        stopped: null,
        settled: false,
      };
      session.items.set(itemId, item);
      this.expectLine(session, 'ai', itemId);
    }
    return item;
  }

  private forwardAudio(socket: MediaSocket, session: RealtimeCallSession, itemId: string, audio: Buffer): void {
    const item = this.item(session, itemId);
    // Audio still arriving for a stopped reply must not reach the caller.
    if (item.stopped || session.closed || !session.streamSid || socket.readyState !== socket.OPEN) return;

    for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
      socket.send(
        JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: { payload: audio.subarray(offset, offset + FRAME_BYTES).toString('base64') },
        }),
      );
    }
    item.bytesSent += audio.length;

    // Twilio echoes each mark when playback reaches it: that is what "heard" means.
    const name = `p${++session.markCounter}`;
    session.marks.set(name, { itemId, bytes: item.bytesSent });
    socket.send(JSON.stringify({ event: 'mark', streamSid: session.streamSid, mark: { name } }));
  }

  private handleMark(socket: MediaSocket, session: RealtimeCallSession, name: string | undefined): void {
    const mark = name ? session.marks.get(name) : undefined;
    if (!name || !mark) return;
    session.marks.delete(name);

    const item = session.items.get(mark.itemId);
    // Twilio also echoes marks for audio discarded by `clear`; those were not heard.
    if (!item || item.stopped) return;
    item.bytesPlayed = Math.max(item.bytesPlayed, mark.bytes);
    this.settleItem(session, item);
    this.checkIdle(socket, session);
  }

  private responseDone(socket: MediaSocket, session: RealtimeCallSession, response: RealtimeResponseSummary): void {
    session.responding = false;
    if (session.currentResponseId === response.id) session.currentResponseId = null;
    if (session.ending) session.responsesSinceEnding += 1;

    for (const item of session.items.values()) {
      if (item.responseId === response.id || item.responseId === null) {
        item.generated = true;
        this.settleItem(session, item);
      }
    }

    if (response.toolCalls.length > 0) {
      void this.runTools(socket, session, response);
    }
    this.checkIdle(socket, session);
  }

  /* ------------------------------------------------------------------------ */
  /*  Tools                                                                   */
  /* ------------------------------------------------------------------------ */

  private async runTools(socket: MediaSocket, session: RealtimeCallSession, response: RealtimeResponseSummary): Promise<void> {
    const execute = session.execute;
    if (!execute) return;
    session.toolsRunning = true;

    try {
      const results: Array<{ callId: string; output: unknown }> = [];
      let ended = false;

      for (const call of response.toolCalls) {
        const result = await this.enqueue(session, () => execute(call.name, call.arguments));
        if (!result) {
          results.push({ callId: call.callId, output: { error: 'That could not be saved. Carry on with the caller.' } });
          continue;
        }
        results.push({ callId: call.callId, output: result.output });
        ended ||= result.ended;
        if (call.name === TOOL.BUSINESS && typeof result.output.fact === 'string' && result.output.fact.startsWith('Pricing')) {
          session.pricingAllowed = true;
        }
      }

      if (ended) this.beginEnding(socket, session);
      if (!session.closed) session.conversation?.submitToolResults(results);
    } finally {
      session.toolsRunning = false;
    }
  }

  /** The backend has ended the call. Let the model say goodbye, then hang up. */
  private beginEnding(socket: MediaSocket, session: RealtimeCallSession): void {
    if (session.ending) return;
    session.ending = true;
    session.responsesSinceEnding = 0;
    this.clearNoInputTimer(session);
    session.endTimer = setTimeout(() => socket.close(), GOODBYE_LIMIT_MS);
  }

  /* ------------------------------------------------------------------------ */
  /*  Barge-in and guardrails                                                 */
  /* ------------------------------------------------------------------------ */

  /** The caller started talking. Fires on every speech onset, so it must be cheap. */
  private interrupt(socket: MediaSocket, session: RealtimeCallSession): void {
    this.clearNoInputTimer(session);
    if (!session.playing && !session.responding) return;

    const stopped = this.stopSpeaking(socket, session, 'interrupted');
    if (stopped.length > 0 && session.businessId && session.callId) {
      const { businessId, callId } = session;
      void this.enqueue(session, () =>
        this.callSession.logCallEvent(businessId, callId, CallEventType.AI_INTERRUPTED, {
          heardMs: Math.round(stopped[0]!.bytesPlayed / BYTES_PER_MS),
        }),
      );
    }
  }

  /**
   * Stops everything not yet heard: the response being generated, Twilio's
   * buffer, and the model's memory of the unheard part.
   */
  private stopSpeaking(
    socket: MediaSocket,
    session: RealtimeCallSession,
    reason: 'interrupted' | 'guardrail',
    only?: AssistantItem,
  ): AssistantItem[] {
    if (session.responding) session.conversation?.cancelResponse();

    const stopped: AssistantItem[] = [];
    for (const item of only ? [only] : [...session.items.values()]) {
      if (item.stopped || item.settled) continue;
      item.stopped = reason;
      session.conversation?.truncate(item.id, item.bytesPlayed / BYTES_PER_MS);
      stopped.push(item);
    }

    if (session.streamSid && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    for (const item of stopped) this.settleItem(session, item);
    return stopped;
  }

  /** The guardrails, applied to the model's words as they are produced. */
  private monitorSpeech(socket: MediaSocket, session: RealtimeCallSession, itemId: string, text: string): void {
    const item = this.item(session, itemId);
    if (item.stopped) return;
    item.text = text;

    const verdict = checkReply(text, { allowPricing: session.pricingAllowed });
    if (verdict.ok) return;
    // Length is not a safety matter for a free conversation.
    const violations = verdict.violations.filter((v) => v.code !== 'too_long');
    if (violations.length === 0) return;

    this.stopSpeaking(socket, session, 'guardrail', item);
    session.guardrailTrips += 1;
    const attempt = session.guardrailTrips;

    this.logger.warn(`Call ${session.callId}: stopped a reply that ${violations.map((v) => v.detail).join(', ')}`);
    if (session.businessId && session.callId) {
      const { businessId, callId } = session;
      void this.enqueue(session, () =>
        this.callSession.logCallEvent(businessId, callId, CallEventType.GUARDRAIL_TRIPPED, {
          pipeline: 'chatgpt',
          violations: violations.map((v) => v.code),
          suppressed: text,
          attempt,
        }),
      );
    }

    // First time, the model recovers in its own words. After that, a fixed line.
    if (attempt === 1) {
      this.respond(session, { instructions: guardrailRecoveryInstructions(violations[0]!.detail) });
    } else if (attempt === 2) {
      this.respond(session, { instructions: exactLineInstructions(SAFE_FALLBACK_LINE), toolChoice: 'none' });
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Silence and ending                                                      */
  /* ------------------------------------------------------------------------ */

  /** Nothing is being said or prepared. Wait for the caller, or hang up. */
  private checkIdle(socket: MediaSocket, session: RealtimeCallSession): void {
    if (session.closed || session.responding || session.toolsRunning || session.playing) return;

    if (session.ending) {
      if (session.responsesSinceEnding > 0) socket.close();
      return;
    }
    this.armNoInputTimer(socket, session);
  }

  private armNoInputTimer(socket: MediaSocket, session: RealtimeCallSession): void {
    this.clearNoInputTimer(session);
    if (session.closed) return;
    session.noInputTimer = setTimeout(() => void this.handleSilence(socket, session), NO_INPUT_MS);
  }

  private clearNoInputTimer(session: RealtimeCallSession): void {
    if (session.noInputTimer) {
      clearTimeout(session.noInputTimer);
      session.noInputTimer = null;
    }
  }

  private async handleSilence(socket: MediaSocket, session: RealtimeCallSession): Promise<void> {
    if (session.closed || session.responding || session.ending || !session.businessId || !session.callId) return;
    const { businessId, callId } = session;

    const result = await this.enqueue(session, () =>
      this.callSession.applyIntakeOperation(businessId, callId, { kind: 'silence' }),
    );
    if (!result || session.closed) return;

    if (result.ended) {
      this.beginEnding(socket, session);
      this.respond(session, { instructions: SILENCE_GOODBYE_INSTRUCTIONS, toolChoice: 'none' });
    } else {
      this.respond(session, { instructions: SILENCE_CHECK_INSTRUCTIONS });
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Transcript                                                              */
  /* ------------------------------------------------------------------------ */

  /** Reserves a transcript position at the moment the line is spoken. */
  private expectLine(session: RealtimeCallSession, speaker: PendingLine['speaker'], key: string): void {
    if (session.lines.some((line) => line.key === key)) return;
    const line: PendingLine = { speaker, key, text: null, ready: false };
    if (speaker === 'customer') {
      // A transcription that never arrives must not hold up every later line.
      line.timer = setTimeout(() => this.resolveLine(session, key, null), TRANSCRIPT_WAIT_MS);
    }
    session.lines.push(line);
  }

  private resolveLine(session: RealtimeCallSession, key: string, text: string | null): void {
    const line = session.lines.find((l) => l.key === key);
    if (!line || line.ready) return;
    if (line.timer) clearTimeout(line.timer);
    line.text = text;
    line.ready = true;
    this.flushLines(session);
  }

  private callerTranscript(session: RealtimeCallSession, itemId: string, text: string | null): void {
    this.expectLine(session, 'customer', itemId);
    this.resolveLine(session, itemId, text);
  }

  /** An assistant line is final once played in full, or once stopped. */
  private settleItem(session: RealtimeCallSession, item: AssistantItem): void {
    if (item.settled) return;
    if (!item.stopped && !(item.generated && item.bytesPlayed >= item.bytesSent)) return;
    item.settled = true;

    let text: string | null;
    if (item.stopped) {
      const heard = heardPortion(item.text, item.bytesPlayed, item.bytesSent);
      text = heard ? `${heard} [${item.stopped === 'guardrail' ? 'stopped' : 'interrupted'}]` : null;
    } else {
      text = item.text.trim() || null;
    }

    // The voice webhook already recorded the greeting it chose.
    const isGreeting = item.responseId !== null && item.responseId === session.greetingResponseId;
    if (isGreeting && !item.stopped && text && session.greeting && comparable(text) === comparable(session.greeting)) {
      text = null;
    }
    this.resolveLine(session, item.id, text);
  }

  /** Writes ready lines in speaking order. */
  private flushLines(session: RealtimeCallSession): void {
    while (session.lines[0]?.ready) {
      const line = session.lines.shift()!;
      if (!line.text || !session.businessId || !session.callId) continue;
      const { businessId, callId } = session;
      const text = line.text;

      if (line.speaker === 'ai') {
        void this.enqueue(session, () => this.callSession.appendAiTranscriptLine(businessId, callId, text));
      } else {
        void this.enqueue(session, async () => {
          const result = await this.callSession.applyIntakeOperation(businessId, callId, {
            kind: 'caller_speech',
            text,
          });
          // The call has run past its turn limit: close it politely.
          if (result.ended && !session.ending && !session.closed) {
            session.ending = true;
            session.responsesSinceEnding = 0;
            this.respond(session, { instructions: TURN_LIMIT_GOODBYE_INSTRUCTIONS, toolChoice: 'none' });
          }
        });
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Plumbing                                                                */
  /* ------------------------------------------------------------------------ */

  /** Runs database work for this call in order. Resolves null if it failed. */
  private enqueue<T>(session: RealtimeCallSession, work: () => Promise<T>): Promise<T | null> {
    const run = session.ops.then(work).catch((error: unknown) => {
      this.logger.error(`Call ${session.callId}: ${error instanceof Error ? error.message : error}`);
      return null;
    });
    session.ops = run;
    return run;
  }

  /** Leaves a trace in the call's event history, which outlives the API log. */
  private async recordProviderError(session: RealtimeCallSession, stage: string, message: string): Promise<void> {
    if (!session.businessId || !session.callId) return;
    await this.callSession.logCallEvent(session.businessId, session.callId, CallEventType.PROVIDER_ERROR, {
      provider: 'openai-realtime',
      stage,
      message,
    });
  }

  private async teardown(session: RealtimeCallSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;

    this.clearNoInputTimer(session);
    if (session.endTimer) clearTimeout(session.endTimer);
    session.conversation?.close();

    // Record what was said, as far as it was heard, before finalising.
    for (const item of session.items.values()) {
      if (!item.settled && !item.stopped) {
        item.stopped = 'interrupted';
        this.settleItem(session, item);
      }
    }
    for (const line of [...session.lines]) {
      if (!line.ready) this.resolveLine(session, line.key, line.text);
    }

    if (session.businessId && session.callId) {
      const { businessId, callId } = session;
      await this.enqueue(session, () =>
        this.callSession.handleEvent(businessId, callId, { kind: 'HANGUP' }, { phrase: false }),
      );
    }
  }
}
