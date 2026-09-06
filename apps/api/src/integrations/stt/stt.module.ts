import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DeepgramSttProvider } from './deepgram.provider';
import { STT_PROVIDER, type SttProvider } from './stt-provider.interface';

/**
 * Speech recognition is only needed by the media-stream pipeline; on the
 * <Gather> pipeline Twilio does it. The provider is still registered either way
 * so the gateway can be constructed, and it throws only if actually used
 * without a key.
 */
@Global()
@Module({
  providers: [
    {
      provide: STT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SttProvider => {
        const key = config.get<string>('DEEPGRAM_API_KEY');
        if (!key) {
          new Logger('SttProvider').log(
            'No DEEPGRAM_API_KEY set. Speech recognition is unavailable, which ' +
              'is expected on the <Gather> pipeline where Twilio transcribes.',
          );
          return {
            name: 'unconfigured',
            open: () => {
              throw new Error(
                'DEEPGRAM_API_KEY is required when VOICE_PIPELINE=stream',
              );
            },
          };
        }
        return new DeepgramSttProvider({
          apiKey: key,
          model: config.get<string>('DEEPGRAM_MODEL'),
        });
      },
    },
  ],
  exports: [STT_PROVIDER],
})
export class SttModule {}
