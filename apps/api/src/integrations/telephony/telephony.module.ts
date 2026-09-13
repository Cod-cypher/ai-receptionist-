import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TwilioVoiceController } from './twilio/twilio-voice.controller';
import { TwilioSignatureGuard } from './twilio/twilio-signature.guard';
import { MediaStreamGateway } from './twilio/media-stream.gateway';
import { RealtimeVoiceGateway } from './twilio/realtime-voice.gateway';
import {
  OpenAiRealtimeConversation,
  REALTIME_CONVERSATION_FACTORY,
  type RealtimeConversationFactory,
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
    MediaStreamGateway,
    RealtimeVoiceGateway,
    {
      provide: REALTIME_CONVERSATION_FACTORY,
      inject: [ConfigService],
      useFactory:
        (config: ConfigService): RealtimeConversationFactory =>
        ({ instructions, callbacks }) =>
          new OpenAiRealtimeConversation({
            apiKey: config.get<string>('OPENAI_API_KEY') ?? '',
            model: config.get<string>('AI_REALTIME_MODEL', 'gpt-realtime-mini'),
            voice: config.get<string>('AI_REALTIME_VOICE', 'marin'),
            silenceMs: config.get<number>('AI_REALTIME_SILENCE_MS', 900),
            transcriptionModel: config.get<string>('AI_REALTIME_TRANSCRIPTION_MODEL', 'gpt-4o-mini-transcribe'),
            instructions,
            callbacks,
          }),
    },
  ],
  exports: [MediaStreamGateway, RealtimeVoiceGateway],
})
export class TelephonyModule {}
