/**
 * OpenAI adapter.
 *
 * Same two-call shape as the Claude adapter and the same prompts, so switching
 * `AI_PROVIDER` changes the vendor and nothing else about the receptionist's
 * behaviour. The engine, the state machine and the guardrails are untouched by
 * which of these is loaded.
 *
 * Note the schema conversion: OpenAI's strict JSON-schema mode requires every
 * property to be listed in `required` and forbids optional keys, which is why
 * the shared extraction schema is defined as required-and-nullable throughout.
 * One schema, both vendors, no per-provider drift in what gets extracted.
 */

import OpenAI from 'openai';
import {
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

export interface OpenAiProviderOptions {
  apiKey: string;
  extractionModel?: string;
  responseModel?: string;
  baseURL?: string;
  onWarning?: (message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_MODEL = 'gpt-4o';

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  private readonly client: OpenAI;
  private readonly extractionModel: string;
  private readonly responseModel: string;
  private readonly warn: (message: string, meta?: Record<string, unknown>) => void;

  constructor(options: OpenAiProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.extractionModel = options.extractionModel ?? DEFAULT_MODEL;
    this.responseModel = options.responseModel ?? DEFAULT_MODEL;
    this.warn = options.onWarning ?? (() => {});
  }

  async understand(input: UnderstandInput): Promise<ExtractionResult> {
    const completion = await this.client.chat.completions.create(
      {
        model: this.extractionModel,
        // Extraction is a reporting task, not a creative one.
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: buildExtractionSystemPrompt({
              facts: input.facts,
              filledSlots: input.filledSlots,
              pendingRequirement: input.pendingRequirement,
              recentTurns: input.recentTurns,
            }),
          },
          {
            role: 'user',
            content: `The caller just said:

"${input.transcript}"`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'extraction',
            strict: true,
            schema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
          },
        },
      },
      { signal: input.signal },
    );

    const message = completion.choices[0]?.message;

    if (message?.refusal) {
      this.warn('extraction refused', { refusal: message.refusal });
      throw new Error(`OpenAI refused the extraction: ${message.refusal}`);
    }

    if (!message?.content) {
      throw new Error('OpenAI returned no extraction content');
    }

    return parseExtraction(JSON.parse(message.content));
  }

  async generateResponse(input: GenerateInput): Promise<string> {
    const completion = await this.client.chat.completions.create(
      {
        model: this.responseModel,
        // A little variation stops repeated calls sounding identical, without
        // risking the content — the guardrails police that separately.
        temperature: 0.4,
        max_tokens: 200,
        messages: this.responseMessages(input),
      },
      { signal: input.signal },
    );

    return completion.choices[0]?.message?.content?.trim() ?? '';
  }

  async *streamResponse(input: GenerateInput): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.responseModel,
        temperature: 0.4,
        max_tokens: 200,
        stream: true,
        messages: this.responseMessages(input),
      },
      { signal: input.signal },
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  private responseMessages(
    input: GenerateInput,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return [
      {
        role: 'system',
        content: buildGenerationSystemPrompt({
          facts: input.facts,
          recentTurns: input.recentTurns,
          customerName: input.customerName,
        }),
      },
      {
        role: 'user',
        content: buildGenerationUserPrompt(input.directive, input.fallbackPhrasing),
      },
    ];
  }
}
