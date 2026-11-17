import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CallSessionService } from '../../call-session/call-session.service';
import { TwilioVoiceController } from './twilio/twilio-voice.controller';
import { TwilioSignatureGuard } from './twilio/twilio-signature.guard';
import { MediaStreamGateway } from './twilio/media-stream.gateway';
import { StreamGate } from './twilio/stream-gate';
import { RealtimeFillerBank } from '../realtime/filler-bank';
import { GreetingBank } from '../realtime/greeting-bank';
import { REALTIME_LIVE_WORDS, createLiveWordsProvider } from '../realtime/live-words';
import { RealtimeVoiceGateway } from './twilio/realtime-voice.gateway';
import {
  OpenAiRealtimeConversation,
  REALTIME_CONVERSATION_FACTORY,
  readReasoningEffort,
  shutdownWarning,
  type NoiseReduction,
  type RealtimeConversationFactory,
  type TurnDetectionMode,
  type TurnEagerness,
} from '../realtime/openai-realtime-conversation';
import { BusinessesModule } from '../../modules/businesses/businesses.module';
import { SttModule } from '../stt/stt.module';
import { TtsModule } from '../tts/tts.module';

/**
 * AI_REALTIME_SPEED as OpenAI accepts it, 0.25 to 1.5, or undefined for its
 * default of 1. Anything else is left out rather than sent: OpenAI would
 * refuse the session settings, and every call with them.
 */
function realtimeSpeed(value: unknown): number | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined;
  const speed = Number(value);
  if (Number.isFinite(speed) && speed >= 0.25 && speed <= 1.5) return speed;
  new Logger('TelephonyModule').warn(`AI_REALTIME_SPEED=${String(value)} is not a speed from 0.25 to 1.5; using the default.`);
  return undefined;
}

/**
 * Telephony transport.
 *
 * Every pipeline is registered; VOICE_PIPELINE decides which TwiML the voice
 * webhook returns, and `main.ts` attaches only the WebSocket gateway that
 * pipeline uses. None is visible to the conversation engine.
 */
@Module({
  imports: [BusinessesModule, SttModule, TtsModule],
  controllers: [TwilioVoiceController],
  providers: [
    TwilioSignatureGuard,
    {
      provide: StreamGate,
      inject: [ConfigService, CallSessionService],
      useFactory: (config: ConfigService, callSession: CallSessionService) => new StreamGate(config, callSession),
    },
    MediaStreamGateway,
    RealtimeVoiceGateway,
    // Both banks are built by explicit factories: a constructor parameter typed
    // as a function or a `Pick<>` is not a class, and Nest silently injects
    // nothing for it (live calls once ran without fillers that way).
    {
      provide: RealtimeFillerBank,
      inject: [REALTIME_CONVERSATION_FACTORY],
      useFactory: (factory: RealtimeConversationFactory) => new RealtimeFillerBank(factory),
    },
    {
      provide: GreetingBank,
      inject: [REALTIME_CONVERSATION_FACTORY, ConfigService],
      useFactory: (factory: RealtimeConversationFactory, config: ConfigService) =>
        new GreetingBank(factory, config.get<string>('AI_REALTIME_VOICE', 'marin')),
    },
    {
      // The streaming transcriber that listens beside each call, or null:
      // with it the caller's words are known as their turn ends.
      provide: REALTIME_LIVE_WORDS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>('VOICE_PIPELINE') !== 'chatgpt') return null;
        const provider = createLiveWordsProvider({
          setting: config.get<string>('AI_REALTIME_LIVE_WORDS'),
          deepgramApiKey: config.get<string>('DEEPGRAM_API_KEY'),
          deepgramModel: config.get<string>('DEEPGRAM_MODEL'),
        });
        if (provider) new Logger('TelephonyModule').log(`The caller's words are read live by ${provider.name}; the first reply does not wait for the transcript.`);
        return provider;
      },
    },
    {
      provide: REALTIME_CONVERSATION_FACTORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RealtimeConversationFactory => {
        // Read once: the recorded fillers and greetings are made through this
        // factory too, so they play at the speed of the calls they are played on.
        const speed = realtimeSpeed(config.get<unknown>('AI_REALTIME_SPEED'));
        const model = config.get<string>('AI_REALTIME_MODEL', 'gpt-realtime-mini');
        const transcriptionModel = config.get<string>('AI_REALTIME_TRANSCRIPTION_MODEL', 'gpt-4o-transcribe');
        const reasoningEffort = readReasoningEffort(config.get<unknown>('AI_REALTIME_REASONING_EFFORT'));
        // Once, at start-up, while there is still time to change the setting:
        // from its shutdown day a model takes no calls at all. Only where
        // these models take the calls; the other pipelines never open a session.
        if (config.get<string>('VOICE_PIPELINE') === 'chatgpt') {
          const warnings = [
            shutdownWarning('AI_REALTIME_MODEL', model),
            shutdownWarning('AI_REALTIME_TRANSCRIPTION_MODEL', transcriptionModel),
          ];
          for (const warning of warnings) if (warning) new Logger('TelephonyModule').warn(warning);
        }
        return ({ instructions, callbacks, label, transcriptionPrompt }) =>
          new OpenAiRealtimeConversation({
            apiKey: config.get<string>('OPENAI_API_KEY') ?? '',
            model,
            voice: config.get<string>('AI_REALTIME_VOICE', 'marin'),
            silenceMs: config.get<number>('AI_REALTIME_SILENCE_MS', 900),
            turnDetection: config.get<TurnDetectionMode>('AI_REALTIME_TURN_DETECTION', 'server_vad'),
            eagerness: config.get<TurnEagerness>('AI_REALTIME_VAD_EAGERNESS', 'auto'),
            noiseReduction: config.get<NoiseReduction>('AI_REALTIME_NOISE_REDUCTION', 'near_field'),
            speed,
            reasoningEffort,
            transcriptionModel,
            transcriptionPrompt,
            instructions,
            callbacks,
            label,
          });
      },
    },
  ],
  exports: [MediaStreamGateway, RealtimeVoiceGateway, RealtimeFillerBank, GreetingBank],
})
export class TelephonyModule {}
