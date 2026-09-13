/**
 * Orchestrates one turn: understand, decide, phrase.
 *
 * The engine owns the ordering and the failure handling; it owns none of the
 * decisions. `reduce` decides what happens, the provider supplies language, and
 * everything the provider returns is validated before it can affect state or
 * reach the caller.
 *
 * It performs no I/O of its own beyond the two provider calls — no database, no
 * queue, no telephony. Side effects come back as `Effect[]` for the caller to
 * execute, which is what lets the same engine drive a phone call, the text
 * simulator, and the test suite unchanged.
 */

import {
  CallEventType,
  compactSlots,
  validateSlots,
  type SlotKey,
  type SlotValues,
} from '@towai/shared';

import { checkReply, type Violation } from './guardrails';
import { renderTemplate } from './response-templates';
import { reduce } from './state-machine';
import {
  type ConversationContext,
  type Directive,
  type Effect,
  type FlowConfig,
  type TurnDecision,
  type TurnInput,
} from './types';
import type {
  AiProvider,
  TranscriptTurn,
} from '../integrations/ai/ai-provider.interface';

export interface EngineTurnResult {
  context: ConversationContext;
  directive: Directive;
  effects: Effect[];
  /** Exactly what should be spoken. Empty string means say nothing. */
  reply: string;
  replySource: 'model' | 'template';
  guardrailViolations: Violation[];
}

export interface TurnOptions {
  config: FlowConfig;
  recentTurns: TranscriptTurn[];
  /** Normalises nationally-formatted numbers the caller reads out. */
  defaultRegionPrefix?: string;
  signal?: AbortSignal;
  /**
   * Ask the AI provider to phrase the reply (default). When false the
   * deterministic template is returned as-is — used when something else, such
   * as a speech-to-speech model, gives the line its voice.
   */
  phrase?: boolean;
}

/** How long a single provider call may take before the turn gives up on it. */
const UNDERSTAND_TIMEOUT_MS = 6_000;
const GENERATE_TIMEOUT_MS = 6_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class ConversationEngine {
  constructor(private readonly ai: AiProvider) {}

  /** The opening turn. Produces the greeting; the caller has not spoken yet. */
  async begin(
    ctx: ConversationContext,
    options: TurnOptions,
  ): Promise<EngineTurnResult> {
    const decision = reduce(ctx, { kind: 'START' }, options.config);
    return this.speak(decision, options);
  }

  /**
   * A caller utterance: the full path.
   *
   * A provider failure here does not drop the call. It is converted into a
   * PROVIDER_ERROR turn, which the state machine turns into a callback — the
   * caller is still told a human will ring them, and the operator still gets a
   * record.
   */
  async handleUtterance(
    ctx: ConversationContext,
    transcript: string,
    options: TurnOptions,
  ): Promise<EngineTurnResult> {
    const trimmed = transcript.trim();

    // Empty speech is silence, not an utterance — recognising nothing is a
    // different event from the caller saying something meaningless.
    if (trimmed.length === 0) {
      return this.handleEvent(ctx, { kind: 'SILENCE' }, options);
    }

    let input: TurnInput;
    try {
      const extraction = await withTimeout(
        this.ai.understand({
          transcript: trimmed,
          state: ctx.state,
          filledSlots: ctx.values,
          pendingRequirement: currentRequirementId(ctx),
          facts: options.config.facts,
          recentTurns: options.recentTurns,
          signal: options.signal,
        }),
        UNDERSTAND_TIMEOUT_MS,
        'understand',
      );

      const { accepted, rejected } = validateSlots(
        compactSlots(extraction.slots) as Partial<Record<SlotKey, unknown>>,
        { defaultRegionPrefix: options.defaultRegionPrefix },
      );

      input = {
        kind: 'UTTERANCE',
        transcript: trimmed,
        extraction,
        accepted: accepted as SlotValues,
        rejected,
      };
    } catch (error) {
      input = {
        kind: 'PROVIDER_ERROR',
        message: error instanceof Error ? error.message : 'unknown provider failure',
      };
    }

    const decision = reduce(ctx, input, options.config);
    return this.speak(decision, options, input.kind === 'PROVIDER_ERROR' ? input.message : null);
  }

  /** Silence, hang-up, timeout — anything that is not speech. */
  async handleEvent(
    ctx: ConversationContext,
    input: Exclude<TurnInput, { kind: 'UTTERANCE' }>,
    options: TurnOptions,
  ): Promise<EngineTurnResult> {
    const decision = reduce(ctx, input, options.config);
    return this.speak(decision, options);
  }

  /**
   * Phrase the decided directive.
   *
   * The deterministic template is produced first and always available, so a slow
   * model, a refusal, or a guardrail violation costs natural phrasing — never
   * the turn itself.
   */
  private async speak(
    decision: TurnDecision,
    options: TurnOptions,
    providerError: string | null = null,
  ): Promise<EngineTurnResult> {
    const template = renderTemplate(decision.directive, {
      businessName: options.config.facts.name,
      customerName: decision.context.values.customerName,
      greeting: options.config.greeting,
    });

    const base: EngineTurnResult = {
      context: decision.context,
      directive: decision.directive,
      effects: decision.effects,
      reply: template,
      replySource: 'template',
      guardrailViolations: [],
    };

    if (decision.directive.kind === 'SILENT_END') {
      return { ...base, reply: '' };
    }

    // The line will be voiced by something else, which does its own phrasing.
    if (options.phrase === false) return base;

    // A provider that just failed is not asked to phrase the apology for it.
    if (providerError !== null) {
      return {
        ...base,
        effects: [
          {
            type: 'LOG_EVENT',
            event: CallEventType.PROVIDER_ERROR,
            payload: { provider: this.ai.name, message: providerError },
          },
          ...base.effects,
        ],
      };
    }

    let generated: string;
    try {
      generated = (
        await withTimeout(
          this.ai.generateResponse({
            directive: decision.directive,
            facts: options.config.facts,
            recentTurns: options.recentTurns,
            customerName: decision.context.values.customerName,
            fallbackPhrasing: template,
            signal: options.signal,
          }),
          GENERATE_TIMEOUT_MS,
          'generateResponse',
        )
      ).trim();
    } catch (error) {
      return {
        ...base,
        effects: [
          ...base.effects,
          {
            type: 'LOG_EVENT',
            event: CallEventType.PROVIDER_ERROR,
            payload: {
              provider: this.ai.name,
              stage: 'generate',
              message: error instanceof Error ? error.message : 'unknown',
            },
          },
        ],
      };
    }

    if (generated.length === 0) return base;

    // Pricing may only be spoken when the engine itself supplied a pricing fact
    // from configuration — never when the model volunteered a number.
    const allowPricing =
      decision.directive.kind === 'ANSWER_FAQ' &&
      /\b(?:price|pricing|cost|charge|rate|fee)\b/i.test(decision.directive.fact);

    const verdict = checkReply(generated, { allowPricing });
    if (!verdict.ok) {
      return {
        ...base,
        guardrailViolations: verdict.violations,
        effects: [
          ...base.effects,
          {
            type: 'LOG_EVENT',
            event: CallEventType.GUARDRAIL_TRIPPED,
            payload: {
              violations: verdict.violations.map((v) => v.code),
              suppressed: generated,
            },
          },
        ],
      };
    }

    return { ...base, reply: generated, replySource: 'model' };
  }
}

/**
 * The requirement the receptionist is currently asking about, derived from the
 * state. Given to the extractor as interpretation context only — a bare "Ahmed"
 * is a name when the name was asked for and noise otherwise.
 */
export function currentRequirementId(ctx: ConversationContext) {
  switch (ctx.state) {
    case 'IDENTIFY_INTENT':
      return 'serviceType' as const;
    case 'COLLECT_LOCATION':
      return 'location' as const;
    case 'COLLECT_VEHICLE':
      return 'vehicle' as const;
    case 'COLLECT_VEHICLE_CONDITION':
      return 'vehicleMovable' as const;
    case 'COLLECT_NAME':
      return 'customerName' as const;
    case 'CONFIRM_PHONE':
      return 'customerPhone' as const;
    default:
      return null;
  }
}
