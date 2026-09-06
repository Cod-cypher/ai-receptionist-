import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ElevenLabsTtsProvider } from './elevenlabs.provider';
import { TTS_PROVIDER, type TtsProvider } from './tts-provider.interface';

/** As with STT: only the media-stream pipeline needs this. */
@Global()
@Module({
  providers: [
    {
      provide: TTS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): TtsProvider => {
        const key = config.get<string>('ELEVENLABS_API_KEY');
        if (!key) {
          new Logger('TtsProvider').log(
            'No ELEVENLABS_API_KEY set. Speech synthesis is unavailable, which ' +
              'is expected on the <Gather> pipeline where Twilio speaks.',
          );
          return {
            name: 'unconfigured',
            // eslint-disable-next-line require-yield
            async *stream() {
              throw new Error(
                'ELEVENLABS_API_KEY is required when VOICE_PIPELINE=stream',
              );
            },
          };
        }
        return new ElevenLabsTtsProvider({
          apiKey: key,
          defaultVoiceId: config.get<string>('ELEVENLABS_VOICE_ID') ?? '',
          modelId: config.get<string>('ELEVENLABS_MODEL_ID'),
        });
      },
    },
  ],
  exports: [TTS_PROVIDER],
})
export class TtsModule {}
