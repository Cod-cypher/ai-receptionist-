/**
 * Selects the call's judge from configuration.
 *
 * With TYPESAFE_API_KEY set, Jev judges location precision and danger; without
 * it, the regex rules that predate Jev decide alone. The rest of the
 * application depends on the `CALL_JUDGE` token and never on the vendor SDK.
 */

import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CALL_JUDGE, type CallJudge } from './judgment.interface';
import { NoopJudge } from './noop.judge';
import { DEFAULT_TIMEOUT_MS, TypeSafeJudge } from './typesafe.judge';

export interface JudgeSettings {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/** Shared by the Nest module and the eval scripts, so both judge the same way. */
export function createCallJudge(settings: JudgeSettings, logger: Pick<Logger, 'log' | 'warn' | 'debug'>): CallJudge {
  if (!settings.apiKey) {
    logger.warn('TYPESAFE_API_KEY not set: location precision and danger are judged by rules only.');
    return new NoopJudge();
  }
  const model = settings.model ?? 'jev-latest';
  logger.log(`Using TypeSafe Jev (${model}) to judge location precision and danger`);
  return new TypeSafeJudge({
    apiKey: settings.apiKey,
    model,
    timeoutMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onWarning: (message) => logger.warn(message),
    onJudgment: (summary) => logger.debug(`Jev: ${summary}`),
  });
}

@Global()
@Module({
  providers: [
    {
      provide: CALL_JUDGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CallJudge =>
        createCallJudge(
          {
            apiKey: config.get<string>('TYPESAFE_API_KEY'),
            model: config.get<string>('TYPESAFE_MODEL'),
            timeoutMs: config.get<number>('TYPESAFE_TIMEOUT_MS'),
          },
          new Logger('CallJudge'),
        ),
    },
  ],
  exports: [CALL_JUDGE],
})
export class JudgmentModule {}
