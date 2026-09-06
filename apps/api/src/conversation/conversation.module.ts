/**
 * Exposes the conversation engine to Nest's container.
 *
 * The engine itself is a plain class with one dependency and no framework
 * imports — that is what keeps it unit-testable without a container. This
 * module is the only place the two worlds meet.
 */

import { Global, Inject, Module } from '@nestjs/common';

import { ConversationEngine } from './conversation-engine';
import { AI_PROVIDER, type AiProvider } from '../integrations/ai/ai-provider.interface';

@Global()
@Module({
  providers: [
    {
      provide: ConversationEngine,
      inject: [AI_PROVIDER],
      useFactory: (ai: AiProvider) => new ConversationEngine(ai),
    },
  ],
  exports: [ConversationEngine],
})
export class ConversationModule {}
