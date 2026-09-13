/**
 * Twilio Media Streams driven by gpt-realtime-mini — VOICE_PIPELINE=chatgpt.
 *
 * One speech-to-speech model hears the caller, understands them and speaks,
 * with no separate recogniser or synthesiser. It still decides nothing:
 *
 *   caller audio ──► model ──► report_caller_turn(details)
 *                                    │
 *                     validation + state machine (unchanged)
 *                                    │
 *   caller ear  ◄── model speaks ◄── the exact line the workflow chose
 *
 * Because the model voices the line itself, it may smooth the wording. What it
 * actually says is transcribed as it speaks and checked against the same
 * guardrails as every other reply. If it starts claiming something the line did
 * not — a price, an arrival time, a truck on its way — the speech is cancelled,
 * Twilio's buffer is cleared, and the line is spoken again word for word. The
 * transcript runs well ahead of playback, so the offending words are normally
 * discarded before the caller hears them.
 *
 * Playback, barge-in and silence handling follow the stream gateway: marks
 * report when audio has actually played, and `clear` discards the rest.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { CallEventType, type ReceptionistTone } from '@towai/shared';

import { CallSessionService, type TurnResult } from '../../../call-session/call-session.service';
import { checkReply, type ViolationCode } from '../../../conversation/guardrails';
import { BusinessConfigService } from '../../../modules/businesses/business-config.service';
import {
  REALTIME_CONVERSATION_FACTORY,
  type RealtimeConversation,
  type RealtimeConversationFactory,
} from '../../realtime/openai-realtime-conversation';
import { normaliseCallerTurn } from '../../realtime/realtime-extraction';
import {
  buildRealtimeExtractionInstructions,
  buildSpeakInstructions,
} from '../../realtime/realtime-instructions';
import type { MediaSocket } from './media-stream.gateway';

export const REALTIME_STREAM_PATH = '/api/telephony/twilio/realtime';

/** Twilio sends 20ms of μ-law per frame: 8000 samples/s × 0.02s = 160 bytes. */
const FRAME_BYTES = 160;
/** Silence after the receptionist finishes speaking before it prompts. */
const NO_INPUT_MS = 7_000;
/** Extra allowance on top of a line's audio length before giving up on its mark. */
const PLAYBACK_GRACE_MS = 3_000;

/** Comparable form of a reported utterance: case, punctuation and spacing ignored. */
const comparable = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

interface TwilioMessage {
  event: string;
  streamSid?: string;
  start?: { callSid: string; customParameters?: Record<string, string> };
  media?: { payload: string };
  mark?: { name: string };
}

/** One line being spoken by the model. */
interface ActiveLine {
  /** The caller talked over it. */
  interrupted: boolean;
  /** Guardrail codes the model's wording introduced, once it has been stopped. */
  tripped: ViolationCode[] | null;
  /** Codes already present in the workflow's own line, and so permitted. */
  permitted: Set<ViolationCode>;
  bytes: number;
}

class RealtimeCallSession {
  streamSid: string | null = null;
  businessId: string | null = null;
  callId: string | null = null;
  tone: ReceptionistTone = 'friendly';
  conversation: RealtimeConversation | null = null;
  /** What the model reported the caller saying last turn. */
  lastHeard: string | null = null;

  line: ActiveLine | null = null;
  readonly pendingMarks = new Map<string, () => void>();
  markCounter = 0;

  /** A turn is being processed; a caller turn ending meanwhile is handled next. */
  processing = false;
  turnWaiting = false;

  noInputTimer: NodeJS.Timeout | null = null;
  closed = false;

  get isSpeaking(): boolean {
    return this.line !== null || this.pendingMarks.size > 0;
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

  private async handleMessage(
    socket: MediaSocket,
    session: RealtimeCallSession,
    raw: string,
  ): Promise<void> {
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

      case 'mark': {
        const name = message.mark?.name;
        const done = name ? session.pendingMarks.get(name) : undefined;
        if (name) session.pendingMarks.delete(name);
        done?.();
        break;
      }

      case 'stop':
        await this.teardown(session);
        break;

      default:
        break;
    }
  }

  private async handleStart(
    socket: MediaSocket,
    session: RealtimeCallSession,
    message: TwilioMessage,
  ): Promise<void> {
    session.streamSid = message.streamSid ?? null;
    const params = message.start?.customParameters ?? {};
    session.businessId = params['businessId'] ?? null;
    session.callId = params['callId'] ?? null;

    if (!session.businessId || !session.callId) {
      this.logger.error('Realtime stream started without businessId/callId parameters; closing.');
      socket.close();
      return;
    }

    const config = await this.businessConfig.load(session.businessId);
    session.tone = config.flow.facts.tone ?? 'friendly';

    session.conversation = this.createConversation({
      callbacks: {
        onSpeechStarted: () => this.interrupt(socket, session),
        onCallerTurn: () => void this.runTurn(socket, session),
        onAudio: (chunk) => this.forwardAudio(socket, session, chunk),
        onSpokenText: (soFar) => this.monitorSpeech(socket, session, soFar),
        onError: (error) => {
          this.logger.error(`Realtime error on call ${session.callId}: ${error.message}`);
          void this.recordProviderError(session, 'error', error.message);
        },
        onClose: () => {
          // Without the model the caller would hear only silence. Ending the
          // call finalises it, which turns what was collected into a lead or a
          // callback rather than an abandoned call.
          if (!session.closed) {
            this.logger.error(`Realtime session closed mid-call on ${session.callId}; ending the call.`);
            // Recorded before the socket closes, so it precedes CALL_ENDED.
            void this.recordProviderError(session, 'session_closed', 'OpenAI realtime session closed mid-call').finally(
              () => socket.close(),
            );
          }
        },
      },
    });

    // The greeting was chosen and stored by the voice webhook. Caller turns that
    // end while it plays are handled once it is done.
    session.processing = true;
    try {
      const greeting = params['greeting'];
      if (greeting) {
        const spoken = await this.speakLine(socket, session, greeting);
        await this.recordSpoken(session, greeting, spoken);
      }
    } finally {
      session.processing = false;
    }

    await this.afterTurn(socket, session);
  }

  /* ------------------------------------------------------------------------ */
  /*  Turns                                                                   */
  /* ------------------------------------------------------------------------ */

  private async runTurn(socket: MediaSocket, session: RealtimeCallSession): Promise<void> {
    if (session.closed || !session.conversation || !session.businessId || !session.callId) return;

    // Two turns must never run over one conversation state at once. The next
    // extraction covers all caller audio since the last one, so a single
    // waiting flag loses nothing.
    if (session.processing) {
      session.turnWaiting = true;
      return;
    }

    session.processing = true;
    this.clearNoInputTimer(session);
    const { businessId, callId, conversation } = session;

    try {
      const context = await this.callSession.extractionContext(businessId, callId);
      const args = await conversation.extract(
        buildRealtimeExtractionInstructions(context, session.lastHeard),
      );
      const turn = normaliseCallerTurn(args);

      // Background noise or a cough ends a "turn" too. When the model reports
      // hearing nothing — or nothing new: it has been seen to repeat the
      // caller's previous words for a noise-only turn — carry on as if the
      // caller had not spoken, rather than asking them to repeat themselves.
      const known = context.filledSlots as Record<string, unknown>;
      const nothingNew = Object.entries(turn.extraction.slots).every(
        ([key, value]) => value === null || value === known[key],
      );
      const heardNothing =
        args !== null && !turn.heard && turn.extraction.intent === 'unclear' && nothingNew;
      // "Yes" to two different questions is two answers, not a repeat.
      const answersQuestion =
        turn.extraction.intent === 'confirm' || turn.extraction.intent === 'deny';
      const repeated =
        args !== null &&
        !answersQuestion &&
        !!turn.heard &&
        session.lastHeard !== null &&
        comparable(turn.heard) === comparable(session.lastHeard) &&
        nothingNew;

      if (heardNothing || repeated) {
        if (repeated) {
          this.logger.warn(`Call ${callId}: ignored a repeated report of "${turn.heard}"`);
        }
        return;
      }
      if (turn.heard) session.lastHeard = turn.heard;

      const result = await this.callSession.handleExtractedTurn(
        businessId,
        callId,
        turn.heard,
        turn.extraction,
      );
      await this.deliver(socket, session, result);
    } catch (error) {
      this.logger.error(
        `Turn failed on call ${session.callId}: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      session.processing = false;
    }

    await this.afterTurn(socket, session);
  }

  /** Runs a turn that ended while busy, or starts waiting for the caller. */
  private async afterTurn(socket: MediaSocket, session: RealtimeCallSession): Promise<void> {
    if (session.closed) return;
    if (session.turnWaiting) {
      session.turnWaiting = false;
      await this.runTurn(socket, session);
      return;
    }
    this.armNoInputTimer(socket, session);
  }

  private async deliver(
    socket: MediaSocket,
    session: RealtimeCallSession,
    result: TurnResult,
  ): Promise<void> {
    if (result.reply) {
      const spoken = await this.speakLine(socket, session, result.reply);
      await this.recordSpoken(session, result.reply, spoken);
    }

    if (result.ended) {
      // speakLine has already waited for the goodbye to finish playing.
      socket.close();
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Speech                                                                  */
  /* ------------------------------------------------------------------------ */

  /**
   * Has the model speak one line, and resolves when the caller has heard it, or
   * it was interrupted. Returns what was actually said when it completed.
   */
  private async speakLine(
    socket: MediaSocket,
    session: RealtimeCallSession,
    text: string,
    exact = false,
  ): Promise<string | null> {
    const conversation = session.conversation;
    if (!conversation || session.closed) return null;

    const own = checkReply(text);
    const line: ActiveLine = {
      interrupted: false,
      tripped: null,
      permitted: new Set(own.ok ? [] : own.violations.map((v) => v.code)),
      bytes: 0,
    };
    session.line = line;

    let outcome;
    try {
      outcome = await conversation.speak(text, buildSpeakInstructions(session.tone, exact));
    } finally {
      if (session.line === line) session.line = null;
    }

    if (line.tripped) {
      await this.callSession
        .logCallEvent(session.businessId!, session.callId!, CallEventType.GUARDRAIL_TRIPPED, {
          pipeline: 'chatgpt',
          violations: line.tripped,
          suppressed: outcome.spoken,
          retriedWordForWord: !exact,
        })
        .catch(() => undefined);

      this.logger.warn(
        `Call ${session.callId}: stopped speech that added ${line.tripped.join(', ')}` +
          (exact ? '' : '; repeating the line word for word'),
      );
      // Nothing more is tried after a word-for-word attempt also trips.
      return exact || session.closed ? null : this.speakLine(socket, session, text, true);
    }

    if (line.interrupted) return null;

    if (outcome.status !== 'completed') {
      this.logger.error(`Call ${session.callId}: speech ${outcome.status} for "${text}"`);
    }

    await this.waitForPlayback(socket, session, line.bytes);
    return outcome.status === 'completed' ? outcome.spoken : null;
  }

  private forwardAudio(socket: MediaSocket, session: RealtimeCallSession, audio: Buffer): void {
    const line = session.line;
    // Audio still arriving for a line that was stopped must not reach the caller.
    if (!line || line.interrupted || line.tripped || !session.streamSid) return;
    if (socket.readyState !== socket.OPEN) return;

    line.bytes += audio.length;
    for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
      socket.send(
        JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: { payload: audio.subarray(offset, offset + FRAME_BYTES).toString('base64') },
        }),
      );
    }
  }

  /** The guardrails, applied to the model's words as they are produced. */
  private monitorSpeech(socket: MediaSocket, session: RealtimeCallSession, soFar: string): void {
    const line = session.line;
    if (!line || line.interrupted || line.tripped) return;

    const verdict = checkReply(soFar);
    if (verdict.ok) return;

    // Length is the workflow's call, and a price can be legitimate when the
    // line itself states the business's configured pricing.
    const added = verdict.violations
      .map((v) => v.code)
      .filter((code) => code !== 'too_long' && !line.permitted.has(code));
    if (added.length === 0) return;

    line.tripped = added;
    this.stopSpeaking(socket, session);
  }

  /** Barge-in. Fires on every detected speech onset, so it must be cheap. */
  private interrupt(socket: MediaSocket, session: RealtimeCallSession): void {
    this.clearNoInputTimer(session);
    if (!session.isSpeaking) return;
    if (session.line) session.line.interrupted = true;
    this.stopSpeaking(socket, session);
  }

  private stopSpeaking(socket: MediaSocket, session: RealtimeCallSession): void {
    if (session.line) session.conversation?.cancelSpeech();

    if (session.streamSid && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    for (const done of session.pendingMarks.values()) done();
    session.pendingMarks.clear();
  }

  private async waitForPlayback(
    socket: MediaSocket,
    session: RealtimeCallSession,
    bytes: number,
  ): Promise<void> {
    if (bytes === 0 || !session.streamSid || socket.readyState !== socket.OPEN) return;

    const name = `line-${++session.markCounter}`;
    const audioMs = (bytes / 8000) * 1000;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        session.pendingMarks.delete(name);
        resolve();
      }, audioMs + PLAYBACK_GRACE_MS);

      session.pendingMarks.set(name, () => {
        clearTimeout(timer);
        resolve();
      });

      socket.send(JSON.stringify({ event: 'mark', streamSid: session.streamSid, mark: { name } }));
    });
  }

  /** Leaves a trace in the call's event history, which outlives the API log. */
  private async recordProviderError(
    session: RealtimeCallSession,
    stage: string,
    message: string,
  ): Promise<void> {
    if (!session.businessId || !session.callId) return;
    await this.callSession
      .logCallEvent(session.businessId, session.callId, CallEventType.PROVIDER_ERROR, {
        provider: 'openai-realtime',
        stage,
        message,
      })
      .catch(() => undefined);
  }

  /** The transcript shows what the caller heard, where that differs from the line. */
  private async recordSpoken(
    session: RealtimeCallSession,
    line: string,
    spoken: string | null,
  ): Promise<void> {
    if (!spoken || spoken.trim() === line.trim()) return;
    await this.callSession
      .replaceLastAiTranscript(session.businessId!, session.callId!, spoken)
      .catch(() => undefined);
  }

  /* ------------------------------------------------------------------------ */
  /*  Silence and hang-up                                                     */
  /* ------------------------------------------------------------------------ */

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
    if (session.closed || session.processing || !session.businessId || !session.callId) return;

    session.processing = true;
    try {
      const result = await this.callSession.handleEvent(
        session.businessId,
        session.callId,
        { kind: 'SILENCE' },
        { phrase: false },
      );
      await this.deliver(socket, session, result);
    } catch (error) {
      this.logger.error(
        `Silence handling failed on call ${session.callId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    } finally {
      session.processing = false;
    }

    await this.afterTurn(socket, session);
  }

  private async teardown(session: RealtimeCallSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;

    this.clearNoInputTimer(session);
    if (session.line) session.line.interrupted = true;
    for (const done of session.pendingMarks.values()) done();
    session.pendingMarks.clear();
    session.conversation?.close();

    if (session.businessId && session.callId) {
      await this.callSession
        .handleEvent(session.businessId, session.callId, { kind: 'HANGUP' }, { phrase: false })
        .catch((error: unknown) => {
          this.logger.warn(
            `Could not finalise call ${session.callId}: ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
    }
  }
}
