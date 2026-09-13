import { describe, expect, it } from 'vitest';
import { EMPTY_EXTRACTION, type BusinessFacts } from '@towai/shared';

import { applyIntake, describeIntake, type IntakeOperation } from './intake';
import { reduce } from './state-machine';
import { initialContext, type ConversationContext, type Effect, type FlowConfig } from './types';

const FACTS: BusinessFacts = {
  name: 'Liberty Towing',
  phone: null,
  website: null,
  address: null,
  serviceAreas: ['Dallas', 'Fort Worth'],
  services: ['Local towing', 'Heavy-duty towing'],
  businessHoursText: null,
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

const has = (effects: Effect[], type: Effect['type']) => effects.some((e) => e.type === type);

function run(ctx: ConversationContext, ...ops: IntakeOperation[]) {
  let context = ctx;
  let last = applyIntake(context, { kind: 'state' }, CONFIG);
  const effects: Effect[] = [];
  for (const op of ops) {
    last = applyIntake(context, op, CONFIG, { defaultRegionPrefix: '+1' });
    context = last.context;
    effects.push(...last.effects);
  }
  return { context, last, effects };
}

const fresh = () => initialContext({ customerPhone: '+18174098408' });

const everything: IntakeOperation = {
  kind: 'update',
  slots: {
    serviceType: 'towing',
    location: 'I-95 near exit 42',
    vehicleType: 'semi truck',
    vehicleMovable: false,
    customerName: 'Mike',
  },
  callerIdConfirmed: true,
};

describe('update_call_information', () => {
  it('saves several details at once and reports only facts about what is missing', () => {
    const { last } = run(fresh(), {
      kind: 'update',
      slots: { customerName: 'Mike', vehicleType: 'semi truck', vehicleCondition: 'engine broke down', location: 'I-95' },
    });

    expect(last.output.saved).toEqual({
      customerName: 'Mike',
      vehicleType: 'Semi Truck',
      vehicleCondition: 'engine broke down',
      location: 'I-95',
    });
    const state = describeIntake(last.context);
    expect(state.missing).toEqual(['serviceType', 'vehicleMovable', 'customerPhone']);
    expect(state.status).toBe('collecting');
  });

  it('never erases a saved value with null, and discards invalid values with a reason', () => {
    const { context, last } = run(
      fresh(),
      { kind: 'update', slots: { customerName: 'Mike' } },
      { kind: 'update', slots: { customerName: null, customerPhone: 'call me maybe' } },
    );

    expect(context.values.customerName).toBe('Mike');
    expect(context.values.customerPhone).toBe('+18174098408');
    expect(last.output.rejected).toEqual([{ field: 'customerPhone', reason: 'not a valid phone number' }]);
  });

  it('merges exactly as the state machine does for the same values', () => {
    const slots = { location: 'Liberty Market', vehicleMake: 'toyota', vehicleModel: 'corolla' };
    const viaIntake = applyIntake(fresh(), { kind: 'update', slots }, CONFIG).context.values;
    const viaReducer = reduce(
      fresh(),
      { kind: 'UTTERANCE', transcript: 'x', extraction: EMPTY_EXTRACTION, accepted: { location: 'Liberty Market', vehicleMake: 'Toyota', vehicleModel: 'Corolla' }, rejected: [] },
      CONFIG,
    ).context.values;

    expect(viaIntake).toEqual(viaReducer);
  });

  it('confirms the caller ID, or marks that another number is needed', () => {
    expect(run(fresh(), { kind: 'update', slots: {}, callerIdConfirmed: true }).context.phoneConfirmed).toBe(true);

    const other = run(fresh(), { kind: 'update', slots: {}, callerIdConfirmed: false }).context;
    expect(other.phoneConfirmed).toBe(false);
    expect(other.phoneNeedsCollection).toBe(true);

    const given = run(fresh(), { kind: 'update', slots: { customerPhone: '(214) 555-0100' }, callerIdConfirmed: false }).context;
    expect(given.phoneConfirmed).toBe(true);
    expect(given.values.customerPhone).toBe('+12145550100');
  });
});

describe('complete_request', () => {
  it('refuses while details are missing, and says which', () => {
    const { last, effects } = run(fresh(), { kind: 'update', slots: { customerName: 'Mike' } }, { kind: 'complete', callerConfirmed: true });

    expect(last.output.success).toBe(false);
    expect(last.output.missing).toEqual(['serviceType', 'location', 'vehicle', 'vehicleMovable', 'customerPhone']);
    expect(has(effects, 'CREATE_LEAD')).toBe(false);
  });

  it('requires the details to be read back before a confirmation creates the lead', () => {
    // The model claiming the caller confirmed is not enough on its own.
    const early = run(fresh(), everything, { kind: 'complete', callerConfirmed: true });
    expect(early.last.output.needsConfirmation).toBe(true);
    expect(has(early.effects, 'CREATE_LEAD')).toBe(false);
    expect(describeIntake(early.context).status).toBe('awaiting_confirmation');

    const confirmed = run(early.context, { kind: 'complete', callerConfirmed: true });
    expect(confirmed.last.ended).toBe(true);
    expect(has(confirmed.effects, 'CREATE_LEAD')).toBe(true);
    expect(describeIntake(confirmed.context).status).toBe('submitted');
  });

  it('does not accept a confirmation of details that changed after the read-back', () => {
    const { context } = run(fresh(), everything, { kind: 'complete', callerConfirmed: false });
    const changed = run(context, { kind: 'update', slots: { location: 'I-95 near exit 43' } }, { kind: 'complete', callerConfirmed: true });

    expect(changed.last.output.needsConfirmation).toBe(true);
    expect(has(changed.effects, 'CREATE_LEAD')).toBe(false);
  });

  it('ignores further operations once the call has ended', () => {
    const { context } = run(fresh(), everything, { kind: 'complete', callerConfirmed: false }, { kind: 'complete', callerConfirmed: true });
    const after = applyIntake(context, { kind: 'callback', reason: 'again' }, CONFIG);

    expect(after.ended).toBe(true);
    expect(after.effects).toEqual([]);
  });
});

describe('business information', () => {
  it('answers from configuration only', () => {
    const { last, effects } = run(fresh(), { kind: 'business_info', topic: 'service_area', question: 'Do you cover Dallas?' });

    expect(last.output.answered).toBe(true);
    expect(last.output.fact).toContain('Dallas');
    expect(has(effects, 'CREATE_CALLBACK')).toBe(false);
  });

  it('raises one callback for questions it cannot answer, such as price or arrival time', () => {
    const { last, effects } = run(
      fresh(),
      { kind: 'business_info', topic: 'pricing', question: 'How much is a tow?' },
      { kind: 'business_info', topic: 'eta', question: 'When will you get here?' },
    );

    expect(last.output.answered).toBe(false);
    expect(effects.filter((e) => e.type === 'CREATE_CALLBACK')).toHaveLength(1);
  });
});

describe('ending', () => {
  it('turns a complete intake into a lead even if the caller ends before confirming', () => {
    const { effects, last } = run(fresh(), everything, { kind: 'end' });
    expect(last.ended).toBe(true);
    expect(has(effects, 'CREATE_LEAD')).toBe(true);
  });

  it('turns partial details into a callback', () => {
    const { effects } = run(fresh(), { kind: 'update', slots: { location: 'I-95' } }, { kind: 'end' });
    expect(has(effects, 'CREATE_LEAD')).toBe(false);
    expect(has(effects, 'CREATE_CALLBACK')).toBe(true);
  });

  it('does not repeat a callback already raised when the call ends', () => {
    const { effects } = run(
      fresh(),
      { kind: 'update', slots: { location: 'I-95' } },
      { kind: 'callback', reason: 'wants a manager' },
      { kind: 'end' },
    );
    expect(effects.filter((e) => e.type === 'CREATE_CALLBACK')).toHaveLength(1);
  });

  it('ends after the configured number of silences, and speech resets the count', () => {
    const once = run(fresh(), { kind: 'silence' });
    expect(once.last.ended).toBe(false);

    const reset = run(once.context, { kind: 'caller_speech', text: 'sorry, I am here' }, { kind: 'silence' });
    expect(reset.last.ended).toBe(false);

    expect(run(reset.context, { kind: 'silence' }).last.ended).toBe(true);
  });
});
