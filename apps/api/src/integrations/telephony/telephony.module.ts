import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CallSessionService } from '../../call-session/call-session.service';
import { TwilioVoiceController } from './twilio/twilio-voice.controller';
import { TwilioSignatureGuard } from './twilio/twilio-signature.guard';
import { MediaStreamGateway } from './twilio/media-stream.gateway';
import { StreamGate } from './twilio/stream-gate';
import { RealtimeFillerBank } from '../realtime/filler-bank';
import { RealtimeVoiceGateway } from './twilio/realtime-voice.gateway';
import {
  OpenAiRealtimeConversation,
  REALTIME_CONVERSATION_FACTORY,
  type NoiseReduction,
  type RealtimeConversationFactory,
  type TurnDetectionMode,
  type TurnEagerness,
} from '../realtime/openai-realtime-conversation';
import { BusinessesModule } from '../../modules/businesses/businesses.module';
import { SttModule } from '../stt/stt.module';
import { TtsModule } from '../tts/tts.module';

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
    {
      provide: RealtimeFillerBank,
      inject: [REALTIME_CONVERSATION_FACTORY],
      useFactory: (factory: RealtimeConversationFactory) => new RealtimeFillerBank(factory),
    },
    {
      provide: REALTIME_CONVERSATION_FACTORY,
      inject: [ConfigService],
      useFactory:
        (config: ConfigService): RealtimeConversationFactory =>
        ({ instructions, callbacks, label, transcriptionPrompt }) =>
          new OpenAiRealtimeConversation({
            apiKey: config.get<string>('OPENAI_API_KEY') ?? '',
            model: config.get<string>('AI_REALTIME_MODEL', 'gpt-realtime-mini'),
            voice: config.get<string>('AI_REALTIME_VOICE', 'marin'),
            silenceMs: config.get<number>('AI_REALTIME_SILENCE_MS', 900),
            turnDetection: config.get<TurnDetectionMode>('AI_REALTIME_TURN_DETECTION', 'server_vad'),
            eagerness: config.get<TurnEagerness>('AI_REALTIME_VAD_EAGERNESS', 'auto'),
            noiseReduction: config.get<NoiseReduction>('AI_REALTIME_NOISE_REDUCTION', 'near_field'),
            transcriptionModel: config.get<string>('AI_REALTIME_TRANSCRIPTION_MODEL', 'gpt-4o-transcribe'),
            transcriptionPrompt,
            instructions,
            callbacks,
            label,
          }),
    },
  ],
  exports: [MediaStreamGateway, RealtimeVoiceGateway, RealtimeFillerBank],
})
export class TelephonyModule {}
