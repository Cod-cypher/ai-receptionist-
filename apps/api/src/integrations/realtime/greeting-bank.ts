/**
 * The greeting in the call voice, recorded before the call, so it can play
 * the instant the stream starts instead of after the session connects and
 * the model speaks (1.5 to 2.5 s of dead air on a real call).
 *
 * Skeleton: `get` finds nothing until the bank records greetings with the
 * same out-of-band, transcript-checked take logic as the filler bank. Until
 * then the gateway asks the model for the greeting, as it always has.
 */

import { Injectable, Logger } from '@nestjs/common';

import type { Filler } from './filler-bank';
import type { RealtimeConversationFactory } from './openai-realtime-conversation';

@Injectable()
export class GreetingBank {
  private readonly logger = new Logger('RealtimeGreetings');
  private readonly greetings = new Map<string, Filler>();

  constructor(private readonly createConversation: RealtimeConversationFactory) {}

  get size(): number {
    return this.greetings.size;
  }

  /** The recorded greeting for `text`, or null when none is ready: the gateway then plays the model's. */
  get(text: string): Filler | null {
    return this.greetings.get(text) ?? null;
  }

  /** Records every greeting given, in the call voice. Resolves when done or given up. */
  async warmUp(greetings: readonly string[]): Promise<void> {
    if (greetings.length === 0) return;
    this.logger.debug(`Greeting recording not implemented yet: ${greetings.length} greeting(s) will be spoken by the model.`);
    void this.createConversation;
  }
}
