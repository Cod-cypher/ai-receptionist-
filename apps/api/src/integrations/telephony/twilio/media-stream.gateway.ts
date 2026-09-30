/**
 * Twilio Media Streams — the low-latency voice pipeline.
 *
 * Twilio opens a WebSocket and sends 20ms frames of 8 kHz μ-law audio. Those go
 * to the speech recogniser; final transcripts drive a conversation turn; the
 * reply is synthesised and sent back as frames on the same socket.
 *
 * The part that makes it feel human is barge-in. When the caller starts talking
 * while the receptionist is speaking:
 *
 *   1. synthesis still in progress is abandoned
 *   2. Twilio is told to `clear` the audio it has buffered but not yet played
 *
 * Getting (2) right requires knowing when audio has actually *played*, not when
 * it was sent. Synthesis streams far faster than real time, so a sentence is
 * fully sent while most of it is still waiting in Twilio's buffer. Playback is
 * therefore tracked with Twilio `mark` messages: a mark is sent after each
 * reply, and Twilio echoes it back when playback reaches it. The same signal
 * starts the silence timer, so "are you still there?" can never interrupt the
 * receptionist's own sentence.
 *
 * This class is transport only. It calls the same `CallSessionService` methods
 * as the `<Gather>` pipeline, and the conversation engine cannot tell which is
 * in use.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { CallSessionService } from '../../../call-session/call-session.service';
import { BusinessConfigService } from '../../../modules/businesses/business-config.service';
import {
  STT_PROVIDER,
  type SttProvider,
  type SttSession,
} from '../../stt/stt-provider.interface';
import { TTS_PROVIDER, type TtsProvider } from '../../tts/tts-provider.interface';
import { buildVocabularyHint } from '../../stt/vocabulary-hint';
import { StreamGate } from './stream-gate';

/** Twilio sends 20ms of μ-law per frame: 8000 samples/s × 0.02s = 160 bytes. */
const FRAME_BYTES = 160;
/** Silence after the receptionist finishes speaking before it prompts. */
const NO_INPUT_MS = 7_000;
/** Extra allowance on top of a reply's audio length before giving up on its mark. */
const PLAYBACK_GRACE_MS = 3_000;

interface TwilioStartMessage {
  event: 'start';
  streamSid: string;
  start: {
    callSid: string;
    customParameters?: Record<string, string>;
  };
}

interface TwilioMediaMessage {
  event: 'media';
  media: { payload: string };
}

interface TwilioMarkMessage {
  event: 'mark';
  mark: { name: string };
}

type TwilioMessage =
  | TwilioStartMessage
  | TwilioMediaMessage
  | TwilioMarkMessage
  | { event: 'stop' | 'connected' | 'dtmf' };

/** Everything one live call needs. */
class MediaCallSession {
  streamSid: string | null = null;
  businessId: string | null = null;
  callId: string | null = null;
  voiceId: string | null = null;
  stt: SttSession | null = null;

  /** Aborts synthesis still in progress when the caller interrupts. */
  synthesis: AbortController | null = null;
  /** Marks sent but not yet echoed: audio Twilio has not finished playing. */
  readonly pendingMarks = new Map<string, () => void>();
  markCounter = 0;

  /** A turn is being processed; transcripts arriving meanwhile wait here. */
  processing = false;
  readonly queuedTranscripts: string[] = [];

  noInputTimer: NodeJS.Timeout | null = null;
  closed = false;

  get isSpeaking(): boolean {
    return this.synthesis !== null || this.pendingMarks.size > 0;
  }
}

/** The subset of `ws` this gateway uses, so tests can drive it with a fake socket. */
export type MediaSocket = Pick<WebSocket, 'send' | 'close' | 'on' | 'readyState' | 'OPEN'>;

@Injectable()
export class MediaStreamGateway {
  private readonly logger = new Logger('MediaStream');
  private server: WebSocketServer | null = null;

  constructor(
    private readonly callSession: CallSessionService,
    private readonly businessConfig: BusinessConfigService,
    private readonly config: ConfigService,
    @Inject(STT_PROVIDER) private readonly stt: SttProvider,
    @Inject(TTS_PROVIDER) private readonly tts: TtsProvider,
    /** Decides which streams may carry a call. Always present on the running API; the unit tests run without one. */
    @Optional() @Inject(StreamGate) private readonly gate?: Pick<StreamGate, 'admit'>,
  ) {}

  /**
   * Attaches to the HTTP server. Called from `main.ts` only when
   * VOICE_PIPELINE=stream, so the gather-only deployment opens no socket.
   */
  attach(httpServer: import('node:http').Server): void {
    this.server = new WebSocketServer({
      server: httpServer,
      path: '/api/telephony/twilio/media',
      // Twilio's frames are a few hundred bytes; anything approaching this is not Twilio.
      maxPayload: 64 * 1024,
    });

    this.server.on('connection', (socket, request) => {
      this.handleConnection(socket, request);
    });

    this.logger.log(
      `Media stream gateway listening on /api/telephony/twilio/media ` +
        `(recognition: ${this.stt.name}, voice: ${this.tts.name})`,
    );
  }

  handleConnection(socket: MediaSocket, _request?: IncomingMessage): void {
    const session = new MediaCallSession();

    // Whatever goes wrong with one call's stream costs that call alone. Left
    // uncaught, a rejection here ends the process, and every live call with it.
    socket.on('message', (raw: Buffer) => {
      this.handleMessage(socket, session, raw.toString()).catch((error: unknown) => {
        this.logger.error(
          `Call ${session.callId ?? '(not started)'}: a message failed, closing the stream: ${
            error instanceof Error ? error.message : error
          }`,
        );
        if (socket.readyState === socket.OPEN) socket.close();
        else void this.teardown(session);
      });
    });

    socket.on('close', () => void this.teardown(session));
    socket.on('error', (error: Error) => {
      this.logger.error(`Socket error on call ${session.callId}: ${error.message}`);
      void this.teardown(session);
    });
  }

  private async handleMessage(
    socket: MediaSocket,
    session: MediaCallSession,
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
        await this.handleStart(socket, session, message as TwilioStartMessage);
        break;

      case 'media': {
        // Twilio sends the audio as base64 text. Anything else is not audio,
        // and turning it into a buffer throws.
        const payload = (message as TwilioMediaMessage).media?.payload;
        if (typeof payload === 'string' && payload && session.stt) {
          session.stt.write(Buffer.from(payload, 'base64'));
        }
        break;
      }

      case 'mark': {
        // Twilio has finished playing up to this point (or discarded it on clear).
        const name = (message as TwilioMarkMessage).mark?.name;
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
    session: MediaCallSession,
    message: TwilioStartMessage,
  ): Promise<void> {
    session.streamSid = message.streamSid;

    // The TwiML that opened this socket passes the tenant and call along as
    // custom parameters, so routing has already happened. Nothing the socket
    // says about itself is taken on trust: the voice webhook signed the ids.
    const params = message.start?.customParameters ?? {};
    let businessId = params['businessId'] ?? null;
    let callId = params['callId'] ?? null;
    let greeting = params['greeting'] ?? null;
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
      ({ businessId, callId, greeting } = verdict.call);
    }

    if (!businessId || !callId) {
      this.logger.error('Media stream started without businessId/callId parameters; closing.');
      socket.close();
      return;
    }
    session.businessId = businessId;
    session.callId = callId;

    const config = await this.businessConfig.load(session.businessId);
    session.voiceId = config.settings?.voiceId ?? null;

    try {
      session.stt = await this.stt.open({
        encoding: 'mulaw',
        sampleRate: 8000,
        language: config.settings?.language ?? 'en',
        vocabularyHint: buildVocabularyHint(config.flow.facts),
        callbacks: {
          // The caller has started talking. If the receptionist is mid-sentence,
          // stop — this is the whole point of the stream pipeline.
          onSpeechStarted: () => this.interrupt(socket, session),
          onFinalTranscript: (text, confidence) => {
            void this.runTurn(socket, session, text, confidence);
          },
          onError: (error) => {
            this.logger.error(`Recognition error on call ${session.callId}: ${error.message}`);
          },
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not start speech recognition on call ${session.callId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }

    // Speak the greeting the voice webhook already generated and persisted.
    // Without this the caller hears silence until they happen to speak first.
    if (greeting) await this.speak(socket, session, greeting);

    this.armNoInputTimer(socket, session);
  }

  /**
   * Barge-in. Fires on every detected speech onset, so it must be cheap and do
   * nothing when the receptionist is not speaking.
   */
  private interrupt(socket: MediaSocket, session: MediaCallSession): void {
    this.clearNoInputTimer(session);
    if (!session.isSpeaking) return;

    session.synthesis?.abort();
    session.synthesis = null;

    if (session.streamSid && socket.readyState === socket.OPEN) {
      // Discards whatever Twilio has buffered but not yet played.
      socket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }

    // Twilio echoes the discarded marks, but nothing should wait on that.
    for (const done of session.pendingMarks.values()) done();
    session.pendingMarks.clear();
  }

  private async runTurn(
    socket: MediaSocket,
    session: MediaCallSession,
    transcript: string,
    confidence?: number,
  ): Promise<void> {
    if (session.closed || !session.businessId || !session.callId) return;

    // A caller who keeps talking while a reply is being prepared must not lose
    // those words, and two turns must not run over one conversation state at
    // once. Queue it, and handle it as soon as the current turn finishes.
    if (session.processing) {
      session.queuedTranscripts.push(transcript);
      return;
    }

    session.processing = true;
    this.clearNoInputTimer(session);

    try {
      const result = await this.callSession.handleUtterance(
        session.businessId,
        session.callId,
        transcript,
        confidence !== undefined ? String(confidence) : undefined,
      );

      if (result.reply) await this.speak(socket, session, result.reply);

      if (result.ended) {
        // speak() has already waited for the goodbye to finish playing.
        socket.close();
        return;
      }

      if (session.queuedTranscripts.length === 0) this.armNoInputTimer(socket, session);
    } catch (error) {
      this.logger.error(
        `Turn failed on call ${session.callId}: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      session.processing = false;
    }

    if (session.queuedTranscripts.length > 0 && !session.closed) {
      const next = session.queuedTranscripts.splice(0).join(' ');
      await this.runTurn(socket, session, next);
    }
  }

  /**
   * Synthesises a reply and resolves when the caller has *heard* it — or when it
   * was interrupted, or the call ended.
   */
  private async speak(socket: MediaSocket, session: MediaCallSession, text: string): Promise<void> {
    const controller = new AbortController();
    session.synthesis = controller;
    let bytesSent = 0;

    try {
      for await (const chunk of this.tts.stream({
        text,
        voiceId: session.voiceId ?? undefined,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted || socket.readyState !== socket.OPEN) return;
        this.sendAudio(socket, session, chunk);
        bytesSent += chunk.length;
      }
    } catch (error) {
      // An abort is the expected outcome of an interruption, not a failure.
      if (controller.signal.aborted) return;
      this.logger.error(
        `Synthesis failed on call ${session.callId}: ${error instanceof Error ? error.message : error}`,
      );
      return;
    } finally {
      if (session.synthesis === controller) session.synthesis = null;
    }

    if (bytesSent === 0 || !session.streamSid || socket.readyState !== socket.OPEN) return;

    // Everything is sent; now wait for Twilio to report it has been played.
    const name = `reply-${++session.markCounter}`;
    const audioMs = (bytesSent / 8000) * 1000;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        session.pendingMarks.delete(name);
        resolve();
      }, audioMs + PLAYBACK_GRACE_MS);

      session.pendingMarks.set(name, () => {
        clearTimeout(timer);
        resolve();
      });

      socket.send(
        JSON.stringify({ event: 'mark', streamSid: session.streamSid, mark: { name } }),
      );
    });
  }

  /** Splits audio into the 20ms frames Twilio expects. */
  private sendAudio(socket: MediaSocket, session: MediaCallSession, audio: Buffer): void {
    if (!session.streamSid) return;

    for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
      const frame = audio.subarray(offset, offset + FRAME_BYTES);
      socket.send(
        JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: { payload: frame.toString('base64') },
        }),
      );
    }
  }

  private armNoInputTimer(socket: MediaSocket, session: MediaCallSession): void {
    this.clearNoInputTimer(session);
    if (session.closed) return;
    session.noInputTimer = setTimeout(() => {
      void this.handleSilence(socket, session);
    }, NO_INPUT_MS);
  }

  private clearNoInputTimer(session: MediaCallSession): void {
    if (session.noInputTimer) {
      clearTimeout(session.noInputTimer);
      session.noInputTimer = null;
    }
  }

  private async handleSilence(socket: MediaSocket, session: MediaCallSession): Promise<void> {
    if (session.closed || session.processing || !session.businessId || !session.callId) return;

    session.processing = true;
    try {
      const result = await this.callSession.handleEvent(session.businessId, session.callId, {
        kind: 'SILENCE',
      });

      if (result.reply) await this.speak(socket, session, result.reply);
      if (result.ended) {
        socket.close();
        return;
      }
      this.armNoInputTimer(socket, session);
    } catch (error) {
      this.logger.error(
        `Silence handling failed on call ${session.callId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    } finally {
      session.processing = false;
    }
  }

  /**
   * The caller is gone. Finalising through the state machine is what turns a
   * complete-but-unconfirmed intake into a lead rather than an abandoned call.
   */
  private async teardown(session: MediaCallSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;

    this.clearNoInputTimer(session);
    session.synthesis?.abort();
    for (const done of session.pendingMarks.values()) done();
    session.pendingMarks.clear();
    session.stt?.close();

    if (session.businessId && session.callId) {
      await this.callSession
        .handleEvent(session.businessId, session.callId, { kind: 'HANGUP' })
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
