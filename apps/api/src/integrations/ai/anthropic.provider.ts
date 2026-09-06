/**
 * Claude adapter.
 *
 * Two calls per turn, deliberately split:
 *
 *   understand()       structured output, no prose — the model reports what it
 *                      heard and has no field in which to propose an action
 *   generateResponse() prose only — the directive is already decided
 *
 * Both run at `effort: 'low'`. This is a telephone call: a caller waiting in
 * silence on a hard shoulder notices 800ms, and neither task is hard enough to
 * repay deeper reasoning. Adaptive thinking stays on (the default on Opus 5)
 * rather than being disabled, which is the documented way to trade depth for
 * latency without the failure modes that disabling brings.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  EMPTY_EXTRACTION,
  EXTRACTION_JSON_SCHEMA,
  parseExtraction,
  type ExtractionResult,
} from '@towai/shared';

import {
  buildExtractionSystemPrompt,
  buildGenerationSystemPrompt,
  buildGenerationUserPrompt,
} from '../../conversation/prompt-builder';
import type {
  AiProvider,
  GenerateInput,
  UnderstandInput,
} from './ai-provider.interface';

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Defaults to the current Opus model; overridable per deployment. */
  extractionModel?: string;
  responseModel?: string;
  /** Logger hook, so a provider hiccup is visible without coupling to Nest. */
  onWarning?: (message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Extraction returns a small fixed object, and the reply is one or two
 * sentences. Both budgets sit well above what the task needs so a turn is never
 * truncated mid-sentence, while leaving room for adaptive thinking.
 */
const EXTRACTION_MAX_TOKENS = 4096;
const RESPONSE_MAX_TOKENS = 2048;

export class AnthropicAiProvider implements AiProvider {
  readonly name = 'anthropic';

  private readonly client: Anthropic;
  private readonly extractionModel: string;
  private readonly responseModel: string;
  private readonly warn: (message: string, meta?: Record<string, unknown>) => void;

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.extractionModel = options.extractionModel ?? DEFAULT_MODEL;
    this.responseModel = options.responseModel ?? DEFAULT_MODEL;
    this.warn = options.onWarning ?? (() => {});
  }

  async understand(input: UnderstandInput): Promise<ExtractionResult> {
    const response = await this.client.messages.create(
      {
        model: this.extractionModel,
        max_tokens: EXTRACTION_MAX_TOKENS,
        system: buildExtractionSystemPrompt({
          facts: input.facts,
          filledSlots: input.filledSlots,
          pendingRequirement: input.pendingRequirement,
          recentTurns: input.recentTurns,
        }),
        output_config: {
          effort: 'low',
          format: {
            type: 'json_schema',
            schema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        messages: [
          {
            role: 'user',
            content: `The caller just said:

"${input.transcript}"`,
          },
        ],
      },
      { signal: input.signal },
    );

    // A safety refusal on a towing intake would be surprising, but treating it
    // as "nothing understood" keeps the caller in a working conversation rather
    // than dropping them into the error path.
    if (response.stop_reason === 'refusal') {
      this.warn('extraction refused', {
        category: response.stop_details?.category ?? null,
      });
      return EMPTY_EXTRACTION;
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Structured outputs guarantee the shape, but the result is still parsed
    // and validated: a schema the provider ignored must fail loudly here rather
    // than quietly become conversation state.
    return parseExtraction(JSON.parse(text));
  }

  async generateResponse(input: GenerateInput): Promise<string> {
    const stream = this.client.messages.stream(
      {
        model: this.responseModel,
        max_tokens: RESPONSE_MAX_TOKENS,
        system: buildGenerationSystemPrompt({
          facts: input.facts,
          recentTurns: input.recentTurns,
          customerName: input.customerName,
        }),
        output_config: { effort: 'low' },
        messages: [
          {
            role: 'user',
            content: buildGenerationUserPrompt(input.directive, input.fallbackPhrasing),
          },
        ],
      },
      { signal: input.signal },
    );

    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      this.warn('generation refused', {
        category: message.stop_details?.category ?? null,
      });
      // Empty string makes the engine speak its deterministic template.
      return '';
    }

    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }

  /**
   * Token-level streaming, so speech synthesis can begin on the first clause
   * instead of waiting for the full sentence. This is most of the perceived
   * latency win on the media-stream path.
   */
  async *streamResponse(input: GenerateInput): AsyncIterable<string> {
    const stream = this.client.messages.stream(
      {
        model: this.responseModel,
        max_tokens: RESPONSE_MAX_TOKENS,
        system: buildGenerationSystemPrompt({
          facts: input.facts,
          recentTurns: input.recentTurns,
          customerName: input.customerName,
        }),
        output_config: { effort: 'low' },
        messages: [
          {
            role: 'user',
            content: buildGenerationUserPrompt(input.directive, input.fallbackPhrasing),
          },
        ],
      },
      { signal: input.signal },
    );

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta' &&
        event.delta.text.length > 0
      ) {
        yield event.delta.text;
      }
    }
  }
}
