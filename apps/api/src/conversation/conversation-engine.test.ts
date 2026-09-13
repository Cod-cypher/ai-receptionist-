import { describe, expect, it } from 'vitest';
import {
  EMPTY_EXTRACTION,
  type BusinessFacts,
  type ExtractionResult,
} from '@towai/shared';

import { ConversationEngine } from './conversation-engine';
import { initialContext, type Effect, type FlowConfig } from './types';
import { StubAiProvider } from '../integrations/ai/stub.provider';
import type {
  AiProvider,
  GenerateInput,
  TranscriptTurn,
  UnderstandInput,
} from '../integrations/ai/ai-provider.interface';

const FACTS: BusinessFacts = {
  name: 'Liberty Towing',
  phone: '+924235000000',
  website: null,
  address: null,
  serviceAreas: ['Lahore', 'Gulberg'],
  services: ['Local towing', 'Flatbed towing', 'Jump starts'],
  businessHoursText: 'Monday: 00:00-23:59',
  isOpenNow: true,
  pricingInfo: null,
  emergencyContact: null,
  faq: [],
  tone: 'friendly',
  businessInstructions: null,
};

const CONFIG: FlowConfig = {
  facts: FACTS,
  greeting: null,
  fallbackBehavior: 'callback',
  maxAskAttempts: 3,
  maxUnclearStreak: 3,
  maxSilenceStreak: 2,
  maxTurns: 40,
};

const hasEffect = (effects: Effect[], type: Effect['type']) =>
  effects.some((e) => e.type === type);

/**
 * Runs a scripted call the way production does: the engine drives, and the
 * transcript accumulates from both sides.
 */
async function runCall(provider: AiProvider, script: string[]) {
  const engine = new ConversationEngine(provider);
  const turns: TranscriptTurn[] = [];
  const allEffects: Effect[] = [];

  let ctx = initialContext({ customerPhone: '+923001234567' });
  const options = { config: CONFIG, recentTurns: turns, defaultRegionPrefix: '+92' };

  const opening = await engine.begin(ctx, { ...options, recentTurns: [...turns] });
  ctx = opening.context;
  turns.push({ speaker: 'ai', text: opening.reply });
  allEffects.push(...opening.effects);

  const replies: string[] = [opening.reply];

  for (const utterance of script) {
    const result = await engine.handleUtterance(ctx, utterance, {
      ...options,
      recentTurns: [...turns],
    });
    ctx = result.context;
    turns.push({ speaker: 'customer', text: utterance });
    if (result.reply) turns.push({ speaker: 'ai', text: result.reply });
    replies.push(result.reply);
    allEffects.push(...result.effects);
    if (ctx.state === 'ENDED') break;
  }

  return { context: ctx, replies, effects: allEffects, turns };
}

describe('a complete call through the engine', () => {
  it('turns a stranded caller into a lead using only the stub provider', async () => {
    const { context, effects, replies } = await runCall(new StubAiProvider(), [
      'My car broke down near Liberty Market',
      "It's a Toyota Corolla",
      "It can't move",
      'Ahmed',
      'Yes',
      "Yes that's right",
    ]);

    // The workflow completed and produced a lead.
    expect(hasEffect(effects, 'CREATE_LEAD')).toBe(true);
    expect(context.state).toBe('ENDED');
    expect(context.finalised).toBe(true);

    // With every required field present and correctly typed.
    expect(context.values).toMatchObject({
      serviceType: 'Vehicle towing',
      location: 'Liberty Market',
      vehicleMake: 'Toyota',
      vehicleModel: 'Corolla',
      vehicleMovable: false,
      customerName: 'Ahmed',
      customerPhone: '+923001234567',
    });

    // Every turn said something, and nothing tripped a guardrail.
    expect(replies.every((r) => r.length > 0)).toBe(true);
  });

  it('copes with casual typing: no apostrophes, lowercase, bare yes/no', async () => {
    // How people actually type into the simulator. The first run of the
    // terminal simulator failed exactly here: "it cant move" was not
    // recognised, the question was asked three times, and the call escalated.
    const { context, effects } = await runCall(new StubAiProvider(), [
      'my car broke down near liberty market',
      'its a honda civic',
      'no',
      'bilal',
      'yes',
      'yes thats right',
    ]);

    expect(hasEffect(effects, 'CREATE_LEAD')).toBe(true);
    expect(context.values).toMatchObject({
      vehicleMake: 'Honda',
      vehicleModel: 'Civic',
      vehicleMovable: false,
      customerName: 'Bilal',
    });
  });

  it('does not take a car make as the caller name', async () => {
    const { context } = await runCall(new StubAiProvider(), [
      "My car broke down near Liberty Market. It's Honda",
    ]);

    expect(context.values.customerName).toBeUndefined();
    expect(context.values.vehicleMake).toBe('Honda');
  });

  it('logs a traceable event stream for the whole call', async () => {
    const { effects } = await runCall(new StubAiProvider(), [
      'My car broke down near Liberty Market',
      "It's a Toyota Corolla",
      "It can't move",
      'Ahmed',
      'Yes',
      "Yes that's right",
    ]);

    const events = effects
      .filter((e): e is Extract<Effect, { type: 'LOG_EVENT' }> => e.type === 'LOG_EVENT')
      .map((e) => e.event);

    expect(events).toContain('AI_GREETING');
    expect(events).toContain('CUSTOMER_SPEECH');
    expect(events).toContain('FIELD_EXTRACTED');
    expect(events).toContain('STATE_CHANGED');
    expect(events).toContain('LEAD_CREATED');
  });
});

/* -------------------------------------------------------------------------- */
/*  Provider failure                                                          */
/* -------------------------------------------------------------------------- */

/** A provider that fails on demand, to exercise the engine's recovery paths. */
class FailingProvider implements AiProvider {
  readonly name = 'failing';
  constructor(
    private readonly mode: 'understand' | 'generate' | 'hang',
    private readonly reply = 'ok',
  ) {}

  async understand(_input: UnderstandInput): Promise<ExtractionResult> {
    if (this.mode === 'understand') throw new Error('upstream 503');
    if (this.mode === 'hang') await new Promise(() => {});
    return { ...EMPTY_EXTRACTION, intent: 'provide_info' };
  }

  async generateResponse(_input: GenerateInput): Promise<string> {
    if (this.mode === 'generate') throw new Error('rate limited');
    return this.reply;
  }
}

describe('when the model provider fails', () => {
  it('still speaks to the caller and still raises a callback', async () => {
    const engine = new ConversationEngine(new FailingProvider('understand'));
    let ctx = initialContext({ customerPhone: '+923001234567' });
    ctx = (await engine.begin(ctx, { config: CONFIG, recentTurns: [] })).context;

    const result = await engine.handleUtterance(ctx, 'my car broke down', {
      config: CONFIG,
      recentTurns: [],
    });

    // The caller hears something safe rather than silence.
    expect(result.reply).toContain('towing team');
    expect(result.replySource).toBe('template');
    // And the operator still learns there was a call worth returning.
    expect(hasEffect(result.effects, 'CREATE_CALLBACK')).toBe(true);
    expect(
      result.effects.some((e) => e.type === 'LOG_EVENT' && e.event === 'PROVIDER_ERROR'),
    ).toBe(true);
  });

  it('falls back to the deterministic phrasing when generation fails', async () => {
    const engine = new ConversationEngine(new FailingProvider('generate'));
    const ctx = initialContext({ customerPhone: '+923001234567' });

    const result = await engine.begin(ctx, { config: CONFIG, recentTurns: [] });

    expect(result.reply).toContain('Liberty Towing');
    expect(result.replySource).toBe('template');
    // The workflow is untouched — only the wording degraded.
    expect(result.directive.kind).toBe('GREET');
  });
});

/* -------------------------------------------------------------------------- */
/*  Guardrails in the loop                                                    */
/* -------------------------------------------------------------------------- */

describe('a model that says something it must not', () => {
  it('replaces the reply with the safe template and records the violation', async () => {
    const rogue = new FailingProvider(
      'none' as never,
      "I've dispatched a truck, it'll arrive in 15 minutes and costs PKR 3000.",
    );
    const engine = new ConversationEngine(rogue);
    const ctx = initialContext({ customerPhone: '+923001234567' });

    const result = await engine.begin(ctx, { config: CONFIG, recentTurns: [] });

    // The caller never hears the dangerous sentence.
    expect(result.reply).not.toContain('dispatched');
    expect(result.reply).not.toContain('PKR');
    expect(result.replySource).toBe('template');
    expect(result.guardrailViolations.map((v) => v.code)).toEqual(
      expect.arrayContaining(['dispatch_promise', 'price_claim']),
    );
    // And the suppressed text is kept for debugging.
    expect(
      result.effects.some(
        (e) => e.type === 'LOG_EVENT' && e.event === 'GUARDRAIL_TRIPPED',
      ),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Empty speech                                                              */
/* -------------------------------------------------------------------------- */

describe('empty transcripts', () => {
  it('treats recognising nothing as silence, not as a meaningless answer', async () => {
    const engine = new ConversationEngine(new StubAiProvider());
    let ctx = initialContext({ customerPhone: '+923001234567' });
    ctx = (await engine.begin(ctx, { config: CONFIG, recentTurns: [] })).context;

    const result = await engine.handleUtterance(ctx, '   ', {
      config: CONFIG,
      recentTurns: [],
    });

    expect(result.directive.kind).toBe('PROMPT_AFTER_SILENCE');
    expect(result.context.silenceStreak).toBe(1);
    // Silence must not count against the "could not understand" budget.
    expect(result.context.unclearStreak).toBe(0);
  });
});

