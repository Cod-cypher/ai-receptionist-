import { describe, expect, it } from 'vitest';
import {
  ConversationState,
  EMPTY_EXTRACTION,
  validateSlots,
  type BusinessFacts,
  type CustomerIntent,
  type ExtractionResult,
  type FaqTopic,
} from '@towai/shared';

import { finish, reduce } from './state-machine';
import {
  initialContext,
  type ConversationContext,
  type Directive,
  type Effect,
  type FlowConfig,
  type TurnDecision,
} from './types';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const FACTS: BusinessFacts = {
  name: 'Liberty Towing',
  phone: '+924235000000',
  website: 'https://libertytowing.example',
  address: '12 Main Boulevard, Gulberg, Lahore',
  serviceAreas: ['Lahore', 'Gulberg', 'DHA', 'Model Town'],
  services: ['Local towing', 'Flatbed towing', 'Jump starts', 'Tire changes', 'Lockouts'],
  businessHoursText: 'Monday: 00:00-23:59, Tuesday: 00:00-23:59',
  isOpenNow: true,
  pricingInfo: 'Local tows start at PKR 3,500. Long distance is quoted per kilometre.',
  emergencyContact: '+923001234567',
  faq: [
    {
      question: 'Do you tow motorcycles?',
      answer: 'Yes, we tow motorcycles using a flatbed.',
    },
  ],
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

/** A caller ID is always present in a real call; the engine seeds it. */
function freshContext(): ConversationContext {
  return initialContext({ customerPhone: '+923001234567' });
}

type SlotPatch = Partial<Record<string, unknown>>;

function extraction(
  intent: CustomerIntent,
  slots: SlotPatch = {},
  extra: Partial<ExtractionResult> = {},
): ExtractionResult {
  return {
    ...EMPTY_EXTRACTION,
    ...extra,
    intent,
    slots: { ...EMPTY_EXTRACTION.slots, ...(slots as object) } as ExtractionResult['slots'],
  };
}

/** Drives one customer turn through validation and the reducer, as production does. */
function say(
  ctx: ConversationContext,
  transcript: string,
  intent: CustomerIntent,
  slots: SlotPatch = {},
  extra: Partial<ExtractionResult> = {},
): TurnDecision {
  const ex = extraction(intent, slots, extra);
  const { accepted, rejected } = validateSlots(slots as never, {
    defaultRegionPrefix: '+92',
  });
  return reduce(
    ctx,
    { kind: 'UTTERANCE', transcript, extraction: ex, accepted, rejected },
    CONFIG,
  );
}

const effectTypes = (effects: Effect[]) => effects.map((e) => e.type);
const hasEffect = (effects: Effect[], type: Effect['type']) =>
  effects.some((e) => e.type === type);

/** The requirement a directive is asking about, for concise assertions. */
function askedFor(directive: Directive): string | null {
  if (directive.kind === 'ASK' || directive.kind === 'REASK') return directive.requirement.id;
  return null;
}

/* -------------------------------------------------------------------------- */
/*  The specification's worked example                                        */
/* -------------------------------------------------------------------------- */

describe('the broken-down-car call from the spec', () => {
  it('collects the lead in the documented order and creates it on confirmation', () => {
    let ctx = freshContext();

    // Call connects.
    const greeting = reduce(ctx, { kind: 'START' }, CONFIG);
    expect(greeting.directive.kind).toBe('GREET');
    expect(greeting.context.state).toBe(ConversationState.IDENTIFY_INTENT);
    ctx = greeting.context;

    // "My car broke down."
    let turn = say(ctx, 'My car broke down.', 'provide_info', {
      serviceType: 'vehicle towing',
      vehicleCondition: 'broke down',
    });
    expect(askedFor(turn.directive)).toBe('location');
    expect(turn.context.state).toBe(ConversationState.COLLECT_LOCATION);
    ctx = turn.context;

    // "I'm near Liberty Market."
    turn = say(ctx, "I'm near Liberty Market.", 'provide_info', {
      location: 'near Liberty Market',
    });
    expect(askedFor(turn.directive)).toBe('vehicle');
    ctx = turn.context;

    // "A Toyota Corolla."
    turn = say(ctx, 'A Toyota Corolla.', 'provide_info', {
      vehicleMake: 'Toyota',
      vehicleModel: 'Corolla',
    });
    expect(askedFor(turn.directive)).toBe('vehicleMovable');
    ctx = turn.context;

    // "It can't move."
    turn = say(ctx, "It can't move.", 'provide_info', { vehicleMovable: false });
    expect(askedFor(turn.directive)).toBe('customerName');
    ctx = turn.context;

    // "Ahmed."
    turn = say(ctx, 'Ahmed.', 'provide_info', { customerName: 'Ahmed' });
    expect(askedFor(turn.directive)).toBe('customerPhone');
    expect(turn.context.state).toBe(ConversationState.CONFIRM_PHONE);
    ctx = turn.context;

    // "Yes." — confirms the caller ID, completing intake.
    turn = say(ctx, 'Yes.', 'confirm');
    expect(turn.directive.kind).toBe('CONFIRM_SUMMARY');
    expect(turn.context.state).toBe(ConversationState.CONFIRM_INFORMATION);
    ctx = turn.context;

    // The summary reads back exactly what was collected, nothing more.
    if (turn.directive.kind !== 'CONFIRM_SUMMARY') throw new Error('expected summary');
    expect(turn.directive.summary).toEqual([
      { label: 'Name', value: 'Ahmed' },
      { label: 'Service', value: 'vehicle towing' },
      { label: 'Location', value: 'near Liberty Market' },
      { label: 'Vehicle', value: 'Toyota Corolla' },
      { label: 'Vehicle movable', value: 'no' },
      { label: 'Condition', value: 'broke down' },
    ]);

    // "That's right." — the lead is created.
    turn = say(ctx, "That's right.", 'confirm');
    expect(turn.directive.kind).toBe('CLOSE');
    expect(hasEffect(turn.effects, 'CREATE_LEAD')).toBe(true);
    expect(turn.context.state).toBe(ConversationState.ENDED);
    expect(turn.context.finalised).toBe(true);

    // And the collected values are exactly what a lead needs.
    expect(turn.context.values).toMatchObject({
      customerName: 'Ahmed',
      customerPhone: '+923001234567',
      serviceType: 'vehicle towing',
      location: 'near Liberty Market',
      vehicleMake: 'Toyota',
      vehicleModel: 'Corolla',
      vehicleMovable: false,
    });
    // Nothing the caller never mentioned was invented.
    expect(turn.context.values.destination).toBeUndefined();
    expect(turn.context.values.additionalNotes).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  Out-of-order and multi-slot answers                                       */
/* -------------------------------------------------------------------------- */

describe('answers that fill several slots at once', () => {
  it('skips the questions already answered', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    // The spec's example: three fields in one breath.
    const turn = say(
      ctx,
      "I'm at Liberty Market, my car is a Honda Civic and it won't start.",
      'provide_info',
      {
        serviceType: 'vehicle towing',
        location: 'Liberty Market',
        vehicleMake: 'Honda',
        vehicleModel: 'Civic',
        vehicleMovable: false,
        vehicleCondition: "won't start",
      },
    );

    // Location, vehicle and movability are all done, so the next question is
    // the name — three states skipped without any special-casing.
    expect(askedFor(turn.directive)).toBe('customerName');
    expect(turn.context.values.location).toBe('Liberty Market');
    expect(turn.context.values.vehicleMovable).toBe(false);
  });

  it('accepts a bare vehicle type without a make or model', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    let turn = say(ctx, 'I need a tow', 'provide_info', { serviceType: 'towing' });
    ctx = turn.context;
    turn = say(ctx, 'Main Boulevard', 'provide_info', { location: 'Main Boulevard' });
    ctx = turn.context;

    // "A motorcycle" is enough for the operator to send the right truck: the
    // next question is the one after the vehicle, what is wrong with it.
    turn = say(ctx, "It's a motorcycle", 'provide_info', { vehicleType: 'motorcycle' });
    expect(askedFor(turn.directive)).toBe('vehicleCondition');
  });
});

/* -------------------------------------------------------------------------- */
/*  Corrections                                                               */
/* -------------------------------------------------------------------------- */

describe('a caller changing their answer', () => {
  it('overwrites the earlier value and logs the correction', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    let turn = say(ctx, 'Toyota Corolla, need a tow from Mall Road', 'provide_info', {
      serviceType: 'towing',
      location: 'Mall Road',
      vehicleMake: 'Toyota',
      vehicleModel: 'Corolla',
    });
    ctx = turn.context;

    turn = say(ctx, "Sorry, it's actually a Honda Civic", 'provide_info', {
      vehicleMake: 'Honda',
      vehicleModel: 'Civic',
    });

    expect(turn.context.values.vehicleMake).toBe('Honda');
    expect(turn.context.values.vehicleModel).toBe('Civic');
    expect(
      turn.effects.filter(
        (e) => e.type === 'LOG_EVENT' && e.event === 'FIELD_CORRECTED',
      ),
    ).toHaveLength(2);
  });

  it('reopens the summary when the caller rejects it, then rebuilds it', () => {
    let ctx: ConversationContext = {
      ...freshContext(),
      state: ConversationState.CONFIRM_INFORMATION,
      phoneConfirmed: true,
      values: {
        serviceType: 'towing',
        location: 'Mall Road',
        vehicleMake: 'Toyota',
        vehicleModel: 'Corolla',
        vehicleCondition: 'broke down',
        vehicleMovable: false,
        customerName: 'Ahmed',
        customerPhone: '+923001234567',
      },
    };

    // "No, that's wrong."
    let turn = say(ctx, "No, that's wrong", 'deny');
    expect(turn.directive.kind).toBe('ACKNOWLEDGE_CORRECTION');
    expect(turn.context.state).toBe(ConversationState.CORRECTING);
    expect(turn.context.awaitingCorrection).toBe(true);
    expect(hasEffect(turn.effects, 'CREATE_LEAD')).toBe(false);
    ctx = turn.context;

    // "The location is Liberty Market."
    turn = say(ctx, 'The location is Liberty Market', 'provide_info', {
      location: 'Liberty Market',
    });
    expect(turn.context.awaitingCorrection).toBe(false);
    expect(turn.context.values.location).toBe('Liberty Market');
    expect(turn.directive.kind).toBe('CONFIRM_SUMMARY');
  });
});

/* -------------------------------------------------------------------------- */
/*  Phone confirmation                                                        */
/* -------------------------------------------------------------------------- */

describe('phone confirmation', () => {
  it('does not treat the caller ID as confirmed on its own', () => {
    const ctx: ConversationContext = {
      ...freshContext(),
      values: {
        serviceType: 'towing',
        location: 'Mall Road',
        vehicleType: 'car',
        vehicleCondition: 'broke down',
        vehicleMovable: false,
        customerName: 'Ahmed',
        customerPhone: '+923001234567',
      },
    };

    // Every slot is filled, but the number has not been confirmed, so intake is
    // not complete and no lead may be created.
    const turn = say(ctx, 'ok', 'provide_info');
    expect(askedFor(turn.directive)).toBe('customerPhone');
    expect(hasEffect(turn.effects, 'CREATE_LEAD')).toBe(false);
  });

  it('takes an alternate number when the caller says no', () => {
    let ctx: ConversationContext = {
      ...freshContext(),
      state: ConversationState.CONFIRM_PHONE,
      values: {
        serviceType: 'towing',
        location: 'Mall Road',
        vehicleType: 'car',
        vehicleCondition: 'broke down',
        vehicleMovable: false,
        customerName: 'Ahmed',
        customerPhone: '+923001234567',
      },
    };

    let turn = say(ctx, 'No, call my other number', 'deny');
    expect(turn.directive.kind).toBe('ASK_ALTERNATE_PHONE');
    expect(turn.context.phoneNeedsCollection).toBe(true);
    ctx = turn.context;

    turn = say(ctx, '0300 9998888', 'provide_info', { customerPhone: '0300 9998888' });
    expect(turn.context.values.customerPhone).toBe('+923009998888');
    expect(turn.context.phoneConfirmed).toBe(true);
    expect(turn.directive.kind).toBe('CONFIRM_SUMMARY');
  });
});

/* -------------------------------------------------------------------------- */
/*  FAQs                                                                      */
/* -------------------------------------------------------------------------- */

describe('questions about the business', () => {
  it('answers from configured data and returns to the intake', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    const turn = say(ctx, 'What areas do you cover?', 'faq', {}, {
      faqQuestion: 'What areas do you cover?',
      faqTopic: 'service_area' as FaqTopic,
    });

    expect(turn.directive.kind).toBe('ANSWER_FAQ');
    if (turn.directive.kind !== 'ANSWER_FAQ') throw new Error('expected FAQ answer');
    expect(turn.directive.fact).toContain('Lahore');
    // It picks the intake back up in the same breath.
    expect(turn.directive.then).toMatchObject({ kind: 'ask' });
    expect(hasEffect(turn.effects, 'CREATE_CALLBACK')).toBe(false);
  });

  it('prefers a configured FAQ entry over the structured fields', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    const turn = say(ctx, 'Do you tow motorcycles?', 'faq', {}, {
      faqQuestion: 'Do you tow motorcycles?',
      faqTopic: 'services_offered' as FaqTopic,
    });

    if (turn.directive.kind !== 'ANSWER_FAQ') throw new Error('expected FAQ answer');
    expect(turn.directive.fact).toBe('Yes, we tow motorcycles using a flatbed.');
  });

  it('raises a callback when nothing configured covers the question', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    const bareFacts: BusinessFacts = { ...FACTS, faq: [], pricingInfo: null };
    const ex = extraction('faq', {}, {
      faqQuestion: 'How much for a 200km tow?',
      faqTopic: 'pricing' as FaqTopic,
    });

    const turn = reduce(
      ctx,
      {
        kind: 'UTTERANCE',
        transcript: 'How much for a 200km tow?',
        extraction: ex,
        accepted: {},
        rejected: [],
      },
      { ...CONFIG, facts: bareFacts },
    );

    expect(turn.directive.kind).toBe('CANNOT_ANSWER');
    expect(hasEffect(turn.effects, 'CREATE_CALLBACK')).toBe(true);
    // The call continues — a caller mid-intake is not hung up on.
    expect(turn.context.state).not.toBe(ConversationState.ENDED);
  });

  it('does not raise a second callback when the caller then hangs up', () => {
    // Found by driving the simulator: an unanswerable question followed by a
    // hang-up created two identical callback requests, so the operator got the
    // same WhatsApp twice.
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    let turn = say(ctx, 'How soon can you get here?', 'faq', {}, {
      faqQuestion: 'How soon can you get here?',
      faqTopic: 'eta' as FaqTopic,
    });
    const callbacks = turn.effects.filter((e) => e.type === 'CREATE_CALLBACK');
    ctx = turn.context;

    turn = say(ctx, 'my car broke down near Mall Road', 'provide_info', {
      serviceType: 'towing',
      location: 'Mall Road',
    });
    callbacks.push(...turn.effects.filter((e) => e.type === 'CREATE_CALLBACK'));
    ctx = turn.context;

    turn = reduce(ctx, { kind: 'HANGUP' }, CONFIG);
    callbacks.push(...turn.effects.filter((e) => e.type === 'CREATE_CALLBACK'));

    expect(callbacks).toHaveLength(1);
    expect(turn.effects).toContainEqual(expect.objectContaining({ type: 'END_CALL', outcome: 'callback_created' }));
  });

  it('still records a genuinely new request after an earlier callback', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    let turn = say(ctx, 'How soon can you get here?', 'faq', {}, {
      faqQuestion: 'How soon can you get here?',
      faqTopic: 'eta' as FaqTopic,
    });
    ctx = turn.context;

    turn = say(ctx, 'I want a refund on my last tow', 'out_of_scope', {}, {
      outOfScopeRequest: 'Refund on a previous tow',
    });

    // A different ask, so the operator needs to hear about it too.
    expect(turn.effects).toContainEqual({
      type: 'CREATE_CALLBACK',
      reason: 'Refund on a previous tow',
    });
  });

  it('never answers an arrival-time question, even with pricing configured', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    const turn = say(ctx, 'How soon can you get here?', 'faq', {}, {
      faqQuestion: 'How soon can you get here?',
      faqTopic: 'eta' as FaqTopic,
    });

    expect(turn.directive.kind).toBe('CANNOT_ANSWER');
    expect(hasEffect(turn.effects, 'CREATE_CALLBACK')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Escalation                                                                */
/* -------------------------------------------------------------------------- */

describe('requests the receptionist must not handle', () => {
  it('raises a callback and closes the call', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    const turn = say(ctx, 'Can you send a truck right now and bill my account?', 'out_of_scope', {}, {
      outOfScopeRequest: 'Caller wants a truck dispatched and billed to an account',
    });

    expect(turn.directive.kind).toBe('ESCALATE');
    expect(hasEffect(turn.effects, 'CREATE_CALLBACK')).toBe(true);
    expect(turn.context.state).toBe(ConversationState.ENDED);
  });

  it('escalates rather than asking the same question forever', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    let turn = say(ctx, 'I need a tow', 'provide_info', { serviceType: 'towing' });
    ctx = turn.context;

    // Three non-answers to the location question.
    for (let i = 0; i < 3; i += 1) {
      turn = say(ctx, 'uhh', 'provide_info');
      ctx = turn.context;
    }

    expect(turn.directive.kind).toBe('ESCALATE');
    expect(hasEffect(turn.effects, 'CREATE_CALLBACK')).toBe(true);
  });

  it('escalates after repeated unintelligible speech', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    let turn = say(ctx, '...', 'unclear');
    expect(turn.directive.kind).toBe('DID_NOT_UNDERSTAND');
    ctx = turn.context;

    turn = say(ctx, '...', 'unclear');
    ctx = turn.context;
    turn = say(ctx, '...', 'unclear');

    expect(turn.directive.kind).toBe('ESCALATE');
  });
});

/* -------------------------------------------------------------------------- */
/*  Silence and disconnection                                                 */
/* -------------------------------------------------------------------------- */

describe('silence and hang-ups', () => {
  it('reprompts once, then ends the call', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    let turn = reduce(ctx, { kind: 'SILENCE' }, CONFIG);
    expect(turn.directive.kind).toBe('PROMPT_AFTER_SILENCE');
    ctx = turn.context;

    turn = reduce(ctx, { kind: 'SILENCE' }, CONFIG);
    expect(turn.context.state).toBe(ConversationState.ENDED);
  });

  it('still creates the lead when the caller hangs up after giving everything', () => {
    const ctx: ConversationContext = {
      ...freshContext(),
      state: ConversationState.CONFIRM_INFORMATION,
      phoneConfirmed: true,
      values: {
        serviceType: 'towing',
        location: 'Liberty Market',
        vehicleMake: 'Toyota',
        vehicleModel: 'Corolla',
        vehicleCondition: 'broke down',
        vehicleMovable: false,
        customerName: 'Ahmed',
        customerPhone: '+923001234567',
      },
    };

    const turn = reduce(ctx, { kind: 'HANGUP' }, CONFIG);

    // The information is complete, so the operator gets a lead rather than an
    // "abandoned call" row they cannot act on.
    expect(hasEffect(turn.effects, 'CREATE_LEAD')).toBe(true);
    expect(turn.directive.kind).toBe('SILENT_END');
  });

  it('creates a callback when the caller hangs up part-way through', () => {
    const ctx: ConversationContext = {
      ...freshContext(),
      values: {
        serviceType: 'towing',
        location: 'Liberty Market',
        customerPhone: '+923001234567',
      },
    };

    const turn = reduce(ctx, { kind: 'HANGUP' }, CONFIG);

    expect(hasEffect(turn.effects, 'CREATE_LEAD')).toBe(false);
    expect(hasEffect(turn.effects, 'CREATE_CALLBACK')).toBe(true);
  });

  it('says in the callback what the towing team still has to ask', () => {
    const values = { vehicleType: 'Car', vehicleMovable: false, customerName: 'Ali', customerPhone: '+18174098408' };
    const callback = (ctx: ConversationContext) => finish(ctx, { spoken: true }).effects.find((e) => e.type === 'CREATE_CALLBACK');

    // A real call: the caller confirmed a read-back that had no location in it.
    expect(callback({ ...freshContext(), values, detailsConfirmed: true })).toMatchObject({
      reason: 'The caller confirmed the details read back; never given: what help they need, the location, what is wrong with the vehicle.',
    });
    expect(callback({ ...freshContext(), values })).toMatchObject({
      reason: 'Call ended before all details were collected. Still needed: what help they need, the location, what is wrong with the vehicle.',
    });
  });

  it('records nothing when a caller hangs up having said nothing at all', () => {
    const turn = reduce(freshContext(), { kind: 'HANGUP' }, CONFIG);

    expect(effectTypes(turn.effects)).toEqual(['END_CALL']);
    expect(turn.effects[0]).toMatchObject({ outcome: 'abandoned' });
  });

  it('is idempotent once the call has been finalised', () => {
    const ctx: ConversationContext = { ...freshContext(), finalised: true };
    const turn = reduce(ctx, { kind: 'HANGUP' }, CONFIG);

    expect(hasEffect(turn.effects, 'CREATE_LEAD')).toBe(false);
    expect(hasEffect(turn.effects, 'CREATE_CALLBACK')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Provider failure                                                          */
/* -------------------------------------------------------------------------- */

describe('provider failure', () => {
  it('degrades to a callback rather than dropping the caller', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    const turn = reduce(ctx, { kind: 'PROVIDER_ERROR', message: 'timeout' }, CONFIG);

    expect(turn.directive.kind).toBe('ESCALATE');
    expect(hasEffect(turn.effects, 'CREATE_CALLBACK')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Model output is never trusted                                             */
/* -------------------------------------------------------------------------- */

describe('rejecting bad model output', () => {
  it('discards placeholder values instead of storing them', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    const turn = say(ctx, 'I need a tow', 'provide_info', {
      serviceType: 'towing',
      location: 'not provided',
      customerName: 'unknown',
    });

    expect(turn.context.values.location).toBeUndefined();
    expect(turn.context.values.customerName).toBeUndefined();
    // Still asks for the location, because nothing valid was stored.
    expect(askedFor(turn.directive)).toBe('location');
  });

  it('rejects a whole sentence returned as a name', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    const turn = say(ctx, 'my name is Ahmed and I am waiting by the road', 'provide_info', {
      serviceType: 'towing',
      customerName: 'my name is Ahmed and I am waiting by the road',
    });

    expect(turn.context.values.customerName).toBeUndefined();
    expect(
      turn.effects.some((e) => e.type === 'LOG_EVENT' && e.event === 'FIELD_REJECTED'),
    ).toBe(true);
  });

  it('refuses a non-boolean for vehicle movability', () => {
    let ctx = freshContext();
    ctx = reduce(ctx, { kind: 'START' }, CONFIG).context;

    const turn = say(ctx, 'maybe it moves', 'provide_info', {
      serviceType: 'towing',
      vehicleMovable: 'maybe',
    });

    expect(turn.context.values.vehicleMovable).toBeUndefined();
  });
});
