import { describe, expect, it } from 'vitest';
import { CallEventType, EMPTY_EXTRACTION, type BusinessFacts } from '@towai/shared';

import type { CallJudgments } from '../integrations/judgment/judgment.interface';
import { applyIntake, describeIntake, previewLocation, type IntakeOperation } from './intake';
import { buildLeadNotes } from './lead-notes';
import { ETA_ANSWER, PRICE_ANSWER } from './ready-answers';
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
/** The payloads of every event of that type logged, in order. */
const payloads = (effects: Effect[], event: string) =>
  effects.flatMap((e) => (e.type === 'LOG_EVENT' && e.event === event ? [e.payload ?? {}] : []));

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
    const confirmed = run(context, { kind: 'update', slots: { vehicleMovable: false } });
    expect(confirmed.context.fieldSources?.vehicleMovable).toBe('stated');
    expect(confirmed.last.output.note).toBeUndefined();
  });

  it('says so when nothing new was saved, so the reply answers what the caller said', () => {
    // A real call: "So how's the weather over there?" was saved as the number already saved.
    const resent = run(fresh(), { kind: 'update', slots: { customerPhone: '+18174098408' }, callerIdConfirmed: null });
    expect(resent.last.output.saved).toEqual({});
    expect(resent.last.output.note).toContain('Nothing new was saved');
    // "It's a plane.": nothing to save, only a field it was unsure of.
    expect(run(fresh(), { kind: 'update', slots: {}, unsure: ['vehicleType'] }).last.output.note).toContain('Nothing new was saved');

    expect(run(fresh(), { kind: 'update', slots: { customerName: 'Ali' } }).last.output.note).toBeUndefined();
    expect(run(fresh(), { kind: 'update', slots: {}, callerIdConfirmed: false }).last.output.note).toBeUndefined();
  });

  it('takes "it needs to be towed", to whether it can move or needs a tow, as the help needed when none is saved', () => {
    // A real call: "It needs to be told." saved movability only, and the read-back had no service.
    const asking: ConversationContext = { ...fresh(), asked: { ASK_VEHICLE_MOVABLE: { count: 1, turn: 15 } } };
    const update = (vehicleMovable: boolean, callerTurn: number) =>
      applyIntake(asking, { kind: 'update', slots: { vehicleMovable } }, CONFIG, { callerTurn }).context;

    const towed = update(false, 15);
    expect(towed.values.serviceType).toBe('tow');
    expect(towed.fieldSources?.serviceType).toBe('inferred');
    // Not an answer to that question, or not a tow.
    expect(update(false, 16).values.serviceType).toBeUndefined();
    expect(update(true, 15).values.serviceType).toBeUndefined();
    // Never over a service already saved.
    const saved = applyIntake({ ...asking, values: { ...asking.values, serviceType: 'jump start' } }, { kind: 'update', slots: { vehicleMovable: false } }, CONFIG, {
      callerTurn: 15,
    });
    expect(saved.context.values.serviceType).toBe('jump start');
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

  it('stops waiting for a yes after four turns, and sends the details unconfirmed', () => {
    // The real call: "is that all correct?" turn after turn, with a caller
    // who asked questions instead, and no end to it but the turn limit.
    let { context } = run(fresh(), [everything, 1], [{ kind: 'update', slots: {}, callerIdConfirmed: true }, 2]);
    for (const turn of [3, 4, 5, 6]) {
      const waiting = run(context, [{ kind: 'state' }, turn]);
      expect(state(waiting.last).nextAction).toBe('AWAIT_CONFIRMATION');
      context = waiting.context;
    }

    const done = run(context, [{ kind: 'state' }, 7]);
    expect(done.last.ended).toBe(true);
    expect(has(done.effects, 'CREATE_LEAD')).toBe(true);
    expect(done.context.detailsConfirmed).toBeUndefined();
    expect(buildLeadNotes(done.context)).toContain('read back, but the caller did not confirm');
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
    // Nothing happens; the attempt is only traced.
    expect(after.effects.map((e) => (e.type === 'LOG_EVENT' ? e.event : e.type))).toEqual([CallEventType.TOOL_CALL, CallEventType.NEXT_ACTION]);
    expect(payloads(after.effects, CallEventType.NEXT_ACTION)[0]).toEqual(expect.objectContaining({ action: 'CLOSE', because: expect.arrayContaining(['the call has ended']) }));
  });
});

describe('the decision trail', () => {
  it('records each tool call with what the model was told, then the next action and why', () => {
    const { last } = run(fresh(), [{ kind: 'update', slots: { serviceType: 'towing', customerName: 'Mike', location: 'Main Street' } }, 1]);
    const events = last.effects.flatMap((e) => (e.type === 'LOG_EVENT' ? [e.event] : []));

    expect(events[0]).toBe(CallEventType.TOOL_CALL);
    expect(events.at(-1)).toBe(CallEventType.NEXT_ACTION);
    const [call] = payloads(last.effects, CallEventType.TOOL_CALL);
    expect(call).toEqual(expect.objectContaining({ kind: 'update', args: expect.objectContaining({ slots: expect.objectContaining({ customerName: 'Mike' }) }) }));
    // What the model was told, without the state the note carries.
    expect(call!.output).toEqual(expect.objectContaining({ saved: expect.objectContaining({ customerName: 'Mike' }) }));
    expect(call!.output).not.toHaveProperty('state');

    const [next] = payloads(last.effects, CallEventType.NEXT_ACTION);
    expect(next).toEqual(expect.objectContaining({ after: 'update', action: state(last).nextAction }));
    expect((next!.because as string[])[0]).toContain('location "Main Street" not precise enough');
  });

  it('records nothing for what the model is never sent: a caller line, a silence tick', () => {
    const { effects } = run(fresh(), [{ kind: 'caller_speech', text: 'Hello?' }, 1], { kind: 'silence' });
    expect(logged(effects, CallEventType.NEXT_ACTION)).toBe(false);
    expect(logged(effects, CallEventType.TOOL_CALL)).toBe(false);
  });

  it('records the per-turn state request as a decision, but not as a tool call', () => {
    const { effects } = run(fresh(), [{ kind: 'state' }, 1]);
    expect(payloads(effects, CallEventType.NEXT_ACTION)).toEqual([expect.objectContaining({ after: 'state', action: 'ASK_SERVICE_TYPE' })]);
    expect(logged(effects, CallEventType.TOOL_CALL)).toBe(false);
  });
});

describe('the decision trail: judgments, risk and inferences', () => {
  it('records what the judge was asked and found, ahead of what it changed', () => {
    const judged = [{ about: 'location' as const, text: 'I-95', ms: 412, found: ['location partial (0.81)'] }];
    const result = applyIntake(fresh(), { kind: 'update', slots: { serviceType: 'tow', location: 'I-95' } }, CONFIG, { callerTurn: 1, judged });
    const events = result.effects.flatMap((e) => (e.type === 'LOG_EVENT' ? [e.event] : []));

    expect(events[0]).toBe(CallEventType.JUDGMENT);
    expect(payloads(result.effects, CallEventType.JUDGMENT)).toEqual([judged[0]]);
  });

  it('records a judgment of a caller line, though the model is not sent a plan for it', () => {
    const asked = [{ about: 'speech' as const, text: 'Hello?', ms: 300, found: [] }];
    const result = applyIntake(fresh(), { kind: 'judgment', text: 'Hello?', judgments: {}, asked }, CONFIG, { callerTurn: 1 });
    expect(payloads(result.effects, CallEventType.JUDGMENT)).toEqual(asked);
    expect(logged(result.effects, CallEventType.NEXT_ACTION)).toBe(false);
  });

  it('records a hazard once, with what found it', () => {
    const { effects } = run(
      fresh(),
      [{ kind: 'caller_speech', text: 'My car is on fire.' }, 1],
      [{ kind: 'caller_speech', text: 'It is still on fire.' }, 2],
    );
    expect(payloads(effects, CallEventType.RISK_ASSESSED)).toEqual([
      expect.objectContaining({ hazard: 'fire or fuel risk', foundBy: 'word list, in "My car is on fire."' }),
    ]);
  });

  it('records urgency reasons as they are added', () => {
    const { effects } = run(fresh(), [{ kind: 'caller_speech', text: 'I need help right now.' }, 1]);
    expect(payloads(effects, CallEventType.RISK_ASSESSED)).toEqual([
      expect.objectContaining({ urgency: 'high', reasonsAdded: ['caller needs help urgently'] }),
    ]);
  });

  it('says where a value came from when the caller did not say it', () => {
    const { effects } = run(fresh(), [{ kind: 'update', slots: { vehicleCondition: "won't start", vehicleModel: 'Mustang', vehicleMake: 'Ford' }, inferred: ['vehicleMake'] }, 1]);
    const fields = payloads(effects, CallEventType.FIELD_EXTRACTED);

    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'vehicleMovable', value: false, source: `inferred from the condition "won't start"` }),
        expect.objectContaining({ field: 'vehicleMake', source: 'inferred by the model' }),
      ]),
    );
    expect(fields.find((f) => f.field === 'vehicleModel')).not.toHaveProperty('source');
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

  it('still requires the safety advice after a detail is saved on the turn it was issued', () => {
    // Danger heard in the transcript, after the reply to that turn. The next
    // turn's note requires the advice; the caller gives an address on that
    // turn; the model saves it first, as told. The plan that comes back with
    // the save must be the advice, not the vehicle question.
    const heard = run(
      fresh(),
      [{ kind: 'update', slots: { serviceType: 'tow' } }, 1],
      [{ kind: 'caller_speech', text: 'I need a tow, there is smoke coming from the engine' }, 1],
    );
    const note = run(heard.context, [{ kind: 'state' }, 2]);
    expect(state(note.last).nextAction).toBe('HANDLE_SAFETY');

    const saved = run(note.context, [{ kind: 'update', slots: { location: '123 Main Street' } }, 2]);
    expect(state(saved.last).nextAction).toBe('HANDLE_SAFETY');

    const complete = run(saved.context, [{ kind: 'complete', callerConfirmed: true }, 2]);
    expect(complete.last.output.reason).toContain('safety advice first');

    const later = run(saved.context, [{ kind: 'state' }, 3]);
    expect(state(later.last).nextAction).toBe('ASK_VEHICLE');
  });

  it('marks a call urgent when the caller says they need help immediately', () => {
    const { context } = run(fresh(), { kind: 'caller_speech', text: 'I need it immediately, please' });
    expect(context.urgency).toEqual({ level: 'high', reasons: ['caller needs help urgently'] });
  });

  it('has the urgency acknowledged on one turn only', () => {
    // The real call: "I understand this is urgent" on three turns running.
    const heard = run(fresh(), [{ kind: 'caller_speech', text: 'I need it immediately, please' }, 1]);
    // A caller line is not sent to the model, so it does not use the acknowledgement up.
    expect(heard.context.urgencyNotedTurn).toBeUndefined();

    const first = run(heard.context, [{ kind: 'state' }, 1]);
    expect(state(first.last)).toEqual(expect.objectContaining({ urgent: true, acknowledgeUrgency: true }));
    expect(first.context.urgencyNotedTurn).toBe(1);

    // Still due for the rest of that turn: the plan after a save is the same turn's.
    const saved = run(first.context, [{ kind: 'update', slots: { serviceType: 'towing' } }, 1]);
    expect(state(saved.last).acknowledgeUrgency).toBe(true);

    const next = run(saved.context, [{ kind: 'state' }, 2]);
    expect(state(next.last)).toEqual(expect.objectContaining({ urgent: true, acknowledgeUrgency: false }));
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

describe('what the caller has already said', () => {
  const stuck: IntakeOperation = {
    kind: 'update',
    slots: { serviceType: 'tow', location: '123 Main Street', vehicleType: 'pickup truck', vehicleCondition: "won't start" },
  };

  it("does not ask whether a vehicle that won't start can move, and marks the answer inferred", () => {
    // The real call: "it won't start", then "can it still move, or does it need to be towed?"
    const { last, context } = run(fresh(), [stuck, 1]);
    expect(state(last).nextAction).toBe('ASK_CUSTOMER_NAME');
    expect(context.values.vehicleMovable).toBe(false);
    expect(context.fieldSources?.vehicleMovable).toBe('inferred');
    expect(buildLeadNotes(context)).toContain('Vehicle movable "no" was inferred');
  });

  it("infers it from the caller's own line when the model saved no condition", () => {
    const { context } = run(
      fresh(),
      [{ kind: 'update', slots: { serviceType: 'tow', location: '123 Main Street', vehicleType: 'pickup truck' } }, 1],
      [{ kind: 'caller_speech', text: 'The engine died on me and it is stuck in the right lane.' }, 1],
    );
    expect(context.values.vehicleMovable).toBe(false);
    expect(context.fieldSources?.vehicleMovable).toBe('inferred');
  });

  it('asks about movement when the condition says nothing about it', () => {
    const { last } = run(fresh(), [{ ...stuck, slots: { ...stuck.slots, vehicleCondition: 'making a grinding noise' } }, 1]);
    expect(state(last).nextAction).toBe('ASK_VEHICLE_MOVABLE');
  });

  it("takes the caller's own answer over the inference", () => {
    const inferred = run(fresh(), [stuck, 1]);
    const { context } = run(inferred.context, [{ kind: 'update', slots: { vehicleMovable: true } }, 2]);
    expect(context.values.vehicleMovable).toBe(true);
    expect(context.fieldSources?.vehicleMovable).toBe('stated');
  });
});

describe('business information', () => {
  it('answers from configuration only', () => {
    const { last, effects } = run(fresh(), { kind: 'business_info', topic: 'service_area', question: 'Do you cover Dallas?' });
    expect(last.output.answered).toBe(true);
    expect(last.output.fact).toContain('Dallas');
    expect(has(effects, 'CREATE_CALLBACK')).toBe(false);
  });

  it('raises one callback for questions it cannot answer', () => {
    const { last, effects } = run(
      fresh(),
      { kind: 'business_info', topic: 'hours', question: 'Are you open on Sundays?' },
      { kind: 'business_info', topic: 'contact_details', question: 'What is your address?' },
    );
    expect(last.output.answered).toBe(false);
    expect(last.output.rule).toContain('carry on from where you were');
    expect(effects.filter((e) => e.type === 'CREATE_CALLBACK')).toHaveLength(1);
  });

  it('has a ready answer for the price and the arrival time, and notes on the call what was promised', () => {
    // The real call: each of these raised a callback and "I can't confirm that".
    const { context, last, effects } = run(
      fresh(),
      { kind: 'business_info', topic: 'pricing', question: 'How much is a tow?' },
      { kind: 'business_info', topic: 'eta', question: 'When will you get here?' },
      { kind: 'business_info', topic: 'eta', question: 'How soon?' },
    );

    expect(last.output.rule).toContain(ETA_ANSWER);
    expect(effects.filter((e) => e.type === 'CREATE_CALLBACK')).toHaveLength(0);
    expect(context.callbackRaised).toBe(false);
    expect(context.callerAsked).toEqual(['price', 'eta']);
  });

  it('knows a question about the price or the time by its words, whatever topic the model gave it', () => {
    const { context, last } = run(fresh(), { kind: 'business_info', topic: null, question: 'What will it cost me?' });
    expect(last.output.rule).toContain(PRICE_ANSWER);
    expect(context.callerAsked).toEqual(['price']);
  });

  it('notes what the caller asked from what they said, with no lookup at all', () => {
    const { context } = run(fresh(), { kind: 'caller_speech', text: 'How long will it take to get someone to help me?' });
    expect(context.callerAsked).toEqual(['eta']);
    expect(run(fresh(), { kind: 'caller_speech', text: "It's a Hyundai Sonata." }).context.callerAsked).toBeUndefined();
  });

  it('changes nothing that was saved or asked: a question does not reset the intake', () => {
    const before = run(fresh(), [everything, 1], [{ kind: 'update', slots: {}, callerIdConfirmed: true }, 2]).context;
    const after = applyIntake(before, { kind: 'business_info', topic: 'eta', question: 'How soon?' }, CONFIG, { callerTurn: 3 }).context;

    expect(after.values).toEqual(before.values);
    expect(after.pendingConfirmation).toEqual(before.pendingConfirmation);
    expect(after.phoneConfirmed).toBe(true);
    expect(after.fieldVersion).toBe(before.fieldVersion);
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

describe('notes', () => {
  it('refuses the model\'s own commentary, and says why', () => {
    // The real call: seven updates, each rewriting the notes with an observation.
    for (const commentary of ['Caller feels they are being cut off, unsure why.', 'Caller confirmed they are safe.', 'The caller needs help quickly.']) {
      const { context, last } = run(fresh(), { kind: 'update', slots: { additionalNotes: commentary } });
      expect(context.values.additionalNotes).toBeUndefined();
      expect(last.output.rejected).toEqual([expect.objectContaining({ field: 'additionalNotes', reason: expect.stringContaining('observation') })]);
    }
  });

  it('keeps a message the caller asked to pass on', () => {
    const { context, last } = run(fresh(), { kind: 'update', slots: { additionalNotes: 'Gate code is 4412, call when outside.' } });
    expect(context.values.additionalNotes).toBe('Gate code is 4412, call when outside.');
    expect(last.output.rejected).toEqual([]);
  });

  it('saves the rest of an update whose notes were refused', () => {
    const { context } = run(fresh(), { kind: 'update', slots: { customerName: 'Mike', additionalNotes: 'Caller sounds stressed.' } });
    expect(context.values.customerName).toBe('Mike');
    expect(context.values.additionalNotes).toBeUndefined();
  });
});

describe('a question while the receptionist waits for a yes', () => {
  /** Everything saved, the number confirmed on turn 2, and the details read back on that turn. */
  const readBackDone = () => run(fresh(), [everything, 1], [{ kind: 'update', slots: {}, callerIdConfirmed: true }, 2]).context;
  const stateAt = (ctx: ConversationContext, callerTurn: number) => applyIntake(ctx, { kind: 'state' }, CONFIG, { callerTurn });

  it('is answered first, and the details are not put in front of the model to read out again', () => {
    // The real call: "How much will it cost me?" got every detail read back, three times.
    const waiting = state(stateAt(readBackDone(), 3));

    expect(waiting.nextAction).toBe('AWAIT_CONFIRMATION');
    expect(waiting.readBack).toBeUndefined();
    expect(waiting.ask).toContain('Do NOT read them out again');
    expect(waiting.ask).toContain('answer that first');
  });

  const ASKED = 'How much will it cost me?';
  const question: CallJudgments = { move: { text: ASKED, callerTurn: -1, move: 'question', confidence: 0.99, topic: 'price' } };
  const replied = (reply: string, answered: number): CallJudgments => ({ reply: { text: ASKED, reply, answered } });
  const judge = (ctx: ConversationContext, judgments: CallJudgments, callerTurn: number) =>
    applyIntake(ctx, { kind: 'judgment', text: ASKED, judgments }, CONFIG, { callerTurn }).context;

  it('is never put to the model again once it has been answered', () => {
    // The real call, exactly: the cost was asked and answered, the caller said
    // "Yes", and the cost was answered a second time. The call never completed.
    let ctx = judge(readBackDone(), question, 3);
    ctx = judge(ctx, replied("I don't have the current price on this line. Were those details right?", 0.97), 3);

    expect(state(stateAt(ctx, 3)).callerSaid).toBeUndefined();
    expect(state(stateAt(ctx, 4)).callerSaid).toBeUndefined();
    expect(applyIntake(ctx, { kind: 'complete', callerConfirmed: true }, CONFIG, { callerTurn: 4 }).ended).toBe(true);
  });

  it('is not put to the model on a guess: until the reply has been judged, nothing is said of it', () => {
    const ctx = judge(readBackDone(), question, 3);
    expect(state(stateAt(ctx, 3)).callerSaid).toBeUndefined();
    expect(state(stateAt(ctx, 4)).callerSaid).toBeUndefined();
  });

  it('is put to the model once, on the next turn, when the reply is known to have missed it', () => {
    // The real call: "What will it cost me?" - "Is that all correct?"
    let ctx = judge(readBackDone(), question, 3);
    ctx = judge(ctx, replied('Is that all correct?', 0.04), 3);

    const next = stateAt(ctx, 4);
    expect(state(next).callerSaid).toEqual({ kind: 'question', text: ASKED });
    // More may go back to the model on that turn; after it, the matter is closed.
    expect(state(stateAt(next.context, 4)).callerSaid).toEqual({ kind: 'question', text: ASKED });
    expect(state(stateAt(next.context, 5)).callerSaid).toBeUndefined();
  });

  it('counts as answered if anything said on that turn answered it', () => {
    let ctx = judge(readBackDone(), question, 3);
    ctx = judge(ctx, replied('One moment.', 0.05), 3);
    ctx = judge(ctx, replied("One moment. I don't have the current price on this line.", 0.95), 3);
    ctx = judge(ctx, replied('One moment.', 0.05), 3); // a late, lower judgment changes nothing
    expect(ctx.judgments?.move?.answered).toBe(0.95);
    expect(state(stateAt(ctx, 4)).callerSaid).toBeUndefined();
  });

  it('is noted on the call, so the towing team keeps what was promised', () => {
    expect(judge(readBackDone(), question, 3).callerAsked).toEqual(['price']);
  });

  it('that cut the read-back short has the details finished once, after the answer', () => {
    const cut = applyIntake(readBackDone(), { kind: 'read_back_cut', heard: 'Let me read that back. Your name is Ali, you need a tow' }, CONFIG).context;

    const thisTurn = stateAt(cut, 3);
    expect(state(thisTurn).nextAction).toBe('AWAIT_CONFIRMATION');
    expect(state(thisTurn).ask).toContain('they heard only: "Let me read that back. Your name is Ali, you need a tow"');
    expect(state(thisTurn).ask).toContain('Answer what the caller just said FIRST');
    expect(state(thisTurn).ask).toContain('do not start it again from the beginning');
    expect(state(thisTurn).readBack).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Callback number' })]));
    expect(state(thisTurn).readBackHeard).toBe('Let me read that back. Your name is Ali, you need a tow');

    // Still this turn when the answer has been looked up.
    const afterLookup = applyIntake(thisTurn.context, { kind: 'business_info', topic: null, question: 'How long?' }, CONFIG, { callerTurn: 3 });
    expect(state(afterLookup).readBack).toBeDefined();

    // From the next turn on, they have heard them.
    const nextTurn = state(stateAt(afterLookup.context, 4));
    expect(nextTurn.readBack).toBeUndefined();
    expect(nextTurn.ask).toContain('Do NOT read them out again');
  });

  it('still completes on a yes', () => {
    const waiting = stateAt(readBackDone(), 3).context;
    const done = applyIntake(waiting, { kind: 'complete', callerConfirmed: true }, CONFIG, { callerTurn: 3 });
    expect(done.ended).toBe(true);
    expect(done.context.detailsConfirmed).toBe(true);
  });

  it('ignores a cut read-back once the details have changed', () => {
    const changed = applyIntake(readBackDone(), { kind: 'update', slots: { vehicleMake: 'Ford' } }, CONFIG, { callerTurn: 3 }).context;
    const stale = { ...changed, pendingConfirmation: { ...changed.pendingConfirmation!, fieldVersion: 0 } };
    expect(applyIntake(stale, { kind: 'read_back_cut', heard: 'Let me' }, CONFIG).context.pendingConfirmation?.cutAfter).toBeUndefined();
  });
});

describe('the same question, turn after turn', () => {
  const stateAt = (ctx: ConversationContext, callerTurn: number) => applyIntake(ctx, { kind: 'state' }, CONFIG, { callerTurn });

  it('is counted once per caller turn, however often the model is told on that turn', () => {
    let ctx = stateAt(fresh(), 1).context;
    ctx = stateAt(ctx, 1).context;
    ctx = applyIntake(ctx, { kind: 'business_info', topic: 'eta', question: 'How soon?' }, CONFIG, { callerTurn: 1 }).context;
    expect(ctx.asked?.ASK_SERVICE_TYPE).toEqual({ count: 1, turn: 1 });

    ctx = stateAt(ctx, 2).context;
    expect(ctx.asked?.ASK_SERVICE_TYPE).toEqual({ count: 2, turn: 2 });
  });

  it('is not counted by the caller speaking, only by the model being told to ask', () => {
    const ctx = applyIntake(fresh(), { kind: 'caller_speech', text: 'Hello?' }, CONFIG, { callerTurn: 1 }).context;
    expect(ctx.asked).toBeUndefined();
  });

  it('is taken back when the caller heard none of the question, on the turn it was counted', () => {
    // The real call: "Where is the vehicle right now?", cut with nothing heard, was one of three asks.
    const unheard = (ctx: ConversationContext, callerTurn: number) =>
      applyIntake(ctx, { kind: 'ask_unheard', action: 'ASK_SERVICE_TYPE' }, CONFIG, { callerTurn }).context;
    const once = stateAt(fresh(), 1).context;
    expect(unheard(once, 1).asked?.ASK_SERVICE_TYPE).toBeUndefined();

    const twice = stateAt(once, 2).context;
    expect(unheard(twice, 2).asked?.ASK_SERVICE_TYPE).toEqual({ count: 1, turn: 2 });
    // Too late: the caller has had another turn since.
    expect(unheard(twice, 1).asked?.ASK_SERVICE_TYPE).toEqual({ count: 2, turn: 2 });
    // The next turn counts it as the second ask, not the third.
    expect(stateAt(unheard(twice, 2), 3).context.asked?.ASK_SERVICE_TYPE).toEqual({ count: 2, turn: 3 });
  });

  it('ends: a location the model was unsure of is checked once, and the call goes on', () => {
    // The real call, turn by turn: saved as unsure, then "Yep", "Yes", and
    // nothing saved again by the model.
    let ctx = applyIntake(
      fresh(),
      { kind: 'update', slots: { serviceType: 'tow', location: '12 Ocean Drive', vehicleType: 'car' }, unsure: ['location'] },
      CONFIG,
      { callerTurn: 1 },
    ).context;
    const actions: string[] = [];
    for (let turn = 2; turn <= 5; turn += 1) {
      const next = stateAt(ctx, turn);
      actions.push(state(next).nextAction);
      ctx = next.context;
    }
    expect(actions).toEqual(['ASK_VEHICLE_MOVABLE', 'ASK_VEHICLE_MOVABLE', 'ASK_VEHICLE_MOVABLE', 'ASK_CUSTOMER_NAME']);
    // The lead still says it was not clearly heard.
    expect(ctx.fieldSources?.location).toBe('unsure');
  });
});

describe('a year is not a model', () => {
  it('notes the year, refuses it as the model, and asks about the vehicle again', () => {
    // The real call: "What's the model of the Honda?" - "It's twenty-twenty-two."
    const { context, last } = run(
      fresh(),
      { kind: 'update', slots: { serviceType: 'tow', location: '123 Main Street', vehicleMake: 'Honda' } },
      { kind: 'update', slots: { vehicleModel: '2022' } },
    );

    expect(context.values.vehicleModel).toBeUndefined();
    expect(context.values.additionalNotes).toBe('Vehicle year: 2022.');
    expect(last.output.rejected).toEqual([expect.objectContaining({ field: 'vehicleModel', reason: expect.stringContaining('2022 is the year') })]);
    expect(state(last).nextAction).toBe('ASK_VEHICLE');
  });

  it('keeps what the caller asked to pass on when it adds the year', () => {
    const { context } = run(
      fresh(),
      { kind: 'update', slots: { additionalNotes: 'Gate code is 4412.' } },
      { kind: 'update', slots: { vehicleModel: '1998' } },
    );
    expect(context.values.additionalNotes).toBe('Gate code is 4412. Vehicle year: 1998.');
  });

  it('leaves a model with a number in it alone', () => {
    const { context } = run(fresh(), { kind: 'update', slots: { vehicleMake: 'Mazda', vehicleModel: '3' } }, { kind: 'update', slots: { vehicleModel: 'F-150' } });
    expect(context.values.vehicleModel).toBe('F-150');
  });
});

describe('the help the caller needs, from what they described', () => {
  const service = (text: string, kind: 'tow' | 'jump_start' | 'unclear', confidence: number, alternatives: Array<'tow' | 'jump_start'>): CallJudgments => ({
    service: { text, service: kind, confidence, alternatives },
  });

  it('saves the help the judge is sure of as inferred, and the caller\'s words as what is wrong', () => {
    const judgments = service("it's stuck, it's not moving", 'tow', 0.9, ['tow']);
    const saved = applyIntake(fresh(), { kind: 'update', slots: { serviceType: "it's stuck, it's not moving" } }, CONFIG, { judgments });

    expect(saved.context.values.serviceType).toBe('tow');
    expect(saved.context.values.vehicleCondition).toBe("it's stuck, it's not moving");
    expect(saved.context.fieldSources?.serviceType).toBe('inferred');
    expect(state(saved).nextAction).toBe('ASK_LOCATION');
  });

  it('offers the two likeliest kinds of help when the judge cannot tell, instead of asking what they need again', () => {
    // The real call: "won't start" on a highway went onto the lead as the service.
    const judgments = service("won't start", 'jump_start', 0.5, ['jump_start', 'tow']);
    const saved = applyIntake(fresh(), { kind: 'update', slots: { serviceType: "won't start" } }, CONFIG, { judgments });

    expect(saved.context.values.serviceType).toBeUndefined();
    expect(saved.context.values.vehicleCondition).toBe("won't start");
    expect(saved.output.rejected).toEqual([expect.objectContaining({ field: 'serviceType' })]);
    expect(state(saved).nextAction).toBe('ASK_SERVICE_TYPE');
    expect(state(saved).ask).toContain('ask whether they need a jump start or a tow');
    expect(state(saved).ask).toContain('"won\'t start"');
  });

  it('keeps the caller\'s own words when they name the help', () => {
    const judgments = service('a tow', 'tow', 0.99, ['tow']);
    const saved = applyIntake(fresh(), { kind: 'update', slots: { serviceType: 'a tow' } }, CONFIG, { judgments });
    expect(saved.context.values.serviceType).toBe('a tow');
    expect(saved.context.fieldSources?.serviceType).toBe('stated');
  });

  it('saves the help from a line the caller spoke, once the judge has read it, if none was saved', () => {
    const text = "It's stuck. It's not moving.";
    const heard = applyIntake(fresh(), { kind: 'caller_speech', text }, CONFIG, { callerTurn: 3 });
    expect(heard.plan.action).toBe('ASK_SERVICE_TYPE');

    const judged = applyIntake(heard.context, { kind: 'judgment', text, judgments: service(text, 'tow', 0.88, ['tow']) }, CONFIG, { callerTurn: 3 });
    expect(judged.context.values.serviceType).toBe('tow');
    expect(judged.context.fieldSources?.serviceType).toBe('inferred');
    expect(judged.plan.action).toBe('ASK_LOCATION');
    expect(logged(judged.effects, CallEventType.FIELD_EXTRACTED)).toBe(true);
  });

  it('does not overwrite help the caller has already asked for', () => {
    const asked = run(fresh(), { kind: 'update', slots: { serviceType: 'jump start' } }).context;
    const judged = applyIntake(asked, { kind: 'judgment', text: 'it is dead', judgments: service('it is dead', 'tow', 0.95, ['tow']) }, CONFIG);
    expect(judged.context.values.serviceType).toBe('jump start');
  });
});

describe('a judgment that arrives after the line', () => {
  const SPOKEN = 'Why do you keep cutting me off?';
  const complaint: CallJudgments = {
    move: { text: SPOKEN, callerTurn: -1, move: 'complaint', confidence: 0.9 },
    risk: { text: SPOKEN, danger: 0.02, hazard: 'none', hazardProbability: 0, urgent: 0.1 },
  };

  it('is not the caller speaking again: no turn is counted and nothing is issued', () => {
    const heard = applyIntake(fresh(), { kind: 'caller_speech', text: SPOKEN }, CONFIG, { callerTurn: 2 });
    const judged = applyIntake(heard.context, { kind: 'judgment', text: SPOKEN, judgments: complaint }, CONFIG, { callerTurn: 2 });

    expect(judged.context.turnCount).toBe(heard.context.turnCount);
    expect(judged.effects).toEqual([]);
    expect(judged.context.judgments?.move).toEqual({ text: SPOKEN, callerTurn: 2, move: 'complaint', confidence: 0.9 });
  });

  it('reminds the model of a complaint it talked past, and only of that', () => {
    // The real call: "Why do you keep cutting me off?" - "What kind of help do you need right now?"
    const heard = applyIntake(fresh(), { kind: 'judgment', text: SPOKEN, judgments: complaint }, CONFIG, { callerTurn: 2 }).context;
    const at = (ctx: ConversationContext, callerTurn: number) => state(applyIntake(ctx, { kind: 'state' }, CONFIG, { callerTurn })).callerSaid;
    expect(at(heard, 3)).toBeUndefined();

    const missed: CallJudgments = { reply: { text: SPOKEN, reply: 'What kind of help do you need right now?', answered: 0.03 } };
    const known = applyIntake(heard, { kind: 'judgment', text: SPOKEN, judgments: missed }, CONFIG, { callerTurn: 2 }).context;
    expect(at(known, 3)).toEqual({ kind: 'complaint', text: SPOKEN });

    const apologised: CallJudgments = { reply: { text: SPOKEN, reply: "Sorry about that. I'm listening.", answered: 0.96 } };
    const settled = applyIntake(heard, { kind: 'judgment', text: SPOKEN, judgments: apologised }, CONFIG, { callerTurn: 2 }).context;
    expect(at(settled, 3)).toBeUndefined();
  });

  it('does not remind the model of a line with no English letters in it', () => {
    // The real calls: "그런데 못 먹어." and "어" from an English-speaking caller: the transcriber's guess at unclear audio.
    const garbled = '그런데 못 먹어?';
    const judgments: CallJudgments = {
      move: { text: garbled, callerTurn: -1, move: 'question', confidence: 0.85 },
      reply: { text: garbled, reply: 'Where is the vehicle?', answered: 0.05 },
    };
    const heard = applyIntake(fresh(), { kind: 'judgment', text: garbled, judgments }, CONFIG, { callerTurn: 2 }).context;
    expect(state(applyIntake(heard, { kind: 'state' }, CONFIG, { callerTurn: 3 })).callerSaid).toBeUndefined();
  });

  it('ignores a judgment of a reply to some other line', () => {
    const heard = applyIntake(fresh(), { kind: 'judgment', text: SPOKEN, judgments: complaint }, CONFIG, { callerTurn: 2 }).context;
    const other: CallJudgments = { reply: { text: 'How soon?', reply: 'Where is the vehicle?', answered: 0.02 } };
    const after = applyIntake(heard, { kind: 'judgment', text: 'How soon?', judgments: other }, CONFIG, { callerTurn: 2 }).context;
    expect(after.judgments?.move?.answered).toBeUndefined();
  });

  it('says nothing of a line that was an answer, or that the judge was unsure of', () => {
    const answer: CallJudgments = { move: { text: 'It is a Honda', callerTurn: -1, move: 'request', confidence: 0.95 } };
    const unsure: CallJudgments = { move: { text: 'hmm why', callerTurn: -1, move: 'complaint', confidence: 0.4 } };
    for (const judgments of [answer, unsure]) {
      const heard = applyIntake(fresh(), { kind: 'judgment', text: judgments.move!.text, judgments }, CONFIG, { callerTurn: 2 }).context;
      expect(state(applyIntake(heard, { kind: 'state' }, CONFIG, { callerTurn: 2 })).callerSaid).toBeUndefined();
    }
  });

  it('gives safety advice as soon as the judgment of a line says there is danger', () => {
    const text = 'my car rolled into the ditch and my leg is stuck';
    const heard = applyIntake(fresh(), { kind: 'caller_speech', text }, CONFIG, { callerTurn: 1 });
    expect(heard.plan.action).not.toBe('HANDLE_SAFETY');

    const judgments: CallJudgments = { risk: { text, danger: 0.95, hazard: 'injury', hazardProbability: 0.5, urgent: 0.7 } };
    const judged = applyIntake(heard.context, { kind: 'judgment', text, judgments }, CONFIG, { callerTurn: 1, emergencyNumber: '911' });
    expect(judged.plan.action).toBe('HANDLE_SAFETY');
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

describe("confirmations judged from the caller's words", () => {
  const said = (text: string, confirms: number, corrects: number): CallJudgments => ({
    confirmation: { text, callerTurn: -1, confirms, corrects },
  });
  /** The read-back has been issued on turn 2; the caller answers on turn 3. */
  const readBackIssued = () => run(fresh(), [everything, 1], [{ kind: 'update', slots: {}, callerIdConfirmed: true }, 2]).context;
  const heard = (ctx: ConversationContext, text: string, judgments: CallJudgments, callerTurn: number) =>
    applyIntake(ctx, { kind: 'caller_speech', text }, CONFIG, { callerTurn, judgments }).context;
  const complete = (ctx: ConversationContext, callerTurn: number) =>
    applyIntake(ctx, { kind: 'complete', callerConfirmed: true }, CONFIG, { callerTurn });

  it('refuses to complete when the caller\'s latest words were not a yes', () => {
    const ctx = heard(readBackIssued(), 'Hello? Are you there?', said('Hello? Are you there?', 0.05, 0.02), 3);
    const done = complete(ctx, 3);

    expect(done.ended).toBe(false);
    expect(done.output.needsConfirmation).toBe(true);
    expect(done.output.reason).toContain('"Hello? Are you there?"');
    expect(done.effects.some((e) => e.type === 'CREATE_LEAD')).toBe(false);
  });

  it('tells the model to save a correction before confirming', () => {
    const ctx = heard(readBackIssued(), "No wait, it's a Ford.", said("No wait, it's a Ford.", 0.1, 0.92), 3);
    expect(complete(ctx, 3).output.reason).toContain('correcting');
  });

  it('completes when the caller said yes', () => {
    const ctx = heard(readBackIssued(), "Yep, that's it.", said("Yep, that's it.", 0.95, 0.03), 3);
    const done = complete(ctx, 3);
    expect(done.ended).toBe(true);
    expect(done.effects.some((e) => e.type === 'CREATE_LEAD')).toBe(true);
  });

  it('does not hold an earlier line against a later turn whose words have not arrived', () => {
    // Transcripts lag: the "yes" on turn 4 may reach the backend after the model acts on it.
    const ctx = heard(readBackIssued(), 'Hello?', said('Hello?', 0.05, 0.02), 3);
    expect(complete(ctx, 4).ended).toBe(true);
  });

  it('forgets the answer once the details are read back again', () => {
    const ctx = heard(readBackIssued(), "No wait, it's a Ford.", said("No wait, it's a Ford.", 0.1, 0.92), 3);
    const changed = applyIntake(ctx, { kind: 'update', slots: { vehicleMake: 'Ford' } }, CONFIG, { callerTurn: 3 });

    expect(state(changed).nextAction).toBe('CONFIRM_DETAILS');
    expect(changed.context.judgments?.confirmation).toBeUndefined();
  });

  it('applies the same check to the callback number', () => {
    const asked = run(fresh(), [everything, 1]).context;
    const ctx = heard(asked, 'No, use my work number.', said('No, use my work number.', 0.05, 0.9), 2);
    const answered = applyIntake(ctx, { kind: 'update', slots: {}, callerIdConfirmed: true }, CONFIG, { callerTurn: 2 });

    expect(answered.context.phoneConfirmed).toBe(false);
    expect(answered.output.rejected).toEqual([expect.objectContaining({ field: 'callerIdConfirmed', reason: expect.stringContaining('correcting') })]);
  });
});

describe('the backend acts on a clear yes the model did not save', () => {
  const said = (text: string, confirms: number, corrects: number): CallJudgments => ({
    confirmation: { text, callerTurn: -1, confirms, corrects },
  });
  /** What the gateway applies once the judge has read the caller's line. */
  const judged = (ctx: ConversationContext, text: string, judgments: CallJudgments, callerTurn: number) =>
    applyIntake(ctx, { kind: 'judgment', text, judgments }, CONFIG, { callerTurn, defaultRegionPrefix: '+1', emergencyNumber: '911' });
  /** Every detail saved on turn 1; the number question is put on that turn. */
  const numberAsked = () => run(fresh(), [everything, 1]).context;
  /** The number confirmed on turn 2, and the read-back put on that turn. */
  const readBackIssued = () => run(fresh(), [everything, 1], [{ kind: 'update', slots: {}, callerIdConfirmed: true }, 2]).context;

  it('confirms the number on a clear yes, on a later turn than the question', () => {
    // The real calls: "Yes." to the number question three times, judged 0.96, nothing saved.
    expect(state(applyIntake(numberAsked(), { kind: 'state' }, CONFIG, { callerTurn: 1 })).nextAction).toBe('CONFIRM_CALLBACK_NUMBER');
    const result = judged(numberAsked(), 'Yes.', said('Yes.', 0.96, 0.04), 2);

    expect(result.context.phoneConfirmed).toBe(true);
    expect(result.context.pendingConfirmation).toBeNull();
    expect(result.context.fieldSources?.customerPhone).toBe('caller_id');
    expect(result.plan.action).toBe('CONFIRM_DETAILS');
    expect(payloads(result.effects, CallEventType.CONFIRMATION_JUDGED)).toEqual([
      expect.objectContaining({ kind: 'callback_number', text: 'Yes.', confirms: 0.96, turn: 2 }),
    ]);
    expect(payloads(result.effects, CallEventType.FIELD_EXTRACTED)).toEqual([
      expect.objectContaining({ field: 'customerPhone', value: '+18174098408', source: 'caller_id_confirmed: the caller said "Yes."' }),
    ]);
  });

  it('does not take a yes on the turn the question was put, or one that corrects something', () => {
    expect(judged(numberAsked(), 'Yes.', said('Yes.', 0.96, 0.04), 1).context.phoneConfirmed).toBe(false);
    expect(judged(numberAsked(), 'No, use my work number.', said('No, use my work number.', 0.05, 0.9), 2).context.phoneConfirmed).toBe(false);
    expect(judged(numberAsked(), "Yes, but it's my wife's phone.", said("Yes, but it's my wife's phone.", 0.8, 0.6), 2).context.phoneConfirmed).toBe(false);
    expect(judged(numberAsked(), 'Maybe.', said('Maybe.', 0.5, 0.1), 2).context.phoneConfirmed).toBe(false);
  });

  it('does not take a yes to something else for a yes to the number', () => {
    const inDanger = { ...numberAsked(), safety: { hazard: 'an accident', issuedAtTurn: null } };
    expect(judged(inDanger, 'Yes.', said('Yes.', 0.96, 0.04), 2).context.phoneConfirmed).toBe(false);
  });

  it('lets the model report the same yes afterwards without complaint', () => {
    const confirmed = judged(numberAsked(), 'Yes.', said('Yes.', 0.96, 0.04), 2).context;
    const reported = applyIntake(confirmed, { kind: 'update', slots: {}, callerIdConfirmed: true }, CONFIG, { callerTurn: 2 });
    expect(reported.output.rejected).toEqual([]);
    expect(logged(reported.effects, CallEventType.CONFIRMATION_REJECTED)).toBe(false);
    expect(reported.context.phoneConfirmed).toBe(true);
  });

  it('completes the request on a clear yes to the read-back', () => {
    const result = judged(readBackIssued(), "Yep, that's it.", said("Yep, that's it.", 0.95, 0.03), 3);

    expect(result.ended).toBe(true);
    expect(result.context.detailsConfirmed).toBe(true);
    expect(result.effects.some((e) => e.type === 'CREATE_LEAD')).toBe(true);
    expect(logged(result.effects, CallEventType.LEAD_CREATED)).toBe(true);
    expect(payloads(result.effects, CallEventType.CONFIRMATION_JUDGED)).toEqual([expect.objectContaining({ kind: 'details', text: "Yep, that's it." })]);
    expect(result.plan.action).toBe('CLOSE');
  });

  it('does not complete on the turn the read-back was put, on a stale read-back, or one the caller cut short', () => {
    expect(judged(readBackIssued(), 'Yes.', said('Yes.', 0.95, 0.03), 2).ended).toBe(false);

    const changed = { ...readBackIssued(), fieldVersion: (readBackIssued().fieldVersion ?? 0) + 1 };
    expect(judged(changed, 'Yes.', said('Yes.', 0.95, 0.03), 3).ended).toBe(false);

    // The real call: "Yes, yes, it's the best number" over the read-back, heard as far as the number.
    const cut = applyIntake(readBackIssued(), { kind: 'read_back_cut', heard: 'Let me read that back. Your name is Mike' }, CONFIG).context;
    expect(judged(cut, "Yes, yes, it's the best number to reach me.", said("Yes, yes, it's the best number to reach me.", 0.95, 0.04), 3).ended).toBe(false);
  });

  it('completes on a yes after a cut read-back has been finished', () => {
    const cut = applyIntake(readBackIssued(), { kind: 'read_back_cut', heard: 'Let me read that back. Your name is Mike' }, CONFIG).context;
    // Told to finish it on turn 3; the caller answers on turn 4.
    const resumed = applyIntake(cut, { kind: 'state' }, CONFIG, { callerTurn: 3 }).context;
    expect(judged(resumed, 'Yes, all correct.', said('Yes, all correct.', 0.95, 0.03), 4).ended).toBe(true);
  });

  it('treats a complete_request from the model after that as already done', () => {
    const done = judged(readBackIssued(), "Yep, that's it.", said("Yep, that's it.", 0.95, 0.03), 3).context;
    const again = applyIntake(done, { kind: 'complete', callerConfirmed: true }, CONFIG, { callerTurn: 3 });
    expect(again.ended).toBe(true);
    expect(again.effects.some((e) => e.type === 'CREATE_LEAD')).toBe(false);
  });
});
