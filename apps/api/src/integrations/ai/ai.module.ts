/**
 * Selects the AI provider from configuration.
 *
 * The rest of the application depends on the `AI_PROVIDER` token and never on a
 * vendor SDK, so switching vendors is an environment variable rather than a
 * code change. `stub` is the default because it makes the whole pipeline run
 * with no key and no network.
 */

import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AI_PROVIDER, type AiProvider } from './ai-provider.interface';
import { AnthropicAiProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';
import { StubAiProvider } from './stub.provider';

@Global()
@Module({
  providers: [
    {
      provide: AI_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AiProvider => {
        const logger = new Logger('AiProvider');
        const choice = config.get<string>('AI_PROVIDER', 'stub');
        const warn = (message: string, meta?: Record<string, unknown>) =>
          logger.warn(`${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`);

        switch (choice) {
          case 'anthropic':
            logger.log(
              `Using Anthropic (${config.get('AI_ANTHROPIC_RESPONSE_MODEL')})`,
            );
            return new AnthropicAiProvider({
              apiKey: config.getOrThrow<string>('ANTHROPIC_API_KEY'),
              extractionModel: config.get<string>('AI_ANTHROPIC_EXTRACTION_MODEL'),
              responseModel: config.get<string>('AI_ANTHROPIC_RESPONSE_MODEL'),
              onWarning: warn,
            });

          case 'openai': {
            const baseURL = config.get<string>('OPENAI_BASE_URL');
            const extractionModel = config.get<string>('AI_OPENAI_EXTRACTION_MODEL');

            if (baseURL) {
              logger.log(
                `Using an OpenAI-compatible gateway at ${baseURL} ` +
                  `(${config.get('AI_OPENAI_RESPONSE_MODEL')})`,
              );
              // Extraction depends on strict JSON-schema output, and support for
              // that varies by model behind a gateway in a way it does not at
              // OpenAI itself. A model without it returns prose, which fails
              // validation and degrades every call to a callback request.
              logger.warn(
                `Confirm that "${extractionModel}" supports structured outputs ` +
                  '(strict json_schema). Without it, field extraction will fail ' +
                  'on every turn.',
              );
            } else {
              logger.log(`Using OpenAI (${config.get('AI_OPENAI_RESPONSE_MODEL')})`);
            }

            return new OpenAiProvider({
              apiKey: config.getOrThrow<string>('OPENAI_API_KEY'),
              extractionModel,
              responseModel: config.get<string>('AI_OPENAI_RESPONSE_MODEL'),
              ...(baseURL ? { baseURL } : {}),
              // OpenRouter uses these for attribution and its model rankings.
              // Harmless to send elsewhere.
              ...(baseURL?.includes('openrouter.ai')
                ? {
                    defaultHeaders: {
                      'HTTP-Referer': config.get<string>(
                        'PUBLIC_BASE_URL',
                        'http://localhost:3000',
                      ),
                      'X-Title': 'AI Towing Receptionist',
                    },
                  }
                : {}),
              onWarning: warn,
            });
          }

          default:
            logger.warn(
              'Using the stub AI provider: keyword matching, not language ' +
                'understanding. Fine for development and tests, not for real calls.',
            );
            return new StubAiProvider();
        }
      },
    },
  ],
  exports: [AI_PROVIDER],
})
export class AiModule {}
