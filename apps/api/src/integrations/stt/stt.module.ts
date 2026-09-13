import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DeepgramSttProvider } from './deepgram.provider';
import { OpenAiRealtimeSttProvider } from './openai-realtime-stt.provider';
import { STT_PROVIDER, type SttProvider } from './stt-provider.interface';

/**
 * Speech recognition for the media-stream pipeline. (On the <Gather> pipeline
 * Twilio transcribes, and none of this is used.)
 *
 * AI_TRANSCRIPTION_MODEL selects OpenAI; otherwise Deepgram. With neither
 * configured the provider still exists, so the gateway can be constructed, and
 * throws only if a stream call actually tries to use it.
 */
@Global()
@Module({
  providers: [
    {
      provide: STT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SttProvider => {
        const logger = new Logger('SttProvider');
        const openAiModel = config.get<string>('AI_TRANSCRIPTION_MODEL');
        const openAiKey = config.get<string>('OPENAI_API_KEY');

        if (openAiModel && openAiKey) {
          logger.log(`Speech recognition: OpenAI ${openAiModel}`);
          return new OpenAiRealtimeSttProvider({
            apiKey: openAiKey,
            model: openAiModel,
            silenceMs: config.get<number>('AI_TRANSCRIPTION_SILENCE_MS'),
          });
        }

        const deepgramKey = config.get<string>('DEEPGRAM_API_KEY');
        if (deepgramKey) {
          logger.log(`Speech recognition: Deepgram ${config.get('DEEPGRAM_MODEL')}`);
          return new DeepgramSttProvider({
            apiKey: deepgramKey,
            model: config.get<string>('DEEPGRAM_MODEL'),
          });
        }

        return {
          name: 'unconfigured',
          open: () => {
            throw new Error(
              'VOICE_PIPELINE=stream needs AI_TRANSCRIPTION_MODEL (with OPENAI_API_KEY) or DEEPGRAM_API_KEY',
            );
          },
        };
      },
    },
  ],
  exports: [STT_PROVIDER],
})
export class SttModule {}
