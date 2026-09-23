import { describe, expect, it } from 'vitest';
import { CallEventType, EMPTY_EXTRACTION, type BusinessFacts } from '@towai/shared';

import type { CallJudgments } from '../integrations/judgment/judgment.interface';
import { applyIntake, describeIntake, previewLocation, type IntakeOperation } from './intake';
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
const logged = (effects: Effect[], event: string) => effects.some((e) => e.type === 'LOG_EVENT' && e.event === event);

/** Applies operations in order; `[op, callerTurn]` pairs model the audio turn counter. */
function run(ctx: ConversationContext, ...steps: Array<IntakeOperation | [IntakeOperation, number]>) {
  let context = ctx;
  let last = applyIntake(context, { kind: 'state' }, CONFIG);
  const effects: Effect[] = [];
  for (const step of steps) {
    const [op, callerTurn] = Array.isArray(step) ? step : [step, undefined];
    last = applyIntake(context, op, CONFIG, { defaultRegionPrefix: '+1', emergencyNumber: '911', callerTurn });
    context = last.context;
    effects.push(...last.effects);
  }
  return { context, last, effects };
}

const fresh = () => initialContext({ customerPhone: '+18174098408' });
const state = (result: { output: Record<string, unknown> }) => result.output.state as ReturnType<typeof describeIntake>;

/** Every detail, at a precise off-highway address, so no safety step interleaves. */
const everything: IntakeOperation = {
  kind: 'update',
  slots: {
    serviceType: 'towing',
    location: '123 Main Street',
    vehicleType: 'semi truck',
    vehicleMovable: false,
    customerName: 'Mike',
  },
};

describe('update_call_information', () => {
  it('saves several details at once and reports what is missing, in order', () => {
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
    // "I-95" is saved but not precise enough, so location still counts as missing.
    expect(state(last).missing).toEqual(['serviceType', 'location', 'vehicleMovable', 'customerPhone']);
    expect(state(last).locationStatus).toBe('partial');
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

  it('keeps the more specific value when a later one only drops words from it', () => {
    const { context, last, effects } = run(
      fresh(),
      { kind: 'update', slots: { vehicleType: 'semi truck' } },
      { kind: 'update', slots: { vehicleType: 'truck' } },
    );

    expect(context.values.vehicleType).toBe('Semi Truck');
    expect(last.output.keptMoreSpecific).toEqual({ vehicleType: 'Semi Truck' });
    expect(logged(effects, CallEventType.FIELD_DOWNGRADE_IGNORED)).toBe(true);
  });

  it('combines a location detail with the road it belongs to', () => {
    const { context } = run(fresh(), { kind: 'update', slots: { location: 'I-95' } }, { kind: 'update', slots: { location: 'exit 42' } });
    expect(context.values.location).toBe('I-95, exit 42');
  });

  it('records where each value came from', () => {
    const { context } = run(fresh(), {
      kind: 'update',
      slots: { vehicleMake: 'Ford', vehicleModel: 'Mustang', vehicleMovable: false },
      inferred: ['vehicleMake'],
      unsure: ['vehicleMovable'],
    });
    expect(context.fieldSources).toEqual({ vehicleMake: 'inferred', vehicleModel: 'stated', vehicleMovable: 'unsure' });

    // Re-saving an unsure value without the flag means the caller confirmed it.
    const confirmed = run(context, { kind: 'update', slots: { vehicleMovable: false } }).context;
    expect(confirmed.fieldSources?.vehicleMovable).toBe('stated');
  });
});

describe('confirmations need the caller, not the model', () => {
  it('rejects a callback-number confirmation the caller was never asked about', () => {
    // Seen on a real call: the number was marked confirmed with no question asked.
    const { context, last, effects } = run(fresh(), [{ kind: 'update', slots: { customerName: 'Mike' }, callerIdConfirmed: true }, 1]);

    expect(context.phoneConfirmed).toBe(false);
    expect(last.output.rejected).toEqual([expect.objectContaining({ field: 'callerIdConfirmed' })]);
    expect(logged(effects, CallEventType.CONFIRMATION_REJECTED)).toBe(true);
  });

  it('accepts it only once the caller has spoken after being asked', () => {
    const asked = run(fresh(), [everything, 1]);
    expect(state(asked.last).nextAction).toBe('CONFIRM_CALLBACK_NUMBER');

    const sameTurn = run(asked.context, [{ kind: 'update', slots: {}, callerIdConfirmed: true }, 1]);
    expect(sameTurn.context.phoneConfirmed).toBe(false);

    const answered = run(asked.context, [{ kind: 'update', slots: {}, callerIdConfirmed: true }, 2]);
    expect(answered.context.phoneConfirmed).toBe(true);
  });

  it('creates the lead only after the caller answers the read-back', () => {
    // The live bug: the read-back and the "confirmation" came in one breath.
    const confirmedPhone = run(fresh(), [everything, 1], [{ kind: 'update', slots: {}, callerIdConfirmed: true }, 2]);
    expect(state(confirmedPhone.last).nextAction).toBe('CONFIRM_DETAILS');

    const sameBreath = run(confirmedPhone.context, [{ kind: 'complete', callerConfirmed: true }, 2]);
    expect(sameBreath.last.ended).toBe(false);
    expect(has(sameBreath.effects, 'CREATE_LEAD')).toBe(false);
    expect(logged(sameBreath.effects, CallEventType.CONFIRMATION_REJECTED)).toBe(true);

    const afterYes = run(confirmedPhone.context, [{ kind: 'complete', callerConfirmed: true }, 3]);
    expect(afterYes.last.ended).toBe(true);
    expect(has(afterYes.effects, 'CREATE_LEAD')).toBe(true);
    expect(describeIntake(afterYes.context).status).toBe('submitted');
  });

  it('does not accept a confirmation of details that changed after the read-back', () => {
    const readBack = run(fresh(), [everything, 1], [{ kind: 'update', slots: {}, callerIdConfirmed: true }, 2]);
    const changed = run(
      readBack.context,
      [{ kind: 'update', slots: { location: '125 Main Street' } }, 3],
      [{ kind: 'complete', callerConfirmed: true }, 3],
    );
    expect(has(changed.effects, 'CREATE_LEAD')).toBe(false);

    const reconfirmed = run(changed.context, [{ kind: 'complete', callerConfirmed: true }, 4]);
    expect(has(reconfirmed.effects, 'CREATE_LEAD')).toBe(true);
  });

  it('refuses to complete while details are missing', () => {
    const { last, effects } = run(fresh(), { kind: 'update', slots: { customerName: 'Mike' } }, { kind: 'complete', callerConfirmed: true });
    expect(last.output.success).toBe(false);
    expect(state(last).nextAction).toBe('ASK_SERVICE_TYPE');
    expect(has(effects, 'CREATE_LEAD')).toBe(false);
  });

  it('ignores further operations once the call has ended', () => {
    const { context } = run(fresh(), everything, { kind: 'end' });
    const after = applyIntake(context, { kind: 'callback', reason: 'again' }, CONFIG);
    expect(after.ended).toBe(true);
    expect(after.effects).toEqual([]);
  });
});

describe('safety and urgency', () => {
  it('gives safety advice first on a highway, then moves on', () => {
    const { last } = run(fresh(), [{ kind: 'update', slots: { serviceType: 'towing', location: 'I-95 near exit 42', vehicleMovable: false } }, 1]);
    expect(state(last).nextAction).toBe('HANDLE_SAFETY');
    expect(state(last).ask).toContain('911');
    expect(state(last).urgent).toBe(true);

    const next = run(last.context, [{ kind: 'state' }, 2]);
    expect(state(next.last).nextAction).toBe('ASK_VEHICLE');
  });

  it('marks a call urgent when the caller says they need help immediately', () => {
    const { context } = run(fresh(), { kind: 'caller_speech', text: 'I need it immediately, please' });
    expect(context.urgency).toEqual({ level: 'high', reasons: ['caller needs help urgently'] });
  });

  it('stops asking for location detail after two tries', () => {
    const partial: IntakeOperation = { kind: 'update', slots: { serviceType: 'towing', location: 'downtown' } };
    const first = run(fresh(), [partial, 1]);
    expect(state(first.last).nextAction).toBe('ASK_LOCATION_DETAIL');
    const second = run(first.context, [{ kind: 'state' }, 2]);
    expect(state(second.last).nextAction).toBe('ASK_LOCATION_DETAIL');
    const third = run(second.context, [{ kind: 'state' }, 3]);
    expect(state(third.last).nextAction).toBe('ASK_VEHICLE');
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

  it('turns partial details into a callback, once', () => {
    const { effects } = run(
      fresh(),
      { kind: 'update', slots: { location: 'I-95' } },
      { kind: 'callback', reason: 'wants a manager' },
      { kind: 'end' },
    );
    expect(has(effects, 'CREATE_LEAD')).toBe(false);
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

describe('applyIntake with judgments from Jev', () => {
  it('judges the location that will actually be saved', () => {
    const onRoad = { ...fresh(), values: { ...fresh().values, location: 'I-95' } };
    expect(previewLocation(onRoad, { kind: 'update', slots: { location: 'exit 42' } })).toBe('I-95, exit 42');
    expect(previewLocation(fresh(), { kind: 'update', slots: { location: '  Liberty Market ' } })).toBe('Liberty Market');
    expect(previewLocation(fresh(), { kind: 'update', slots: { customerName: 'Mike' } })).toBeUndefined();
  });

  it('asks where exactly when Jev finds a saved location too vague, on this turn and the next', () => {
    // "Liberty Market" passes the rules; here Jev heard a misheard name.
    const judgments: CallJudgments = { location: { text: 'Liberty Market', status: 'partial', confidence: 0.9, probabilities: {} } };
    const saved = applyIntake(fresh(), { kind: 'update', slots: { serviceType: 'towing', location: 'Liberty Market' } }, CONFIG, { judgments });

    expect(saved.plan.action).toBe('ASK_LOCATION_DETAIL');
    expect(saved.context.judgments?.location?.text).toBe('Liberty Market');
    expect(state(saved).locationStatus).toBe('partial');
    // The judgment is kept, so the per-turn state request decides the same way without asking Jev again.
    expect(applyIntake(saved.context, { kind: 'state' }, CONFIG).plan.action).toBe('ASK_LOCATION_DETAIL');
  });

  it('moves on when Jev finds a location the rules would have questioned', () => {
    // A street without a number: the rules ask for more; Jev knows it is a short lane.
    const judgments: CallJudgments = { location: { text: 'Mill Lane', status: 'complete', confidence: 0.85, probabilities: {} } };
    const saved = applyIntake(fresh(), { kind: 'update', slots: { serviceType: 'towing', location: 'Mill Lane' } }, CONFIG, { judgments });
    expect(saved.plan.action).toBe('ASK_VEHICLE');
    expect(state(saved).locationStatus).toBe('complete');
  });

  it('gives safety advice first when Jev hears danger the rules did not', () => {
    const text = 'my car rolled into the ditch and my leg is stuck';
    const judgments: CallJudgments = { risk: { text, danger: 0.9, hazard: 'injury', hazardProbability: 0.6, urgent: null } };
    const heard = applyIntake(fresh(), { kind: 'caller_speech', text }, CONFIG, { judgments, emergencyNumber: '911' });

    expect(heard.plan.action).toBe('HANDLE_SAFETY');
    expect(heard.plan.ask).toContain('a possible injury');
    expect(heard.plan.ask).toContain('911');
  });
});
