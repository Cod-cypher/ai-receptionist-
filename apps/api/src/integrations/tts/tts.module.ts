import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REQUIREMENTS } from '@towai/shared';

import { ElevenLabsTtsProvider } from './elevenlabs.provider';
import { DEFAULT_TTS_INSTRUCTIONS, OpenAiTtsProvider } from './openai-tts.provider';
import { TTS_PROVIDER, type TtsProvider } from './tts-provider.interface';

/**
 * Phrases spoken on nearly every call, word for word. They come from the
 * deterministic reply templates, so they are identical across calls and safe to
 * pre-generate.
 */
const STANDARD_PHRASES = [
  ...REQUIREMENTS.map((r) => r.fallbackPhrasing),
  'No problem. What number is best to reach you on?',
  'Are you still there?',
  "Sorry, I didn't quite get that. Could you say that again?",
  "I'm not able to help with that myself, but I've made a note and someone from the towing team will contact you shortly.",
];

/**
 * Speech synthesis for the media-stream pipeline. (On the <Gather> pipeline
 * Twilio speaks with TWILIO_TTS_VOICE, and none of this is used.)
 *
 * AI_TTS_MODEL selects OpenAI; otherwise ElevenLabs.
 */
@Global()
@Module({
  providers: [
    {
      provide: TTS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): TtsProvider => {
        const logger = new Logger('TtsProvider');
        const openAiModel = config.get<string>('AI_TTS_MODEL');
        const openAiKey = config.get<string>('OPENAI_API_KEY');

        if (openAiModel && openAiKey) {
          const voice = config.get<string>('AI_TTS_VOICE', 'marin');
          logger.log(`Voice: OpenAI ${openAiModel} (${voice})`);
          const provider = new OpenAiTtsProvider({
            apiKey: openAiKey,
            model: openAiModel,
            voice,
            instructions: config.get<string>('AI_TTS_INSTRUCTIONS') ?? DEFAULT_TTS_INSTRUCTIONS,
          });

          // Every call asks these; generate them once at startup, in the
          // background, so no caller waits on synthesis for a standard question.
          if (config.get<string>('VOICE_PIPELINE') === 'stream') {
            void provider.prewarm(STANDARD_PHRASES);
          }
          return provider;
        }

        const elevenLabsKey = config.get<string>('ELEVENLABS_API_KEY');
        if (elevenLabsKey) {
          logger.log('Voice: ElevenLabs');
          return new ElevenLabsTtsProvider({
            apiKey: elevenLabsKey,
            defaultVoiceId: config.get<string>('ELEVENLABS_VOICE_ID') ?? '',
            modelId: config.get<string>('ELEVENLABS_MODEL_ID'),
          });
        }

        return {
          name: 'unconfigured',
          // eslint-disable-next-line require-yield
          async *stream() {
            throw new Error(
              'VOICE_PIPELINE=stream needs AI_TTS_MODEL (with OPENAI_API_KEY) or ELEVENLABS_API_KEY',
            );
          },
        };
      },
    },
  ],
  exports: [TTS_PROVIDER],
})
export class TtsModule {}
