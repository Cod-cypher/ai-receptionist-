/**
 * Selects the call's judge from configuration.
 *
 * The rules always judge: what the caller is doing with a line, a clear yes
 * or no, the help a described problem calls for, words said over the
 * receptionist, and whether a reply answered the caller. With
 * TYPESAFE_API_KEY set, Jev judges first and the rules fill in whatever it
 * leaves out, or stand in whole when it is slow or down; Jev also judges
 * location precision and danger, which the rules leave to `classifyLocation`
 * and `risk.ts`. The rest of the application depends on the `CALL_JUDGE` token
 * and never on the vendor SDK.
 */

import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CALL_JUDGE, type CallJudge } from './judgment.interface';
import { ResilientJudge } from './resilient.judge';
import { RulesJudge } from './rules.judge';
import { DEFAULT_TIMEOUT_MS, TypeSafeJudge } from './typesafe.judge';

export interface JudgeSettings {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/** Shared by the Nest module and the eval scripts, so both judge the same way. */
export function createCallJudge(settings: JudgeSettings, logger: Pick<Logger, 'log' | 'warn' | 'debug'>): CallJudge {
  if (!settings.apiKey) {
    logger.warn('TYPESAFE_API_KEY not set: the rules judge every caller line, and location precision and danger by rules only.');
    return new RulesJudge();
  }
  const model = settings.model ?? 'jev-latest';
  logger.log(`Using TypeSafe Jev (${model}) to judge first, with the rules filling in and standing in when it is slow or down`);
  const typeSafe = new TypeSafeJudge({
    apiKey: settings.apiKey,
    model,
    timeoutMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onWarning: (message) => logger.warn(message),
    onJudgment: (summary) => logger.debug(`Jev: ${summary}`),
  });
  return new ResilientJudge(typeSafe, new RulesJudge(), { logger });
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
