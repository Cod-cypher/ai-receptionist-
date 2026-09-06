/**
 * Twilio Media Streams — the low-latency voice pipeline.
 *
 * Twilio opens a WebSocket and sends 20ms frames of 8 kHz mu-law audio. Those
 * go straight to Deepgram; final transcripts drive a conversation turn; the
 * reply is synthesised by ElevenLabs and sent back as frames on the same
 * socket. No transcoding anywhere: every stage speaks mu-law 8 kHz.
 *
 * The part that makes it feel human is barge-in. When Deepgram reports speech
 * while the receptionist is still talking, three things happen at once:
 *
 *   1. the in-flight model call is aborted
 *   2. synthesis is abandoned mid-sentence
 *   3. Twilio is told to `clear` its playback buffer
 *
 * Without (3) the caller keeps hearing audio Twilio has already buffered, which
 * is the difference between interrupting a person and talking over a recording.
 *
 * This class is transport only. It calls the same `CallSessionService` methods
 * as the `<Gather>` pipeline, and the conversation engine cannot tell which is
 * in use.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
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

/** Twilio sends 20ms of mu-law per frame: 8000 samples/s × 0.02s = 160 bytes. */
const FRAME_BYTES = 160;
/** Silence before the receptionist prompts. */
const NO_INPUT_MS = 7_000;

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

type TwilioMessage =
  | TwilioStartMessage
  | TwilioMediaMessage
  | { event: 'stop' | 'connected' | 'mark' };

/** Everything one live call needs. */
class MediaCallSession {
  streamSid: string | null = null;
  businessId: string | null = null;
  callId: string | null = null;
  voiceId: string | null = null;
  stt: SttSession | null = null;

  /** Aborts model generation and synthesis when the caller interrupts. */
  speaking: AbortController | null = null;
  /** Guards against two turns running at once on a fast interruption. */
  processing = false;
  noInputTimer: NodeJS.Timeout | null = null;
  closed = false;
}

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
  ) {}

  /**
   * Attaches to the HTTP server. Called from `main.ts` only when
   * VOICE_PIPELINE=stream, so the gather-only deployment opens no socket.
   */
  attach(httpServer: import('node:http').Server): void {
    this.server = new WebSocketServer({
      server: httpServer,
      path: '/api/telephony/twilio/media',
    });

    this.server.on('connection', (socket, request) => {
      this.handleConnection(socket, request);
    });

    this.logger.log('Media stream gateway listening on /api/telephony/twilio/media');
  }

  private handleConnection(socket: WebSocket, _request: IncomingMessage): void {
    const session = new MediaCallSession();

    socket.on('message', (raw) => {
      void this.handleMessage(socket, session, raw.toString());
    });

    socket.on('close', () => void this.teardown(session));
    socket.on('error', (error) => {
      this.logger.error(`Socket error on call ${session.callId}: ${error.message}`);
      void this.teardown(session);
    });
  }

  private async handleMessage(
    socket: WebSocket,
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
        const payload = (message as TwilioMediaMessage).media?.payload;
        if (payload && session.stt) {
          session.stt.write(Buffer.from(payload, 'base64'));
        }
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
    socket: WebSocket,
    session: MediaCallSession,
    message: TwilioStartMessage,
  ): Promise<void> {
    session.streamSid = message.streamSid;

    // The TwiML that opened this socket passes the tenant and call along as
    // custom parameters, so routing has already happened.
    const params = message.start.customParameters ?? {};
    session.businessId = params['businessId'] ?? null;
    session.callId = params['callId'] ?? null;

    if (!session.businessId || !session.callId) {
      this.logger.error(
        'Media stream started without businessId/callId parameters; closing.',
      );
      socket.close();
      return;
    }

    const config = await this.businessConfig.load(session.businessId);
    session.voiceId = config.settings?.voiceId ?? null;

    session.stt = await this.stt.open({
      encoding: 'mulaw',
      sampleRate: 8000,
      language: config.settings?.language ?? 'en',
      callbacks: {
        // The caller has started talking. If the receptionist is mid-sentence,
        // stop immediately — this is the whole point of the stream pipeline.
        onSpeechStarted: () => this.interrupt(socket, session),
        onFinalTranscript: (text, confidence) => {
          void this.runTurn(socket, session, text, confidence);
        },
        onError: (error) => {
          this.logger.error(`STT error on call ${session.callId}: ${error.message}`);
        },
      },
    });

    // Speak the greeting the voice webhook already generated and persisted.
    // Without this the caller hears silence until they happen to speak first.
    const greeting = params['greeting'];
    if (greeting) {
      await this.speak(socket, session, greeting);
    }

    this.armNoInputTimer(socket, session);
  }

  /**
   * Barge-in. Cheap and idempotent, because it fires on every detected speech
   * onset whether or not the receptionist happens to be talking.
   */
  private interrupt(socket: WebSocket, session: MediaCallSession): void {
    if (!session.speaking) return;

    session.speaking.abort();
    session.speaking = null;

    // Twilio buffers what it has already received; without this the caller
    // keeps hearing the abandoned sentence.
    if (session.streamSid && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
  }

  private async runTurn(
    socket: WebSocket,
    session: MediaCallSession,
    transcript: string,
    confidence?: number,
  ): Promise<void> {
    if (session.closed || !session.businessId || !session.callId) return;

    // A second final transcript arriving while the first is still being handled
    // would otherwise interleave two turns over one conversation state.
    if (session.processing) return;
    session.processing = true;
    this.clearNoInputTimer(session);

    try {
      const result = await this.callSession.handleUtterance(
        session.businessId,
        session.callId,
        transcript,
        confidence !== undefined ? String(confidence) : undefined,
      );

      if (result.reply) {
        await this.speak(socket, session, result.reply);
      }

      if (result.ended) {
        // Let the closing sentence finish playing before hanging up.
        setTimeout(() => socket.close(), 1_500);
        return;
      }

      this.armNoInputTimer(socket, session);
    } catch (error) {
      this.logger.error(
        `Turn failed on call ${session.callId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    } finally {
      session.processing = false;
    }
  }

  /** Synthesises and streams a reply, abandonable at any point. */
  private async speak(
    socket: WebSocket,
    session: MediaCallSession,
    text: string,
  ): Promise<void> {
    const controller = new AbortController();
    session.speaking = controller;

    try {
      for await (const chunk of this.tts.stream({
        text,
        voiceId: session.voiceId ?? undefined,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted || socket.readyState !== socket.OPEN) return;
        this.sendAudio(socket, session, chunk);
      }
    } catch (error) {
      // An abort is the expected outcome of an interruption, not a failure.
      if (controller.signal.aborted) return;
      this.logger.error(
        `Synthesis failed on call ${session.callId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    } finally {
      if (session.speaking === controller) session.speaking = null;
    }
  }

  /** Splits audio into the 20ms frames Twilio expects. */
  private sendAudio(
    socket: WebSocket,
    session: MediaCallSession,
    audio: Buffer,
  ): void {
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

  private armNoInputTimer(socket: WebSocket, session: MediaCallSession): void {
    this.clearNoInputTimer(session);
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

  private async handleSilence(
    socket: WebSocket,
    session: MediaCallSession,
  ): Promise<void> {
    if (session.closed || !session.businessId || !session.callId) return;

    try {
      const result = await this.callSession.handleEvent(
        session.businessId,
        session.callId,
        { kind: 'SILENCE' },
      );

      if (result.reply) await this.speak(socket, session, result.reply);
      if (result.ended) {
        setTimeout(() => socket.close(), 1_500);
        return;
      }
      this.armNoInputTimer(socket, session);
    } catch (error) {
      this.logger.error(
        `Silence handling failed on call ${session.callId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
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
    session.speaking?.abort();
    session.stt?.close();

    if (session.businessId && session.callId) {
      await this.callSession
        .handleEvent(session.businessId, session.callId, { kind: 'HANGUP' })
        .catch((error) => {
          this.logger.warn(
            `Could not finalise call ${session.callId}: ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
    }
  }
}
