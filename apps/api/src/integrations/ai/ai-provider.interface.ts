/**
 * The seam between the conversation engine and whichever language model is
 * behind it.
 *
 * The interface is deliberately narrow. There is no `decideNextStep`, no
 * `createLead`, no tool surface — the two methods are "tell me what you heard"
 * and "say this in your own words". A provider that wanted to take an action
 * has nowhere to put it.
 */

import type {
  BusinessFacts,
  ConversationState,
  ExtractionResult,
  RequirementId,
  SlotValues,
} from '@towai/shared';

import type { Directive } from '../../conversation/types';

export interface TranscriptTurn {
  speaker: 'ai' | 'customer';
  text: string;
}

export interface UnderstandInput {
  /** What the caller just said, as transcribed. */
  transcript: string;
  /** Where the workflow currently is. Context for interpretation only. */
  state: ConversationState;
  /** What has already been collected, so the model can spot corrections. */
  filledSlots: SlotValues;
  /** The requirement the receptionist last asked about, if any. */
  pendingRequirement: RequirementId | null;
  facts: BusinessFacts;
  /** A short window of the conversation, oldest first. */
  recentTurns: TranscriptTurn[];
  signal?: AbortSignal;
}

export interface GenerateInput {
  /** Already decided by the state machine. The model only chooses words. */
  directive: Directive;
  facts: BusinessFacts;
  recentTurns: TranscriptTurn[];
  customerName?: string;
  /**
   * The deterministic phrasing for this directive. The model is asked to
   * produce something more natural that means exactly the same thing; if it
   * fails or trips a guardrail, this is what gets spoken instead.
   */
  fallbackPhrasing: string;
  signal?: AbortSignal;
}

export interface AiProvider {
  /** Identifier used in logs and call events. */
  readonly name: string;

  /**
   * Extract observations from one caller utterance.
   * Must never throw for a merely unhelpful utterance — return an `unclear`
   * result instead. Throwing is reserved for provider failures.
   */
  understand(input: UnderstandInput): Promise<ExtractionResult>;

  /** Phrase the directive as a short, natural spoken reply. */
  generateResponse(input: GenerateInput): Promise<string>;

  /**
   * Token-by-token variant, so speech synthesis can start before the sentence
   * is finished. Optional: the engine falls back to `generateResponse`.
   */
  streamResponse?(input: GenerateInput): AsyncIterable<string>;
}

/** DI token. */
export const AI_PROVIDER = Symbol('AI_PROVIDER');
