/**
 * Twilio Media Streams with gpt-realtime as the receptionist — VOICE_PIPELINE=chatgpt.
 *
 * One continuous realtime session per call holds the conversation: it hears
 * the caller, answers what they mean, and calls backend tools. The backend is
 * the authority on everything that must be true, including what to do next:
 *
 *   caller ⇄ Twilio ⇄ this gateway ⇄ gpt-realtime
 *                          │ state note before every reply; tool calls
 *                          ▼
 *                 CallSessionService → validation, priority engine, lead,
 *                                      callback, notifications (unchanged)
 *
 * The model never starts a reply on its own. When the caller finishes a turn,
 * the gateway asks the backend for the state and the one required action,
 * pins that to the conversation as a short note, and only then requests the
 * reply. That is what stops gpt-realtime-mini choosing its own priorities.
 *
 * This gateway also owns what only it can see:
 *
 *  - Playback. Twilio `mark`s report how much of each reply the caller has
 *    heard. On barge-in, Twilio's buffer is cleared and the model's memory of
 *    the reply is truncated to what was played.
 *  - Whether caller speech is an interruption. Speech onset stops playback at
 *    once, but the reply is only abandoned if the caller keeps talking. A word
 *    of acknowledgement ("okay", "uh-huh") or a burst of road noise makes the
 *    receptionist pause briefly and carry on where it left off, instead of
 *    starting the sentence again — which callers hear as "it repeats itself".
 *  - Live checks on the model's words: guardrails (prices, arrival times,
 *    dispatch, availability) and the required action (no asking for the phone
 *    number while the location is still vague). A failing reply is stopped
 *    before the caller hears it and the model is redirected, once per turn.
 *  - The caller turn counter, from the audio. Confirmations are checked
 *    against it, so the model cannot confirm on the caller's behalf.
 *  - Silence (counted by the backend), transcript order, token usage, and
 *    how long each reply took to reach the caller.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { CallEventType } from '@towai/shared';

import { CallSessionService } from '../../../call-session/call-session.service';
import { checkReply } from '../../../conversation/guardrails';
import type { IntakeSnapshot } from '../../../conversation/intake';
import type { NextActionPlan } from '../../../conversation/next-action';
import { checkReplyAgainstAction } from '../../../conversation/response-check';
import { BusinessConfigService } from '../../../modules/businesses/business-config.service';
import { SpeechGauge } from '../../audio/speech-gauge';
import { CALL_JUDGE, type CallJudge } from '../../judgment/judgment.interface';
import { OVERLAP_ACKNOWLEDGEMENT_CEILING, OVERLAP_ANSWER_FLOOR } from '../../judgment/typesafe-questions';
import { RealtimeFillerBank } from '../../realtime/filler-bank';
import {
  REALTIME_CONVERSATION_FACTORY,
  type RealtimeConversation,
  type RealtimeConversationFactory,
  type RealtimeResponseSummary,
  type ResponseRequest,
} from '../../realtime/openai-realtime-conversation';
import {
  SAFE_FALLBACK_LINE,
  SELF_TALK_RECOVERY_INSTRUCTIONS,
  SILENCE_CHECK_LINE,
  SILENCE_GOODBYE_INSTRUCTIONS,
  TURN_LIMIT_GOODBYE_INSTRUCTIONS,
  UNCONFIRMED_GOODBYE_INSTRUCTIONS,
  buildActionNote,
  buildReceptionistInstructions,
  exactLineInstructions,
  greetingInstructions,
  guardrailRecoveryInstructions,
  isAskingForTime,
  isBackchannel,
  isPresenceCheck,
  redirectNote,
  renderReadBack,
} from '../../realtime/realtime-instructions';
import { TOOL, createToolExecutor, type ToolExecutor } from '../../realtime/realtime-tools';
import { addResponseUsage, addTranscriptionUsage, emptyUsage, type UsageTotals } from '../../realtime/usage';
import type { MediaSocket } from './media-stream.gateway';
import { StreamGate } from './stream-gate';

export const REALTIME_STREAM_PATH = '/api/telephony/twilio/realtime';

/** Twilio's frames are a few hundred bytes; anything approaching this is not Twilio. */
export const STREAM_MAX_PAYLOAD_BYTES = 64 * 1024;
/** A socket that has not said which call it carries by then is not Twilio's either. */
export const STREAM_START_TIMEOUT_MS = 10_000;

/** Twilio sends 20ms of μ-law per frame: 8000 samples/s × 0.02s = 160 bytes. */
const FRAME_BYTES = 160;
/** μ-law at 8 kHz: 8 bytes per millisecond. */
const BYTES_PER_MS = 8;
/** A playback mark at least this often (100 ms), so "heard" is known finely. */
const MARK_EVERY_BYTES = 800;
/** Silence after the receptionist finishes speaking before it checks in. */
const NO_INPUT_MS = 7_000;
/** The same, once the caller has asked for a moment: "hold on, let me find the exit". */
export const PATIENT_NO_INPUT_MS = 25_000;
/** How long a caller line may wait for its transcription before it is skipped. */
const TRANSCRIPT_WAIT_MS = 8_000;
/** Longest wait for the goodbye to be spoken and played once the call has ended. */
const GOODBYE_LIMIT_MS = 20_000;
/**
 * Voiced caller audio, after speech onset, that makes an interruption real.
 * "Yes, yes" is about 600 ms; a caller taking the floor keeps going past it.
 */
export const BARGE_IN_VOICED_MS = 650;
/** Quiet after a shorter burst that lets the receptionist carry on. */
export const HOLD_RESUME_SILENCE_MS = 300;
/** Longest the receptionist stays paused while the caller's speech is being judged. */
const HOLD_MAX_MS = 1_200;
/** Silence after the caller's turn before a filler line ("Mm-hm.") covers the wait for the reply. */
const FILLER_AFTER_MS = 1_100;
/** Once the caller has heard the rest, how long a brief overlap waits for its words before it is answered anyway. */
const OVERLAP_TRANSCRIPT_WAIT_MS = 1_500;
/** A caller line this long that matches the receptionist's own words is echo, or a transcriber's invention. */
const ECHO_MIN_WORDS = 4;
/**
 * A reply asked of the model that has not started after this long has
 * stalled. On a real call OpenAI took 16 s to start one; the caller waited in
 * silence, was counted as silent themselves, twice, and the call was closed.
 * A stalled reply is covered by a filler line and is never counted as the
 * caller's silence.
 */
export const REPLY_STALL_MS = 5_000;
/** Stalls after which the gateway stops waiting for that reply and treats the line as idle again. */
export const REPLY_STALL_LIMIT = 6;
/** A reply OpenAI reports as failed is asked for again, this many times per caller turn. */
const FAILED_REPLY_RETRIES = 2;
const FAILED_REPLY_RETRY_MS = 1_500;

/** A tool result without the call state, which the note sent with it already carries. */
function withoutState(result: { callId: string; output: unknown }): { callId: string; output: unknown } {
  if (!result.output || typeof result.output !== 'object' || !('state' in result.output)) return result;
  const { state: _state, ...rest } = result.output as Record<string, unknown>;
  return { callId: result.callId, output: rest };
}

/** Replies that end the call are requested with a reason ending in "goodbye". */
const isGoodbye = (reason: string | undefined) => Boolean(reason?.endsWith('goodbye'));

/** Comparable form of a line: case, punctuation and spacing ignored. */
const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** An error as one line for the log. */
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The words of a reply the caller heard, by the share of its audio that played. */
export function heardPortion(text: string, playedBytes: number, sentBytes: number): string {
  if (sentBytes <= 0 || playedBytes <= 0) return '';
  const words = text.trim().split(/\s+/).filter(Boolean);
  const count = Math.floor(words.length * Math.min(1, playedBytes / sentBytes));
  return words.slice(0, count).join(' ');
}

/** The audio of an item the caller has heard, by the playback marks Twilio has echoed. */
const heardMs = (item: Pick<AssistantItem, 'bytesPlayed'>) => Math.round(item.bytesPlayed / BYTES_PER_MS);

/** How a stopped line is marked in the transcript. A reply never played (`stale`) is not a line at all. */
const STOP_MARK: Record<Exclude<StopReason, 'stale'>, string> = {
  interrupted: 'interrupted',
  guardrail: 'stopped',
  redirected: 'stopped',
  hangup: 'call ended',
};

/**
 * The transcript line for a receptionist item, and how much of it the caller
 * heard. The line is everything the model said: audio reaches the caller
 * ahead of the playback marks that measure it, so a reply stopped with "no"
 * audio heard was often heard in part, and once left no line at all.
 * `heard` is the estimate, for judging the reply and for the event trail.
 */
export function transcriptLine(
  item: Pick<AssistantItem, 'text' | 'stopped' | 'bytesPlayed' | 'bytesReceived'>,
): { text: string | null; heard: string } {
  const full = item.text.trim();
  if (!full || item.stopped === 'stale') return { text: null, heard: '' };
  if (!item.stopped) return { text: full, heard: full };
  return { text: `${full} [${STOP_MARK[item.stopped]}]`, heard: heardPortion(full, item.bytesPlayed, item.bytesReceived) };
}

/** Median and maximum of a list of durations. */
export function summarise(values: number[]): { count: number; medianMs: number; maxMs: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)]!, maxMs: sorted[sorted.length - 1]! };
}

interface TwilioMessage {
  event: string;
  streamSid?: string;
  start?: { callSid: string; customParameters?: Record<string, string> };
  media?: { payload: string };
  mark?: { name: string };
}

/**
 * `stale`: a reply that only arrived once the call was ending; the caller never hears it.
 * `hangup`: still playing when the call closed.
 */
type StopReason = 'interrupted' | 'guardrail' | 'redirected' | 'stale' | 'hangup';

/** One assistant message: what was generated, sent to Twilio, and played. */
interface AssistantItem {
  id: string;
  responseId: string | null;
  text: string;
  /** Audio received from the model, kept until the item settles so a pause can be resumed. */
  chunks: Buffer[];
  bytesReceived: number;
  bytesSent: number;
  bytesPlayed: number;
  /** The response that produced it has finished generating. */
  generated: boolean;
  /** Stopped before it finished playing. */
  stopped: StopReason | null;
  /** Its transcript line has been settled. */
  settled: boolean;
  /** Played by the gateway, not spoken by the model: a filler line. Nothing to truncate or check. */
  synthetic: boolean;
}

/** A transcript line held in speaking order until its text is known. */
interface PendingLine {
  speaker: 'customer' | 'ai';
  key: string;
  text: string | null;
  /** For a receptionist line: the words the caller heard, which may be fewer than `text`. */
  heard?: string;
  ready: boolean;
  timer?: NodeJS.Timeout;
  /** For a caller line: the caller turn it was spoken on, from the audio. */
  turn?: number;
}

/** Caller speech began while the receptionist was talking; playback is paused until it is judged. */
interface Hold {
  startedAt: number;
  gauge: SpeechGauge;
  timer: NodeJS.Timeout | null;
  /** Judged brief and playback resumed; the gauge now watches for the caller carrying on after all. */
  resumed: boolean;
  /**
   * The caller had heard nothing of the reply when they spoke: it was still
   * being generated. Then there is nothing to interrupt. Cancelling it would
   * only lengthen the silence they are already reacting to ("Hello?"), so the
   * reply is kept and played once they stop, and their words answered after.
   */
  nothingHeard: boolean;
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

  /** Caller turns so far, counted from committed audio. */
  callerTurn = 0;
  /** A caller turn ended while tools ran; the tool results' reply covers it. */
  turnDuringTools = false;
  /** The required action the current reply must follow. */
  activePlan: NextActionPlan | null = null;
  /** One redirect per caller turn, so a stubborn model cannot loop. */
  redirectedThisTurn = false;

  hold: Hold | null = null;
  /** The last hold ended with playback resumed: the caller turn that commits next was that brief overlap. */
  overlapPending = false;
  /** Brief overlaps waiting for playback to end and their transcript to arrive, before deciding on a reply. */
  readonly deferredTurns: string[] = [];
  deferredTimer: NodeJS.Timeout | null = null;
  /** What the caller said, by item, once transcribed (null if transcription failed). */
  readonly callerText = new Map<string, string | null>();

  /** When the caller's latest turn ended, until the reply to it reaches Twilio. */
  turnEndedAt: number | null = null;
  fillerTimer: NodeJS.Timeout | null = null;
  fillerCounter = 0;
  /** Caller turn end to first reply audio, per turn. */
  readonly latencies: number[] = [];

  /**
   * A reply has been asked of the model and has not started. Until it does,
   * quiet on the line is the receptionist's, not the caller's.
   */
  replyOwed = false;
  stallTimer: NodeJS.Timeout | null = null;
  stalls = 0;
  /** Replies OpenAI reported as failed since the caller's last turn. */
  failedThisTurn = 0;
  retryTimer: NodeJS.Timeout | null = null;

  /** The backend has ended the call; hang up once the goodbye has played. */
  ending = false;
  responsesSinceEnding = 0;
  endTimer: NodeJS.Timeout | null = null;
  /** The model was lost, and this is why. The call ends as a technical failure, not a hang-up. */
  failure: string | null = null;
  /** Replies that started after the call began ending and are not the goodbye. */
  readonly staleResponses = new Set<string>();
  /** What the receptionist has said in reply to each caller turn, as the caller heard it. */
  readonly replies = new Map<number, string>();
  /** Replies that read the details back. If the caller cuts one short, the backend is told how much they heard. */
  readonly readBacks = new Set<string>();

  guardrailTrips = 0;
  /** A configured pricing fact was given to the model, so it may repeat it. */
  pricingAllowed = false;

  readonly usage: UsageTotals = emptyUsage();

  /** Every database operation for this call, strictly in order. */
  ops: Promise<unknown> = Promise.resolve();
  readonly lines: PendingLine[] = [];

  noInputTimer: NodeJS.Timeout | null = null;
  /** The caller's latest line asked for a moment; quiet is given longer before a check-in. */
  patient = false;
  /** Closes a socket that never says which call it carries. */
  startTimer: NodeJS.Timeout | null = null;
  /** Ends the call at the tenant's maximum length. */
  limitTimer: NodeJS.Timeout | null = null;
  closed = false;

  constructor(readonly socket: MediaSocket) {}

  /** Audio the caller has not heard yet: sent and unplayed, or held back. */
  get playing(): boolean {
    for (const item of this.items.values()) {
      if (!item.stopped && (item.bytesPlayed < item.bytesSent || item.bytesSent < item.bytesReceived)) return true;
    }
    return false;
  }

  /** The most recent reply the caller could hear, in full. */
  get lastReplyText(): string {
    let text = '';
    for (const item of this.items.values()) if (!item.stopped && item.text.trim()) text = item.text;
    return text;
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
    // Named explicitly: Nest cannot see a class through `Pick<>`, and without
    // the name it silently injected nothing, so no live call ever heard a filler.
    @Optional() @Inject(RealtimeFillerBank) private readonly fillers?: Pick<RealtimeFillerBank, 'next'>,
    /** Judges words said over the receptionist; without it the word lists below decide. */
    @Optional() @Inject(CALL_JUDGE) private readonly judge?: Pick<CallJudge, 'judgeOverlap'>,
    /**
     * Decides which streams may carry a call. Always present on the running
     * API; the eval harness and the unit tests, which speak for Twilio
     * themselves, run without one.
     */
    @Optional() @Inject(StreamGate) private readonly gate?: Pick<StreamGate, 'admit'>,
  ) {}

  /** Attached from `main.ts` only when VOICE_PIPELINE=chatgpt. */
  attach(httpServer: import('node:http').Server): void {
    this.server = new WebSocketServer({ server: httpServer, path: REALTIME_STREAM_PATH, maxPayload: STREAM_MAX_PAYLOAD_BYTES });
    this.server.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.logger.log(`Realtime voice gateway listening on ${REALTIME_STREAM_PATH}${this.gate ? '' : ' (no stream gate: streams are not checked)'}`);
  }

  handleConnection(socket: MediaSocket, _request?: IncomingMessage): void {
    const session = new RealtimeCallSession(socket);
    session.startTimer = setTimeout(() => {
      session.startTimer = null;
      if (!session.callId && !session.closed) {
        this.logger.warn('A stream said nothing about which call it carries; closing it.');
        socket.close();
      }
    }, STREAM_START_TIMEOUT_MS);

    // Whatever goes wrong with one call's stream costs that call alone. Left
    // uncaught, a rejection here ends the process, and every live call with
    // it: a start for a business that cannot be loaded did exactly that.
    socket.on('message', (raw: Buffer) => {
      this.handleMessage(socket, session, raw.toString()).catch((error: unknown) => this.abandon(session, 'a message', error));
    });
    socket.on('close', () => {
      this.teardown(session).catch((error: unknown) => this.logger.error(`Call ${session.callId}: teardown failed: ${describe(error)}`));
    });
    socket.on('error', (error: Error) => {
      this.logger.error(`Socket error on call ${session.callId}: ${error.message}`);
      this.abandon(session, 'the socket', error);
    });
  }

  /** Something failed that nothing else will recover from: the call's stream is closed, and only that. */
  private abandon(session: RealtimeCallSession, what: string, error: unknown): void {
    this.logger.error(`Call ${session.callId ?? '(not started)'}: ${what} failed, closing the stream: ${describe(error)}`);
    if (session.socket.readyState === session.socket.OPEN) session.socket.close();
    else this.teardown(session).catch(() => undefined);
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

      case 'media': {
        // Twilio sends the audio as base64 text. Anything else is not audio,
        // and turning it into a buffer throws.
        const payload = message.media?.payload;
        if (typeof payload === 'string' && payload) {
          const frame = Buffer.from(payload, 'base64');
          session.conversation?.appendAudio(frame);
          if (session.hold) this.judgeHold(socket, session, frame);
        }
        break;
      }

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
    // One realtime session per stream. A repeated start would open a second
    // OpenAI session for the same call.
    if (session.callId) {
      this.logger.warn(`Ignoring a repeated stream start on call ${session.callId}`);
      return;
    }
    session.streamSid = message.streamSid ?? null;
    const params = message.start?.customParameters ?? {};
    let businessId = params['businessId'] ?? null;
    let callId = params['callId'] ?? null;
    let greeting = params['greeting'] ?? null;
    let callerNumber = params['callerNumber'] || null;

    // Nothing the socket says about itself is taken on trust: the voice
    // webhook signed the ids, and the call record says what was said first.
    if (this.gate) {
      const verdict = await this.gate.admit({
        businessId: businessId ?? undefined,
        callId: callId ?? undefined,
        callSid: message.start?.callSid,
        token: params['token'],
      });
      if (!verdict.ok) {
        this.logger.warn(`Refused a stream for call ${callId ?? '?'}: ${verdict.reason}.`);
        socket.close();
        return;
      }
      ({ businessId, callId, greeting, callerNumber } = verdict.call);
    }

    if (!businessId || !callId) {
      this.logger.error('Realtime stream started without businessId/callId parameters; closing.');
      socket.close();
      return;
    }
    session.businessId = businessId;
    session.callId = callId;
    session.greeting = greeting;
    if (session.startTimer) {
      clearTimeout(session.startTimer);
      session.startTimer = null;
    }

    const config = await this.businessConfig.load(session.businessId);
    // Twilio can hang up while the config loads. A session opened after that
    // would never be closed, and would still ask OpenAI for the greeting.
    if (session.closed) {
      this.logger.warn(`Call ${session.callId} ended before its realtime session opened; not opening one.`);
      return;
    }
    session.instructions = buildReceptionistInstructions({
      facts: config.flow.facts,
      callerNumber,
    });
    // The tenant's maximum call length, set on the dashboard and, until now,
    // never applied by any pipeline.
    if (typeof config.maxCallSeconds === 'number' && config.maxCallSeconds > 0) {
      session.limitTimer = setTimeout(() => this.callTooLong(session, config.maxCallSeconds), config.maxCallSeconds * 1000);
    }
    // The tools act on this call and no other, and confirmations are checked
    // against the caller turns counted here; nothing the model says changes that.
    session.execute = createToolExecutor({
      callSession: this.callSession,
      businessId: session.businessId,
      callId: session.callId,
      callerTurn: () => session.callerTurn,
    });

    session.conversation = this.createConversation({
      label: session.callId,
      instructions: session.instructions,
      // No vocabulary prompt for the transcriber: on the first real call it
      // turned line noise into "Hello, this is Liberty Towing", twice.
      callbacks: {
        onSpeechStarted: () => this.interrupt(socket, session),
        onSpeechStopped: (durationMs) => this.speechStopped(socket, session, durationMs),
        onCallerTurn: (itemId) => this.callerTurn(socket, session, itemId),
        onCallerTranscript: (itemId, text) => this.callerTranscript(session, itemId, text),
        onResponseStarted: (responseId, requested, reason) => {
          session.responding = true;
          session.currentResponseId = responseId;
          this.replyStarted(session);
          if (requested && session.awaitingGreeting) {
            session.awaitingGreeting = false;
            session.greetingResponseId = responseId;
          }
          this.clearNoInputTimer(session);
          if (reason === 'read-back' || session.activePlan?.action === 'CONFIRM_DETAILS') session.readBacks.add(responseId);
          // Asked for before the call began ending, answered only now: on a
          // real call this was a question, played just before the line closed.
          if (session.ending && !isGoodbye(reason)) {
            this.logger.warn(`Call ${session.callId}: dropping a reply (${reason ?? 'not requested'}) that arrived after the call began ending`);
            session.staleResponses.add(responseId);
            session.conversation?.cancelResponse({ keepQueued: true });
            // The goodbye behind it is still owed.
            this.owe(session);
          }
        },
        onAudio: (itemId, chunk) => this.forwardAudio(socket, session, itemId, chunk),
        onSpokenText: (itemId, text) => this.monitorSpeech(socket, session, itemId, text),
        onResponseDone: (response) => this.responseDone(socket, session, response),
        onUsage: ({ kind, usage }) => {
          if (kind === 'response') addResponseUsage(session.usage, usage);
          else addTranscriptionUsage(session.usage, usage);
        },
        onError: (error) => {
          this.logger.error(`Realtime error on call ${session.callId}: ${error.message}`);
          void this.enqueue(session, () => this.recordProviderError(session, 'error', error.message));
        },
        onClose: () => {
          // Without the model the caller would hear only silence. Once the
          // goodbye is under way the loss costs nothing; before that, the call
          // ends as a technical failure: the caller hears an apology, and the
          // towing team gets a callback with the caller's number.
          if (!session.closed && !session.ending) this.fail(session, 'OpenAI realtime session closed mid-call');
          else if (!session.closed) socket.close();
        },
      },
    });

    // The greeting was chosen and stored by the voice webhook. Spoken inside the
    // conversation, so the model knows it has greeted the caller.
    if (session.greeting) {
      session.awaitingGreeting = true;
      this.respond(session, { instructions: greetingInstructions(session.greeting), toolChoice: 'none', reason: 'greeting' });
    }
  }

  /** Asks the model to respond with one-off instructions, keeping the receptionist's own. */
  private respond(session: RealtimeCallSession, request: ResponseRequest = {}): void {
    this.request(session, this.rightNow(session, request));
  }

  /** Asks the model for a reply. From now until it starts, the reply is owed. */
  private request(session: RealtimeCallSession, request: ResponseRequest): void {
    this.owe(session);
    session.conversation?.requestResponse(request);
  }

  /* ------------------------------------------------------------------------ */
  /*  A reply that is owed                                                    */
  /* ------------------------------------------------------------------------ */

  private owe(session: RealtimeCallSession): void {
    if (session.closed) return;
    this.clearNoInputTimer(session);
    if (session.replyOwed) return;
    session.replyOwed = true;
    session.stalls = 0;
    this.armStallTimer(session);
  }

  private replyStarted(session: RealtimeCallSession): void {
    session.replyOwed = false;
    session.stalls = 0;
    if (session.stallTimer) {
      clearTimeout(session.stallTimer);
      session.stallTimer = null;
    }
  }

  private armStallTimer(session: RealtimeCallSession): void {
    if (session.stallTimer) clearTimeout(session.stallTimer);
    session.stallTimer = setTimeout(() => this.replyStalled(session), REPLY_STALL_MS);
  }

  /** The reply has still not started. Cover the wait; give up on it only after a long time. */
  private replyStalled(session: RealtimeCallSession): void {
    session.stallTimer = null;
    if (session.closed || !session.replyOwed) return;
    session.stalls += 1;
    const waited = session.stalls * REPLY_STALL_MS;
    this.logger.warn(`Call ${session.callId}: the reply has not started ${waited}ms after it was asked for`);
    if (session.stalls === 1) {
      void this.enqueue(session, () => this.recordProviderError(session, 'reply_stalled', `No reply had started ${waited}ms after it was requested`));
    }

    if (session.stalls >= REPLY_STALL_LIMIT) {
      // Nothing is coming. A receptionist that cannot speak hands the caller
      // to a person: the call ends as a failure, with an apology and a callback.
      session.replyOwed = false;
      this.fail(session, `No reply from the model ${waited / 1000}s after it was asked for`);
      return;
    }
    this.playFiller(session, true);
    this.armStallTimer(session);
  }

  /** OpenAI gave up on a reply. Ask again, a limited number of times per caller turn. */
  private replyFailed(socket: MediaSocket, session: RealtimeCallSession, response: RealtimeResponseSummary): void {
    session.failedThisTurn += 1;
    const detail = response.failure ?? 'no reason given';
    this.logger.error(`Call ${session.callId}: OpenAI failed a reply (${detail})`);
    void this.enqueue(session, () => this.recordProviderError(session, 'response_failed', detail));

    if (session.closed) return;
    if (session.failedThisTurn > FAILED_REPLY_RETRIES) {
      this.fail(session, `OpenAI failed the reply ${session.failedThisTurn} times (${detail})`);
      return;
    }
    this.owe(session);
    if (session.retryTimer) clearTimeout(session.retryTimer);
    session.retryTimer = setTimeout(() => {
      session.retryTimer = null;
      if (session.closed) return;
      session.conversation?.requestResponse({ reason: session.ending ? 'retry-goodbye' : 'retry' });
    }, FAILED_REPLY_RETRY_MS);
  }

  /** One-off instructions for a single reply, on top of the receptionist's own. */
  private rightNow(session: RealtimeCallSession, request: ResponseRequest): ResponseRequest {
    return {
      ...request,
      instructions: request.instructions ? `${session.instructions}\n\nRIGHT NOW\n${request.instructions}` : undefined,
    };
  }

  /* ------------------------------------------------------------------------ */
  /*  Turns: the backend decides, then the model replies                      */
  /* ------------------------------------------------------------------------ */

  /** The caller's turn ended and its audio is in the conversation. */
  private callerTurn(socket: MediaSocket, session: RealtimeCallSession, itemId: string): void {
    this.expectLine(session, 'customer', itemId);
    session.callerTurn += 1;
    const line = session.lines.find((l) => l.key === itemId);
    if (line) line.turn = session.callerTurn;
    session.redirectedThisTurn = false;
    session.failedThisTurn = 0;
    session.patient = false;
    session.turnEndedAt = Date.now();
    if (session.closed || !session.businessId || !session.callId) return;

    // Speech that ended before the receptionist was cut off was brief.
    if (session.hold) {
      if (!session.hold.resumed) this.endHold(socket, session, 'resume');
      session.hold = null;
    }
    if (session.overlapPending) {
      session.overlapPending = false;
      session.deferredTurns.push(itemId);
      this.answerDeferred(socket, session);
      return;
    }
    this.startTurn(session);
  }

  /**
   * Pin the backend's state and required action to the conversation, then
   * ask for the reply. `overlap` is what the caller said over the receptionist.
   */
  private startTurn(session: RealtimeCallSession, overlap?: string): void {
    if (session.closed || !session.businessId || !session.callId) return;

    // Tool results are about to go back with fresh state; that reply covers this turn.
    if (session.toolsRunning) {
      session.turnDuringTools = true;
      return;
    }

    const { businessId, callId } = session;
    const callerTurn = session.callerTurn;
    // Owed from the moment the caller stops: the backend's state comes first,
    // and the wait for it is the receptionist's silence too.
    this.owe(session);
    this.enqueue(session, () =>
      this.callSession.applyIntakeOperation(businessId, callId, { kind: 'state' }, { callerTurn }),
    )
      .then((result) => {
        // Once the call is ending, only the goodbye is wanted.
        if (session.closed || session.ending) return;
        if (result?.ended) {
          // The backend gave up waiting for a yes to the read-back: the
          // details have gone to the towing team unconfirmed.
          this.beginEnding(session.socket, session);
          this.respond(session, { instructions: UNCONFIRMED_GOODBYE_INSTRUCTIONS, toolChoice: 'none', reason: 'unconfirmed-goodbye' });
          return;
        }
        if (result?.plan) session.activePlan = result.plan;
        const state = result?.output.state as IntakeSnapshot | undefined;
        if (state) session.conversation?.addNote(buildActionNote(state, { beforeSave: true, overlap }), { pinned: true });
        this.request(session, { reason: 'caller-turn' });
        this.armFiller(session);
      })
      .catch((error: unknown) => this.abandon(session, 'the caller turn', error));
  }

  /** The tenant's maximum call length has passed: whatever is saved goes to the towing team, and the call ends. */
  private callTooLong(session: RealtimeCallSession, seconds: number): void {
    session.limitTimer = null;
    if (session.closed || session.ending || !session.businessId || !session.callId) return;
    const { businessId, callId } = session;
    this.logger.warn(`Call ${callId}: reached the limit of ${seconds}s; ending it.`);
    void this.enqueue(session, () =>
      this.callSession.applyIntakeOperation(businessId, callId, { kind: 'end', reason: 'Call reached the maximum length before intake finished.' }),
    ).then((result) => {
      if (!result || session.closed || session.ending) return;
      this.beginEnding(session.socket, session);
      this.respond(session, { instructions: TURN_LIMIT_GOODBYE_INSTRUCTIONS, toolChoice: 'none', reason: 'time-limit-goodbye' });
    });
  }

  /**
   * If the reply has not reached the caller soon after their turn, a short
   * line in the receptionist's voice covers the wait — the way a person says
   * "mm-hm" while writing something down, rather than going silent.
   */
  private armFiller(session: RealtimeCallSession): void {
    if (!this.fillers) return;
    if (session.fillerTimer) clearTimeout(session.fillerTimer);
    session.fillerTimer = setTimeout(() => {
      session.fillerTimer = null;
      this.playFiller(session);
    }, FILLER_AFTER_MS);
  }

  /** `stalled`: the reply is long overdue, so a filler is played whether or not a caller turn is waiting on it. */
  private playFiller(session: RealtimeCallSession, stalled = false): void {
    const socket = session.socket;
    if (session.closed || session.ending || session.playing || session.hold) return;
    if (!stalled && session.turnEndedAt === null) return;
    if (!session.streamSid || socket.readyState !== socket.OPEN) return;
    const filler = this.fillers?.next(stalled ? 'stall' : 'turn');
    if (!filler) return;

    const item: AssistantItem = {
      id: `filler-${++session.fillerCounter}`,
      responseId: 'filler',
      text: filler.text,
      chunks: [filler.audio],
      bytesReceived: filler.audio.length,
      bytesSent: 0,
      bytesPlayed: 0,
      generated: true,
      stopped: null,
      settled: false,
      synthetic: true,
    };
    session.items.set(item.id, item);
    this.expectLine(session, 'ai', item.id);
    this.sendAudio(socket, session, item, filler.audio);
  }

  /**
   * Something brief was said while the receptionist was talking. Once the
   * caller has heard the rest and the words are known: an acknowledgement
   * ("okay", "uh-huh") gets no reply, since replying would repeat the
   * question; anything else — or anything after a question — is answered.
   */
  private answerDeferred(socket: MediaSocket, session: RealtimeCallSession, waited = false): void {
    if (session.deferredTurns.length === 0 || session.closed) return;
    if (session.hold || session.playing || session.responding || session.toolsRunning) return;
    if (!waited && !session.deferredTurns.every((id) => session.callerText.has(id))) {
      // Transcription can lag by seconds. The caller is waiting: answer
      // without the words rather than leave a long silence.
      session.deferredTimer ??= setTimeout(() => {
        session.deferredTimer = null;
        this.answerDeferred(socket, session, true);
      }, OVERLAP_TRANSCRIPT_WAIT_MS);
      return;
    }
    if (session.deferredTimer) {
      clearTimeout(session.deferredTimer);
      session.deferredTimer = null;
    }

    const known = session.deferredTurns.every((id) => session.callerText.has(id));
    const ids = session.deferredTurns.splice(0);
    const said = ids
      .map((id) => session.callerText.get(id))
      .filter((text): text is string => Boolean(text))
      .join(' ')
      .trim();
    if (known && said && this.judge) {
      void this.judgeOverlap(socket, session, said);
      return;
    }
    this.settleOverlap(socket, session, said, known);
  }

  /**
   * The judge reads the words against what the receptionist was saying. A
   * clear answer is answered, a clear acknowledgement is left alone, and
   * anything in between goes to the word lists. If the caller speaks again
   * while the judge is thinking, that turn is the one that gets answered.
   */
  private async judgeOverlap(socket: MediaSocket, session: RealtimeCallSession, said: string): Promise<void> {
    const turnBefore = session.callerTurn;
    let answers: number | null = null;
    try {
      answers = (await this.judge!.judgeOverlap(said, session.lastReplyText))?.overlap?.answers ?? null;
    } catch {
      answers = null;
    }
    if (session.closed || session.callerTurn !== turnBefore) return;

    if (answers !== null && answers >= OVERLAP_ANSWER_FLOOR) {
      this.startTurn(session, said);
    } else if (answers !== null && answers <= OVERLAP_ACKNOWLEDGEMENT_CEILING) {
      this.noReplyNeeded(socket, session, said);
    } else {
      this.settleOverlap(socket, session, said, true);
    }
  }

  /** The word lists: "hello?" and "uh-huh" were settled by hearing the reply; anything else is answered. */
  private settleOverlap(socket: MediaSocket, session: RealtimeCallSession, said: string, known: boolean): void {
    const askedQuestion = /\?\s*$/.test(session.lastReplyText.trim());
    // "Hello?" while the reply was on its way: hearing the reply answered it.
    const settledByReply = isPresenceCheck(said) || (isBackchannel(said) && !askedQuestion);

    if (known && (!said || settledByReply)) {
      this.noReplyNeeded(socket, session, said);
      return;
    }
    this.startTurn(session, said || undefined);
  }

  private noReplyNeeded(socket: MediaSocket, session: RealtimeCallSession, said: string): void {
    this.logger.log(`Call ${session.callId}: caller said "${said || '(nothing clear)'}" over the receptionist; no reply needed`);
    session.turnEndedAt = null;
    this.checkIdle(socket, session);
  }

  /**
   * The receptionist's own words arriving as caller speech: the phone fed its
   * speaker back into its microphone, or the transcriber invented a line. Not
   * something the caller said, so not recorded and not answered.
   */
  private isEcho(session: RealtimeCallSession, text: string): boolean {
    const heard = comparable(text);
    if (heard.split(' ').length < ECHO_MIN_WORDS) return false;
    const own = [session.greeting ?? '', ...[...session.items.values()].map((item) => item.text)]
      .map(comparable)
      .filter(Boolean);
    return own.some((line) => line === heard || line.includes(heard));
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
        chunks: [],
        bytesReceived: 0,
        bytesSent: 0,
        bytesPlayed: 0,
        generated: false,
        stopped: null,
        settled: false,
        synthetic: false,
      };
      session.items.set(itemId, item);
      this.expectLine(session, 'ai', itemId);
      // The caller turn this is said in reply to, so the reply can be judged against that turn's line.
      const line = session.lines.find((l) => l.key === itemId);
      if (line && session.callerTurn > 0) line.turn = session.callerTurn;
    }
    return item;
  }

  /** Part of a reply that arrived after the call began ending. It is dropped unheard. */
  private dropIfStale(session: RealtimeCallSession, item: AssistantItem): boolean {
    if (!item.responseId || !session.staleResponses.has(item.responseId)) return false;
    item.stopped ??= 'stale';
    return true;
  }

  private forwardAudio(socket: MediaSocket, session: RealtimeCallSession, itemId: string, audio: Buffer): void {
    const item = this.item(session, itemId);
    if (this.dropIfStale(session, item)) return;
    item.chunks.push(audio);
    item.bytesReceived += audio.length;
    // Audio still arriving for a stopped reply must not reach the caller.
    if (item.stopped || session.closed || !session.streamSid || socket.readyState !== socket.OPEN) return;
    // Held back while the caller's speech is judged; sent when the hold ends.
    if (session.hold && !session.hold.resumed) return;
    this.sendAudio(socket, session, item, audio);
  }

  /** Sends audio for `item` to Twilio, with marks so playback can be tracked. */
  private sendAudio(socket: MediaSocket, session: RealtimeCallSession, item: AssistantItem, audio: Buffer): void {
    if (audio.length === 0) return;
    if (!item.synthetic && session.turnEndedAt !== null) {
      session.latencies.push(Date.now() - session.turnEndedAt);
      session.turnEndedAt = null;
      // The reply is here: no filler needed for this turn.
      if (session.fillerTimer) {
        clearTimeout(session.fillerTimer);
        session.fillerTimer = null;
      }
    }

    let sinceMark = 0;
    for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
      const frame = audio.subarray(offset, offset + FRAME_BYTES);
      socket.send(
        JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: frame.toString('base64') } }),
      );
      item.bytesSent += frame.length;
      sinceMark += frame.length;
      if (sinceMark >= MARK_EVERY_BYTES) {
        this.mark(socket, session, item);
        sinceMark = 0;
      }
    }
    if (sinceMark > 0) this.mark(socket, session, item);
  }

  /** Twilio echoes each mark when playback reaches it: that is what "heard" means. */
  private mark(socket: MediaSocket, session: RealtimeCallSession, item: AssistantItem): void {
    const name = `p${++session.markCounter}`;
    session.marks.set(name, { itemId: item.id, bytes: item.bytesSent });
    socket.send(JSON.stringify({ event: 'mark', streamSid: session.streamSid, mark: { name } }));
  }

  /** Sends what the caller has not heard yet of `item`, after a pause. */
  private sendUnheard(socket: MediaSocket, session: RealtimeCallSession, item: AssistantItem): void {
    if (item.bytesSent >= item.bytesReceived) return;
    const all = Buffer.concat(item.chunks);
    this.sendAudio(socket, session, item, all.subarray(item.bytesSent));
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
    const stale = session.staleResponses.has(response.id);
    session.responding = false;
    if (session.currentResponseId === response.id) session.currentResponseId = null;
    // Only a reply the caller could hear counts as the goodbye having been said.
    if (session.ending && !stale && response.status !== 'failed') session.responsesSinceEnding += 1;

    for (const item of session.items.values()) {
      if (item.responseId === response.id || item.responseId === null) {
        item.generated = true;
        this.settleItem(session, item);
      }
    }

    if (stale) {
      // Whatever it wanted to save or ask belongs to a call that is over.
      this.checkIdle(socket, session);
      return;
    }
    if (response.status === 'failed') {
      this.replyFailed(socket, session, response);
      return;
    }
    if (response.toolCalls.length > 0) {
      this.runTools(socket, session, response).catch((error: unknown) => this.abandon(session, 'a tool call', error));
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
      let latestState: IntakeSnapshot | undefined;

      for (const call of response.toolCalls) {
        const result = await this.enqueue(session, () => execute(call.name, call.arguments));
        if (!result) {
          results.push({ callId: call.callId, output: { error: 'That could not be saved. Carry on with the caller.' } });
          continue;
        }
        results.push({ callId: call.callId, output: result.output });
        ended ||= result.ended;
        if (result.plan) session.activePlan = result.plan;
        latestState = (result.output.state as IntakeSnapshot | undefined) ?? latestState;
        if (call.name === TOOL.BUSINESS && typeof result.output.fact === 'string' && result.output.fact.startsWith('Pricing')) {
          session.pricingAllowed = true;
        }
      }

      if (ended) this.beginEnding(socket, session);
      session.turnDuringTools = false;
      if (!session.closed) {
        // Anything the model said in the same breath as the tool call, so the
        // reply to the results carries on from it instead of saying it again.
        const alreadySaid = [...session.items.values()]
          .filter((item) => item.responseId === response.id && !item.stopped && item.text.trim())
          .map((item) => item.text.trim())
          .join(' ');
        const note = latestState && !ended ? buildActionNote(latestState, { alreadySaid: alreadySaid || undefined }) : undefined;
        // The read-back is spoken word for word from the backend's summary:
        // it is what the caller is confirming, so the model may not rephrase it.
        const readBack =
          latestState && !ended && latestState.nextAction === 'CONFIRM_DETAILS' && latestState.readBack
            ? this.rightNow(session, {
                instructions: exactLineInstructions(renderReadBack(latestState.readBack)),
                toolChoice: 'none',
                reason: 'read-back',
              })
            : undefined;
        // The reply to a tool that ended the call is the goodbye.
        const request = ended ? { reason: 'tool-results-goodbye' } : readBack;
        // The note carries the state, and is replaced each turn; a copy in
        // every tool result would stay in the conversation for the whole call.
        const lean = note ? results.map((result, i) => (response.toolCalls[i]?.name === TOOL.STATE ? result : withoutState(result))) : results;
        session.conversation?.submitToolResults(lean, note, request);
        this.owe(session);
      }
    } finally {
      session.toolsRunning = false;
    }
  }

  /**
   * The model is lost: it never connected, went away, or has stopped
   * replying. Recorded before the stream closes, so that the webhook Twilio
   * calls next can tell this ending from any other and apologise; then the
   * call is finalised as a technical failure, which always leaves the towing
   * team a callback with the caller's number.
   */
  private fail(session: RealtimeCallSession, why: string): void {
    if (session.closed || session.failure) return;
    session.failure = why;
    this.logger.error(`Call ${session.callId}: ${why}; ending the call.`);
    void this.enqueue(session, () => this.recordProviderError(session, 'fatal', why)).finally(() => {
      if (session.socket.readyState === session.socket.OPEN) session.socket.close();
      else this.teardown(session).catch(() => undefined);
    });
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
  /*  Barge-in and live checks                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * The caller started talking. Playback stops at once so they are not talked
   * over, but the reply is kept until it is clear whether they are taking the
   * floor or just acknowledging. Fires on every speech onset, so it must be cheap.
   */
  private interrupt(socket: MediaSocket, session: RealtimeCallSession): void {
    this.clearNoInputTimer(session);
    if (session.closed || (session.hold && !session.hold.resumed)) return;
    if (!session.playing && !session.responding) return;

    if (session.hold?.timer) clearTimeout(session.hold.timer);
    const nothingHeard = !session.playing;
    if (session.streamSid && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    // Twilio echoes the marks of cleared audio; they must not count as heard.
    session.marks.clear();
    for (const item of session.items.values()) {
      if (!item.stopped && !item.settled) item.bytesSent = item.bytesPlayed;
    }
    session.hold = {
      startedAt: Date.now(),
      gauge: new SpeechGauge(),
      timer: setTimeout(() => this.holdExpired(socket, session), HOLD_MAX_MS),
      resumed: false,
      nothingHeard,
    };
  }

  /** The caller is still talking after the longest pause allowed: decide now. */
  private holdExpired(socket: MediaSocket, session: RealtimeCallSession): void {
    const hold = session.hold;
    if (!hold) return;
    hold.timer = null;
    if (hold.gauge.voicedMs < BARGE_IN_VOICED_MS) this.endHold(socket, session, 'resume');
    else if (!hold.nothingHeard) this.endHold(socket, session, 'interrupt');
    // else: keep holding an unheard reply until the caller's turn ends.
  }

  /** Every frame of caller audio while a hold is on: is this an interruption yet? */
  private judgeHold(socket: MediaSocket, session: RealtimeCallSession, frame: Buffer): void {
    const hold = session.hold;
    if (!hold) return;
    hold.gauge.feed(frame);

    if (hold.gauge.voicedMs >= BARGE_IN_VOICED_MS) {
      if (!hold.nothingHeard) this.endHold(socket, session, 'interrupt');
    } else if (hold.gauge.trailingSilenceMs >= HOLD_RESUME_SILENCE_MS) {
      if (!hold.resumed) this.endHold(socket, session, 'resume');
      // Watching after a resume: a new burst starts from zero, so "Hello.
      // ... Hello." never adds up to an interruption.
      else if (hold.gauge.voicedMs > 0) hold.gauge = new SpeechGauge(hold.gauge.floor);
    }
  }

  /** OpenAI's own verdict on how long the caller spoke, once their turn ends. */
  private speechStopped(socket: MediaSocket, session: RealtimeCallSession, durationMs: number): void {
    const hold = session.hold;
    if (!hold) return;
    if (!hold.resumed) {
      const interrupt = durationMs >= BARGE_IN_VOICED_MS && !hold.nothingHeard;
      this.endHold(socket, session, interrupt ? 'interrupt' : 'resume');
    }
    session.hold = null;
  }

  private endHold(socket: MediaSocket, session: RealtimeCallSession, outcome: 'interrupt' | 'resume'): void {
    const hold = session.hold;
    if (!hold) return;
    if (hold.timer) clearTimeout(hold.timer);
    const holdMs = Date.now() - hold.startedAt;

    if (outcome === 'interrupt') {
      session.hold = null;
      const stopped = this.stopSpeaking(socket, session, 'interrupted');
      if (stopped.length > 0) {
        const cut = stopped[0]!;
        this.logEvent(session, CallEventType.AI_INTERRUPTED, {
          heardMs: heardMs(cut),
          text: cut.text,
          heard: heardPortion(cut.text, cut.bytesPlayed, cut.bytesReceived),
        });
      }
      // A read-back the caller spoke over has not been heard. The backend has
      // it finished once, after what they said is answered; without this it
      // would wait for a yes to details the caller never heard.
      const readBack = stopped.find((item) => item.responseId && session.readBacks.has(item.responseId));
      if (readBack && session.businessId && session.callId) {
        const { businessId, callId } = session;
        const heard = heardPortion(readBack.text, readBack.bytesPlayed, readBack.bytesReceived);
        void this.enqueue(session, () => this.callSession.applyIntakeOperation(businessId, callId, { kind: 'read_back_cut', heard }));
      }
      return;
    }

    // Brief: carry on from where the caller stopped hearing, and keep watching
    // in case they were only drawing breath before taking the floor.
    hold.timer = null;
    hold.resumed = true;
    hold.gauge = new SpeechGauge(hold.gauge.floor);
    session.overlapPending = true;
    let resumedMs = 0;
    for (const item of session.items.values()) {
      if (item.stopped || item.settled) continue;
      resumedMs += (item.bytesReceived - item.bytesSent) / BYTES_PER_MS;
      this.sendUnheard(socket, session, item);
    }
    this.logger.log(`Call ${session.callId}: paused ${holdMs}ms for brief caller speech, resumed ${Math.round(resumedMs)}ms of reply`);
    this.checkIdle(socket, session);
  }

  /**
   * Stops everything not yet heard: the response being generated, Twilio's
   * buffer, and the model's memory of the unheard part.
   */
  private stopSpeaking(socket: MediaSocket, session: RealtimeCallSession, reason: StopReason, only?: AssistantItem): AssistantItem[] {
    if (session.responding) session.conversation?.cancelResponse();

    const stopped: AssistantItem[] = [];
    for (const item of only ? [only] : [...session.items.values()]) {
      if (item.stopped || item.settled) continue;
      item.stopped = reason;
      if (!item.synthetic) session.conversation?.truncate(item.id, item.bytesPlayed / BYTES_PER_MS);
      stopped.push(item);
    }

    if (session.streamSid && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    for (const item of stopped) this.settleItem(session, item);
    return stopped;
  }

  /** The model's words, checked as they are produced. */
  private monitorSpeech(socket: MediaSocket, session: RealtimeCallSession, itemId: string, text: string): void {
    const item = this.item(session, itemId);
    if (this.dropIfStale(session, item)) return;
    if (item.stopped) return;
    item.text = text;

    if (this.checkGuardrails(socket, session, item, text)) return;
    this.checkRequiredAction(socket, session, item, text);
  }

  /** Prices, arrival times, dispatch, availability. True if the reply was stopped. */
  private checkGuardrails(socket: MediaSocket, session: RealtimeCallSession, item: AssistantItem, text: string): boolean {
    const verdict = checkReply(text, { allowPricing: session.pricingAllowed });
    if (verdict.ok) return false;
    // Length is not a safety matter for a free conversation.
    const violations = verdict.violations.filter((v) => v.code !== 'too_long');
    if (violations.length === 0) return false;

    this.stopSpeaking(socket, session, 'guardrail', item);
    session.guardrailTrips += 1;
    const attempt = session.guardrailTrips;
    // Read once stopped: marks for audio discarded by the stop no longer count.
    const heard = heardPortion(text, item.bytesPlayed, item.bytesReceived);

    this.logger.warn(`Call ${session.callId}: stopped a reply that ${violations.map((v) => v.detail).join(', ')}: "${text}"`);
    this.logEvent(session, CallEventType.GUARDRAIL_TRIPPED, {
      pipeline: 'chatgpt',
      violations: violations.map((v) => v.code),
      suppressed: text,
      heard,
      heardMs: heardMs(item),
      attempt,
    });

    // First time, the model recovers in its own words. After that, a fixed line.
    // A goodbye that broke a rule is still the goodbye when it is said again.
    const suffix = session.ending ? '-goodbye' : '';
    if (violations[0]!.code === 'self_talk' && attempt <= 2) {
      // Nothing to retract: the model is told again, and carries on.
      session.conversation?.addNote(SELF_TALK_RECOVERY_INSTRUCTIONS);
      this.request(session, { reason: `self-talk-recovery${suffix}` });
    } else if (attempt === 1) {
      session.conversation?.addNote(guardrailRecoveryInstructions(violations[0]!.detail, heard));
      this.request(session, { reason: `guardrail-recovery${suffix}` });
    } else if (attempt === 2) {
      this.respond(session, {
        instructions: exactLineInstructions(SAFE_FALLBACK_LINE),
        toolChoice: 'none',
        reason: `guardrail-fallback${suffix}`,
      });
    }
    return true;
  }

  /**
   * A question about something the priority engine said must wait — the
   * callback number while the location is still "I-95" — is stopped and the
   * model redirected. Once per caller turn: a second deviation is logged only,
   * so a stubborn model costs a clumsy turn, never a loop.
   */
  private checkRequiredAction(socket: MediaSocket, session: RealtimeCallSession, item: AssistantItem, text: string): void {
    const plan = session.activePlan;
    if (!plan || session.ending) return;

    const check = checkReplyAgainstAction(text, plan);
    if (!check.deviation) return;

    const deviation = check.deviation;
    const redirect = !session.redirectedThisTurn;
    // Stopped first, so what the caller heard is read once nothing more can play.
    if (redirect) {
      session.redirectedThisTurn = true;
      this.stopSpeaking(socket, session, 'redirected', item);
    }
    const heard = redirect ? heardPortion(text, item.bytesPlayed, item.bytesReceived) : null;
    this.logger.warn(`Call ${session.callId}: asked about ${deviation.asked} while ${plan.action} was required: "${deviation.question}"`);
    this.logEvent(session, CallEventType.ACTION_DEVIATION, {
      asked: deviation.asked,
      question: deviation.question,
      required: plan.action,
      redirected: redirect,
      ...(redirect ? { heard, heardMs: heardMs(item) } : {}),
    });
    if (!redirect) return;

    session.conversation?.addNote(redirectNote(deviation.asked, plan, heard ?? ''));
    this.request(session, { reason: 'redirect' });
  }

  /* ------------------------------------------------------------------------ */
  /*  Silence and ending                                                      */
  /* ------------------------------------------------------------------------ */

  /** Nothing is being said or prepared. Wait for the caller, or hang up. */
  private checkIdle(socket: MediaSocket, session: RealtimeCallSession): void {
    if (session.closed || session.responding || session.toolsRunning || session.playing) return;
    // The receptionist owes the caller a reply: the line is not idle, it is waiting on us.
    if (session.replyOwed) return;
    if (session.hold && !session.hold.resumed) return;

    if (session.ending) {
      if (session.responsesSinceEnding > 0) socket.close();
      return;
    }
    if (session.deferredTurns.length > 0) {
      this.answerDeferred(socket, session);
      return;
    }
    this.armNoInputTimer(socket, session);
  }

  private armNoInputTimer(socket: MediaSocket, session: RealtimeCallSession): void {
    this.clearNoInputTimer(session);
    if (session.closed) return;
    // A caller who asked for a moment is doing what they were asked: give
    // them one. Two checks seven seconds apart ended such calls before.
    const wait = session.patient ? PATIENT_NO_INPUT_MS : NO_INPUT_MS;
    session.noInputTimer = setTimeout(() => void this.handleSilence(socket, session), wait);
  }

  private clearNoInputTimer(session: RealtimeCallSession): void {
    if (session.noInputTimer) {
      clearTimeout(session.noInputTimer);
      session.noInputTimer = null;
    }
  }

  private async handleSilence(socket: MediaSocket, session: RealtimeCallSession): Promise<void> {
    if (session.closed || session.responding || session.replyOwed || session.ending || !session.businessId || !session.callId) return;
    const { businessId, callId } = session;
    const turnBefore = session.callerTurn;

    const result = await this.enqueue(session, () =>
      this.callSession.applyIntakeOperation(businessId, callId, { kind: 'silence' }),
    );
    if (!result || session.closed) return;
    // The caller spoke up while the silence was being counted: a check-in now
    // would land on top of their words, or just after the reply to them.
    if (session.callerTurn !== turnBefore || session.hold || session.responding || session.replyOwed || session.playing) return;

    if (result.ended) {
      this.beginEnding(socket, session);
      this.respond(session, { instructions: SILENCE_GOODBYE_INSTRUCTIONS, toolChoice: 'none', reason: 'silence-goodbye' });
    } else {
      this.respond(session, { instructions: exactLineInstructions(SILENCE_CHECK_LINE), toolChoice: 'none', reason: 'silence-check' });
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
      line.timer = setTimeout(() => this.resolveLine(session, key, null, { drop: 'timeout' }), TRANSCRIPT_WAIT_MS);
    }
    session.lines.push(line);
  }

  /**
   * `drop`: why a caller line has no text, recorded so a line missing from
   * the transcript can be accounted for.
   */
  private resolveLine(
    session: RealtimeCallSession,
    key: string,
    text: string | null,
    extra: { heard?: string; drop?: 'timeout' | 'failed' | 'teardown' } = {},
  ): void {
    const line = session.lines.find((l) => l.key === key);
    if (!line || line.ready) return;
    if (line.timer) clearTimeout(line.timer);
    if (line.speaker === 'customer') {
      if (text && this.isEcho(session, text)) {
        this.logger.warn(`Call ${session.callId}: ignoring the receptionist's own words heard back as caller speech: "${text}"`);
        this.logEvent(session, CallEventType.TRANSCRIPT_DROPPED, { speaker: 'customer', reason: 'echo', text, turn: line.turn });
        text = null;
      } else if (!text) {
        this.logEvent(session, CallEventType.TRANSCRIPT_DROPPED, { speaker: 'customer', reason: extra.drop ?? 'failed', turn: line.turn });
      }
    }
    line.text = text;
    if (extra.heard !== undefined) line.heard = extra.heard;
    line.ready = true;
    if (line.speaker === 'customer') {
      session.callerText.set(key, text);
      if (session.deferredTurns.includes(key)) this.answerDeferred(session.socket, session);
      // Their words arrive after their turn, sometimes after the reply has
      // played and the quiet is already being timed: then it is timed again.
      if (text && isAskingForTime(text)) {
        session.patient = true;
        if (session.noInputTimer) this.armNoInputTimer(session.socket, session);
      }
    }
    this.flushLines(session);
  }

  private callerTranscript(session: RealtimeCallSession, itemId: string, text: string | null): void {
    this.expectLine(session, 'customer', itemId);
    this.resolveLine(session, itemId, text);
  }

  /** An assistant line is final once played in full, or once stopped. */
  private settleItem(session: RealtimeCallSession, item: AssistantItem): void {
    if (item.settled) return;
    const playedInFull = item.generated && item.bytesSent >= item.bytesReceived && item.bytesPlayed >= item.bytesSent;
    if (!item.stopped && !playedInFull) return;
    item.settled = true;
    item.chunks.length = 0;

    let { text, heard } = transcriptLine(item);

    // The voice webhook already recorded the greeting it chose.
    const isGreeting = item.responseId !== null && item.responseId === session.greetingResponseId;
    if (isGreeting && !item.stopped && text && session.greeting && comparable(text) === comparable(session.greeting)) {
      text = null;
    }
    this.resolveLine(session, item.id, text, { heard });
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
        // Judged by what the caller heard: a reply stopped before its answer did not answer them.
        const heard = line.heard ?? text;
        if (line.turn !== undefined && heard) {
          // Everything said in reply to that turn so far: a few words, a lookup, then the answer.
          const said = [session.replies.get(line.turn), heard].filter(Boolean).join(' ');
          session.replies.set(line.turn, said);
          void this.judgeReply(session, said, line.turn);
        }
      } else {
        // The line's own turn, so the backend knows whether it is the caller's latest word.
        const turn = line.turn !== undefined ? { callerTurn: line.turn } : {};
        // Judged beside the call: every operation for a call runs in order,
        // and the next reply must not queue behind a judgment of the last line.
        void this.judgeLine(session, text, turn);
        void this.enqueue(session, async () => {
          const result = await this.callSession.applyIntakeOperation(businessId, callId, { kind: 'caller_speech', text }, { ...turn, judge: false });
          // The call has run past its turn limit: close it politely, and
          // hang up in any case once the goodbye has had its chance.
          if (result.ended && !session.ending && !session.closed) {
            this.beginEnding(session.socket, session);
            this.respond(session, {
              instructions: TURN_LIMIT_GOODBYE_INSTRUCTIONS,
              toolChoice: 'none',
              reason: 'turn-limit-goodbye',
            });
          }
        });
      }
    }
  }

  /**
   * Has the judge say whether what was said on a turn answered the caller,
   * where they had asked or complained. The backend reminds the model only of
   * what is known to have gone unanswered.
   */
  private async judgeReply(session: RealtimeCallSession, said: string, callerTurn: number): Promise<void> {
    if (!session.businessId || !session.callId) return;
    const { businessId, callId } = session;
    let judgment: Awaited<ReturnType<CallSessionService['judgeReply']>> = null;
    try {
      judgment = await this.callSession.judgeReply(businessId, callId, said, callerTurn);
    } catch {
      return;
    }
    if (!judgment || session.closed || session.ending) return;
    const op = judgment;
    void this.enqueue(session, () => this.callSession.applyIntakeOperation(businessId, callId, op, { callerTurn }));
  }

  /** Has the judge read a caller line, and folds what it found into the call once it has. */
  private async judgeLine(session: RealtimeCallSession, text: string, turn: { callerTurn?: number }): Promise<void> {
    if (!session.businessId || !session.callId) return;
    const { businessId, callId } = session;
    let judgment: Awaited<ReturnType<CallSessionService['judgeCallerLine']>> = null;
    try {
      judgment = await this.callSession.judgeCallerLine(businessId, callId, text);
    } catch {
      return;
    }
    if (!judgment || session.closed || session.ending) return;
    const op = judgment;
    void this.enqueue(session, () => this.callSession.applyIntakeOperation(businessId, callId, op, turn));
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

  private logEvent(session: RealtimeCallSession, type: CallEventType, payload: Record<string, unknown>): void {
    if (!session.businessId || !session.callId) return;
    const { businessId, callId } = session;
    void this.enqueue(session, () => this.callSession.logCallEvent(businessId, callId, type, payload));
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
    if (session.startTimer) clearTimeout(session.startTimer);
    if (session.limitTimer) clearTimeout(session.limitTimer);
    if (session.endTimer) clearTimeout(session.endTimer);
    if (session.deferredTimer) clearTimeout(session.deferredTimer);
    if (session.fillerTimer) clearTimeout(session.fillerTimer);
    if (session.stallTimer) clearTimeout(session.stallTimer);
    if (session.retryTimer) clearTimeout(session.retryTimer);
    if (session.hold?.timer) clearTimeout(session.hold.timer);
    session.hold = null;
    session.conversation?.close();

    // Record what was said, as far as it was heard, before finalising.
    for (const item of session.items.values()) {
      if (!item.settled && !item.stopped) {
        item.stopped = 'hangup';
        this.settleItem(session, item);
      }
    }
    for (const line of [...session.lines]) {
      if (!line.ready) this.resolveLine(session, line.key, line.text, { drop: 'teardown' });
    }

    if (session.businessId && session.callId) {
      const { businessId, callId } = session;
      const latency = summarise(session.latencies);
      if (latency) {
        this.logger.log(
          `Call ${callId}: reply reached the caller ${latency.medianMs}ms after their turn ended (median of ${latency.count}, max ${latency.maxMs}ms)`,
        );
      }
      if (session.usage.responses > 0) {
        this.logEvent(session, CallEventType.AI_USAGE, {
          model: 'realtime',
          ...session.usage,
          ...(latency ? { replyLatencyMs: latency } : {}),
        });
      }
      // A call that lost its model is a technical failure, and the backend
      // raises a callback for one however little was collected. A hang-up
      // with nothing collected is only an abandoned call.
      const message = session.failure;
      const input = message && !session.ending ? ({ kind: 'PROVIDER_ERROR', message } as const) : ({ kind: 'HANGUP' } as const);
      await this.enqueue(session, () => this.callSession.handleEvent(businessId, callId, input, { phrase: false }));
    }
  }
}
