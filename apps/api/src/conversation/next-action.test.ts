import { describe, expect, it } from 'vitest';
import { ConversationState, type SlotValues } from '@towai/shared';

import { checkReply } from './guardrails';
import { ASK_PHRASINGS, MAX_ASKS, MAX_LOCATION_DETAIL_ATTEMPTS, askPhrasing, determineNextAction } from './next-action';
import { initialContext, type ConversationContext } from './types';

const CALLER = '+18174098408';

function ctx(values: SlotValues, extra: Partial<ConversationContext> = {}): ConversationContext {
  return { ...initialContext({ customerPhone: CALLER, ...values }), ...extra };
}

const MIKE: SlotValues = {
  serviceType: 'vehicle towing',
  customerName: 'Mike',
  vehicleType: 'semi truck',
  vehicleCondition: 'broke down',
  location: 'I-95',
};
const EVERYTHING: SlotValues = { ...MIKE, location: 'I-95 near exit 42', vehicleMovable: false };

describe('determineNextAction', () => {
  it('starts with what the caller needs', () => {
    expect(determineNextAction(ctx({})).action).toBe('ASK_SERVICE_TYPE');
  });

  it('narrows down a road-only location before anything lower, and names the road', () => {
    const plan = determineNextAction(ctx(MIKE));

    expect(plan.action).toBe('ASK_LOCATION_DETAIL');
    expect(plan.ask).toContain('on I-95');
    // The failure seen live: asking for the phone number while the location was "I-95".
    expect(plan.doNotAsk).toEqual(expect.arrayContaining(['callback_number', 'movable', 'name', 'vehicle', 'destination']));
  });

  it.each([
    [{ ...MIKE, vehicleMovable: false, customerName: 'Mike' }, 'ASK_LOCATION_DETAIL'],
    [{ serviceType: 'towing', location: 'I-95' }, 'ASK_LOCATION_DETAIL'],
    [{ serviceType: 'towing' }, 'ASK_LOCATION'],
    [{ serviceType: 'towing', location: 'exit 42 on I-95' }, 'ASK_VEHICLE'],
    [{ serviceType: 'towing', location: 'exit 42 on I-95', vehicleType: 'box truck' }, 'ASK_VEHICLE_MOVABLE'],
    [{ serviceType: 'towing', location: 'exit 42 on I-95', vehicleType: 'box truck', vehicleMovable: true }, 'ASK_CUSTOMER_NAME'],
    [EVERYTHING, 'CONFIRM_CALLBACK_NUMBER'],
  ] as Array<[SlotValues, string]>)('follows the business order: %j → %s', (values, action) => {
    expect(determineNextAction(ctx(values)).action).toBe(action);
  });

  it('gives a shoulder stop a short line and a crash the full one, both with the emergency number', () => {
    const shoulder = determineNextAction(ctx(EVERYTHING, { safety: { hazard: 'being stopped on a high-speed road', issuedAtTurn: null } }), { emergencyNumber: '911' });
    expect(shoulder.action).toBe('HANDLE_SAFETY');
    expect(shoulder.ask).toContain('briefly');
    expect(shoulder.ask).toContain('911');
    expect(shoulder.ask).not.toContain('may be in danger');
    expect(shoulder.ask).toContain('Say it like: "First, are you safely off the road, away from traffic? If anyone\'s hurt, call 911 right now."');

    const crash = determineNextAction(ctx(EVERYTHING, { safety: { hazard: 'an accident', issuedAtTurn: null } }), { emergencyNumber: '911' });
    expect(crash.ask).toContain('may be in danger (an accident)');
    expect(crash.ask).toContain('everyone is safe and off the road');
    expect(crash.ask).toContain('call 911 right now.');
  });

  it('says "emergency services" when the business has no emergency number', () => {
    const plan = determineNextAction(ctx(EVERYTHING, { safety: { hazard: 'an accident', issuedAtTurn: null } }));
    expect(plan.ask).toContain('call emergency services right now.');
    expect(plan.ask).not.toContain('{number}');
  });

  it('keeps the safety advice required for the whole turn it was issued on, then moves on', () => {
    // Issued by the note before the caller's words were saved; the plan that
    // follows the save, on the same turn, must still be the advice.
    const issued = ctx(EVERYTHING, { safety: { hazard: 'fire or fuel risk', issuedAtTurn: 4 } });
    expect(determineNextAction(issued, { callerTurn: 4 }).action).toBe('HANDLE_SAFETY');
    expect(determineNextAction(issued, { callerTurn: 5 }).action).not.toBe('HANDLE_SAFETY');
    expect(determineNextAction(ctx(EVERYTHING, { safety: { hazard: 'fire or fuel risk', issuedAtTurn: null } })).action).toBe('HANDLE_SAFETY');
  });

  it('asks a tow caller whether it can roll onto the truck, not whether it needs a tow', () => {
    const tow = determineNextAction(ctx({ serviceType: 'tow', location: 'exit 42 on I-95', vehicleType: 'box truck' }));
    expect(tow.action).toBe('ASK_VEHICLE_MOVABLE');
    expect(tow.ask).toContain('roll and steer');

    const jump = determineNextAction(ctx({ serviceType: 'jump start', location: 'exit 42 on I-95', vehicleType: 'box truck' }));
    expect(jump.action).toBe('ASK_VEHICLE_MOVABLE');
    expect(jump.ask).toContain('can still move');
  });

  it('accepts a vague location after two attempts rather than looping', () => {
    const plan = determineNextAction(ctx(MIKE, { locationDetailAttempts: MAX_LOCATION_DETAIL_ATTEMPTS }));
    expect(plan.action).toBe('ASK_VEHICLE_MOVABLE');
    expect(plan.doNotAsk).toContain('location');
  });

  it('asks for a different number when the caller ID is not the best one', () => {
    expect(determineNextAction(ctx(EVERYTHING, { phoneNeedsCollection: true })).action).toBe('ASK_CALLBACK_NUMBER');
  });

  it('reads back once everything is confirmed, then waits for the caller', () => {
    const ready = ctx(EVERYTHING, { phoneConfirmed: true, fieldVersion: 4 });
    const readBack = determineNextAction(ready);
    expect(readBack.action).toBe('CONFIRM_DETAILS');
    expect(readBack.summary).toEqual(expect.arrayContaining([{ label: 'Location', value: 'I-95 near exit 42' }]));
    // Read word for word from the line the note gives, never phrased by the model.
    expect(readBack.ask).toContain('with the exact line given below');
    expect(readBack.ask).not.toContain('natural sentence');
    // Nothing read back is asked again: a reply still asking for the number is stopped.
    expect(readBack.doNotAsk).toEqual(expect.arrayContaining(['callback_number', 'name', 'vehicle', 'location', 'destination']));

    const waiting = determineNextAction({ ...ready, pendingConfirmation: { kind: 'details', fieldVersion: 4, callerTurn: 7 } });
    expect(waiting.action).toBe('AWAIT_CONFIRMATION');

    // On the turn it is put, the caller has not heard it: it is still to be read.
    const sameTurn = determineNextAction({ ...ready, pendingConfirmation: { kind: 'details', fieldVersion: 4, callerTurn: 7 } }, { callerTurn: 7 });
    expect(sameTurn.action).toBe('CONFIRM_DETAILS');
    expect(determineNextAction({ ...ready, pendingConfirmation: { kind: 'details', fieldVersion: 4, callerTurn: 7 } }, { callerTurn: 8 }).action).toBe(
      'AWAIT_CONFIRMATION',
    );

    // A correction after the read-back means reading back again.
    const stale = determineNextAction({ ...ready, fieldVersion: 5, pendingConfirmation: { kind: 'details', fieldVersion: 4, callerTurn: 7 } });
    expect(stale.action).toBe('CONFIRM_DETAILS');
  });

  it('puts safety advice first, with the caller\'s emergency number', () => {
    const plan = determineNextAction(ctx(MIKE, { safety: { hazard: 'being stopped on a high-speed road', issuedAtTurn: null } }), {
      emergencyNumber: '911',
    });
    expect(plan.action).toBe('HANDLE_SAFETY');
    expect(plan.ask).toContain('911');

    const handled = determineNextAction(ctx(MIKE, { safety: { hazard: 'x', issuedAtTurn: 2 } }));
    expect(handled.action).toBe('ASK_LOCATION_DETAIL');
  });

  it('checks a detail the model was unsure of before moving on', () => {
    const plan = determineNextAction(ctx({ ...EVERYTHING }, { fieldSources: { vehicleMovable: 'unsure' } }));
    expect(plan.action).toBe('CLARIFY_FIELD');
    expect(plan.clarify).toEqual(['vehicleMovable']);
  });

  describe('never asks the same thing for ever', () => {
    const asked = (key: string, count: number, turn: number) => ({ asked: { [key]: { count, turn } } });

    it('checks a value it was unsure of once, then lets it stand', () => {
      // The real call: "Is it on the highway, next to Ocean?" four times
      // running, to a caller who had said "yep" and then "yes".
      const unsure = { fieldSources: { location: 'unsure' as const } };
      const values = { ...EVERYTHING, location: 'on a highway, next to Ocean' };
      const key = 'CLARIFY_FIELD:location=on a highway, next to Ocean';

      expect(determineNextAction(ctx(values, unsure), { callerTurn: 5 }).action).toBe('CLARIFY_FIELD');
      // More may go to the model on the turn it is asked.
      expect(determineNextAction(ctx(values, { ...unsure, ...asked(key, 1, 5) }), { callerTurn: 5 }).action).toBe('CLARIFY_FIELD');
      // On the next turn it has been asked, whatever the model did with the answer.
      expect(determineNextAction(ctx(values, { ...unsure, ...asked(key, 1, 5) }), { callerTurn: 6 }).action).not.toBe('CLARIFY_FIELD');
    });

    it('checks again when the value is a new one', () => {
      const plan = determineNextAction(
        ctx({ ...EVERYTHING, location: 'Ocean Drive' }, { fieldSources: { location: 'unsure' }, ...asked('CLARIFY_FIELD:location=on a highway, next to Ocean', 1, 5) }),
        { callerTurn: 6 },
      );
      expect(plan.action).toBe('CLARIFY_FIELD');
    });

    it('asks a second time in different words, saying it did not get it only when it did not', () => {
      const first = determineNextAction(ctx({}), { callerTurn: 1 });
      expect(first.ask).not.toContain('asked this before');

      const second = determineNextAction(ctx({}, asked('ASK_SERVICE_TYPE', 1, 1)), { callerTurn: 2 });
      expect(second.action).toBe('ASK_SERVICE_TYPE');
      expect(second.ask).toContain("You've asked this before");
      // A caller who asked about the weather was told "I'm not sure where the vehicle is".
      expect(second.ask).toContain('answer anything else they said first');
      expect(second.ask).toContain("never say you didn't hear them when you did");
      expect(second.ask).not.toContain('say in a few words that you did not get it');
      // Different words come from the sample for the attempt, not from the model.
      expect(second.ask).toContain(`Say it like: "${ASK_PHRASINGS.ASK_SERVICE_TYPE![1]}"`);
      expect(second.ask).not.toContain(ASK_PHRASINGS.ASK_SERVICE_TYPE![0]!);
    });

    it('moves on after three turns without an answer, and does not come back to it', () => {
      // The real call of 29 September: "what kind of help do you need?" on five turns.
      const plan = determineNextAction(ctx({}, asked('ASK_SERVICE_TYPE', 3, 3)), { callerTurn: 4 });
      expect(plan.action).toBe('ASK_LOCATION');
      expect(plan.doNotAsk).toContain('service');
    });

    describe('a detail given up on', () => {
      // The real call of 8 October: service and location were each asked three
      // times while the caller asked about the weather. The caller then answered
      // every question, and the read-back had neither.
      const ALI: SlotValues = { vehicleType: 'Car', vehicleMovable: false, customerName: 'Ali' };
      const ASKED = {
        ASK_SERVICE_TYPE: { count: 3, turn: 5 },
        ASK_LOCATION: { count: 3, turn: 8 },
        ASK_VEHICLE: { count: 3, turn: 12 },
        ASK_VEHICLE_MOVABLE: { count: 2, turn: 14 },
        ASK_CUSTOMER_NAME: { count: 1, turn: 15 },
      };

      it('is asked once more before the read-back, once the caller has answered something asked after it', () => {
        const plan = determineNextAction(ctx(ALI, { asked: ASKED }), { callerTurn: 16 });
        expect(plan.action).toBe('ASK_SERVICE_TYPE');
        expect(plan.ask).toContain('one last time');
        expect(plan.doNotAsk).not.toContain('service');
        expect(plan.because[0]).toContain('one last try before the read-back');
      });

      it('stays the last try for the rest of the turn it is put on, then is left for good', () => {
        const put = { ...ASKED, ASK_SERVICE_TYPE: { count: 4, turn: 16 } };
        expect(determineNextAction(ctx(ALI, { asked: put }), { callerTurn: 16 }).action).toBe('ASK_SERVICE_TYPE');

        const next = determineNextAction(ctx(ALI, { asked: put }), { callerTurn: 17 });
        expect(next.action).toBe('ASK_LOCATION');
        expect(next.ask).toContain('one last time');
        expect(next.because).toContain('serviceType asked 3 times without an answer: left for the towing team');

        const done = { ...put, ASK_LOCATION: { count: 4, turn: 17 } };
        expect(determineNextAction(ctx(ALI, { asked: done }), { callerTurn: 18 }).action).toBe('CONFIRM_CALLBACK_NUMBER');
      });

      it('is not asked again while the caller has answered nothing since', () => {
        const plan = determineNextAction(ctx({}, { asked: { ASK_SERVICE_TYPE: { count: 3, turn: 3 }, ASK_LOCATION: { count: 1, turn: 4 } } }), { callerTurn: 5 });
        expect(plan.action).toBe('ASK_LOCATION');
        expect(plan.ask).not.toContain('one last time');
        expect(plan.doNotAsk).toContain('service');
      });
    });

    it('lets the number they called from stand, unconfirmed, after three turns without an answer', () => {
      const plan = determineNextAction(ctx(EVERYTHING, asked('CONFIRM_CALLBACK_NUMBER', 3, 6)), { callerTurn: 7 });
      expect(plan.action).toBe('CONFIRM_DETAILS');
    });

    it('tells the model what a yes or no to the number question means, once it has been asked', () => {
      // The real call: "Yes." three times, nothing saved, and the question asked again each time.
      const first = determineNextAction(ctx(EVERYTHING), { callerTurn: 5 });
      expect(first.action).toBe('CONFIRM_CALLBACK_NUMBER');
      expect(first.ask).not.toContain('If they said yes');

      const again = determineNextAction(ctx(EVERYTHING, asked('CONFIRM_CALLBACK_NUMBER', 1, 5)), { callerTurn: 6 });
      expect(again.action).toBe('CONFIRM_CALLBACK_NUMBER');
      expect(again.ask).toContain('If they said yes: call update_call_information with callerIdConfirmed true and nothing else');
      expect(again.ask).toContain('callerIdConfirmed false');
      expect(again.ask).toContain('Only if they did not answer');
      expect(again.ask).toContain('Do not read the number out');
    });

    it('tells the model to save a number the caller gave, once it has asked for one', () => {
      const again = determineNextAction(ctx(EVERYTHING, { phoneNeedsCollection: true, ...asked('ASK_CALLBACK_NUMBER', 1, 5) }), { callerTurn: 6 });
      expect(again.action).toBe('ASK_CALLBACK_NUMBER');
      expect(again.ask).toContain('If they gave one: call update_call_information with it in customerPhone');
    });
  });

  it('closes a finished call', () => {
    expect(determineNextAction(ctx(EVERYTHING, { state: ConversationState.ENDED })).action).toBe('CLOSE');
  });
});

describe('why the next action was chosen', () => {
  const first = (c: ConversationContext, turn?: number) => determineNextAction(c, { callerTurn: turn }).because[0];

  it.each<[string, ConversationContext, string]>([
    ['the first missing detail', ctx({}), 'serviceType missing'],
    ['a detail asked before', ctx({ serviceType: 'tow' }, { asked: { ASK_LOCATION: { count: 2, turn: 3 } } }), 'location missing, asked 2/3 already'],
    ['a location too vague to drive to', ctx(MIKE), 'location "I-95" not precise enough to drive to'],
    ['safety advice not given yet', ctx(EVERYTHING, { safety: { hazard: 'an accident', issuedAtTurn: null } }), 'an accident: safety advice not given yet'],
    ['a detail not clearly heard', ctx({ serviceType: 'tow' }, { fieldSources: { serviceType: 'unsure' } }), 'not sure it heard serviceType "tow" right'],
    ['only the caller ID number', ctx(EVERYTHING), 'only the caller ID number, not confirmed'],
    ['the caller said not this number', ctx(EVERYTHING, { phoneNeedsCollection: true }), 'the caller said not this number'],
    ['everything settled', ctx(EVERYTHING, { phoneConfirmed: true }), 'everything required is saved'],
    [
      'a read-back waiting for a yes',
      ctx(EVERYTHING, { phoneConfirmed: true, pendingConfirmation: { kind: 'details', fieldVersion: 0, callerTurn: 6 } }),
      'details read back on turn 6; waiting for a clear yes',
    ],
    ['a finished call', ctx(EVERYTHING, { state: ConversationState.ENDED }), 'the call has ended'],
  ])('names %s', (_name, c, reason) => {
    expect(first(c, 7)).toContain(reason);
  });

  it('says what was given up on, and what stood when it decided', () => {
    const plan = determineNextAction(ctx({ serviceType: 'tow', location: '123 Main Street' }, { asked: { ASK_VEHICLE: { count: 3, turn: 4 } } }), { callerTurn: 7 });
    expect(plan.action).toBe('ASK_VEHICLE_MOVABLE');
    expect(plan.because).toEqual(
      expect.arrayContaining([
        'vehicle asked 3 times without an answer: left for the towing team',
        expect.stringContaining('saved: customerPhone=+18174098408, serviceType=tow'),
        expect.stringContaining('location "123 Main Street": complete'),
      ]),
    );
  });
});

describe('how each ask is said', () => {
  const asked = (key: string, count: number, turn: number) => ({ asked: { [key]: { count, turn } } });
  /** The line the model is given to say: the last thing in the ask. */
  const sample = (ask: string) => /Say it like: "(.*)"$/.exec(ask)?.[1];
  const ready = ctx(EVERYTHING, { phoneConfirmed: true, fieldVersion: 4 });
  const FILL = { offer: 'a jump start, or a tow', road: 'I-95', number: '911', value: 'a Honda Civic' };
  const everySample = Object.entries(ASK_PHRASINGS).flatMap(([key, samples]) => samples.map((s) => [key, s] as const));

  it.each<[string, ConversationContext]>([
    ['ASK_SERVICE_TYPE', ctx({})],
    ['ASK_LOCATION', ctx({ serviceType: 'towing' })],
    ['ASK_LOCATION_DETAIL', ctx({ serviceType: 'towing', location: 'I-95' })],
    ['ASK_VEHICLE', ctx({ serviceType: 'towing', location: 'exit 42 on I-95' })],
    ['ASK_VEHICLE_MOVABLE', ctx({ serviceType: 'towing', location: 'exit 42 on I-95', vehicleType: 'box truck' })],
    ['ASK_CUSTOMER_NAME', ctx({ serviceType: 'towing', location: 'exit 42 on I-95', vehicleType: 'box truck', vehicleMovable: true })],
    ['CONFIRM_CALLBACK_NUMBER', ctx(EVERYTHING)],
    ['ASK_CALLBACK_NUMBER', ctx(EVERYTHING, { phoneNeedsCollection: true })],
    ['CLARIFY_FIELD', ctx(EVERYTHING, { fieldSources: { vehicleMovable: 'unsure' } })],
    ['HANDLE_SAFETY', ctx(EVERYTHING, { safety: { hazard: 'an accident', issuedAtTurn: null } })],
    ['AWAIT_CONFIRMATION', { ...ready, pendingConfirmation: { kind: 'details', fieldVersion: 4, callerTurn: 7 } }],
  ])('%s ends with a line to say, every placeholder filled', (action, c) => {
    const plan = determineNextAction(c, { callerTurn: 8, emergencyNumber: '911' });
    expect(plan.action).toBe(action);
    // The model does the last thing it reads: the line comes last.
    expect(plan.ask).toContain('Say it like: "');
    expect(sample(plan.ask)).toBeTruthy();
    expect(plan.ask).not.toMatch(/\{\w+\}/);
  });

  it('gives each attempt its own words, so a question is never repeated word for word', () => {
    const at = (count: number) =>
      sample(determineNextAction(ctx({ serviceType: 'towing' }, count > 0 ? asked('ASK_LOCATION', count, count) : {}), { callerTurn: count + 1 }).ask);

    expect([at(0), at(1), at(2)]).toEqual([
      'Where are you right now?',
      "What's the nearest exit, cross street, or a business you can see?",
      'Which road are you on, or which town?',
    ]);
    // Asked again on the same turn, it is the same ask, and the same words.
    expect(sample(determineNextAction(ctx({ serviceType: 'towing' }, asked('ASK_LOCATION', 1, 1)), { callerTurn: 1 }).ask)).toBe(at(0));
  });

  it('says the one last chance before the read-back in words not used before', () => {
    // The call of 8 October, as in the tests above: service and location given up on, then everything else answered.
    const ALI: SlotValues = { vehicleType: 'Car', vehicleMovable: false, customerName: 'Ali' };
    const ASKED = {
      ASK_SERVICE_TYPE: { count: 3, turn: 5 },
      ASK_LOCATION: { count: 3, turn: 8 },
      ASK_VEHICLE: { count: 3, turn: 12 },
      ASK_VEHICLE_MOVABLE: { count: 2, turn: 14 },
      ASK_CUSTOMER_NAME: { count: 1, turn: 15 },
    };
    const service = determineNextAction(ctx(ALI, { asked: ASKED }), { callerTurn: 16 });
    expect(service.ask).toContain('one last time');
    expect(sample(service.ask)).toBe(ASK_PHRASINGS.ASK_SERVICE_TYPE![MAX_ASKS]);

    const location = determineNextAction(ctx(ALI, { asked: { ...ASKED, ASK_SERVICE_TYPE: { count: 4, turn: 16 } } }), { callerTurn: 17 });
    expect(sample(location.ask)).toBe('Last thing before I pass this on: any landmark near you?');
  });

  it('never repeats a sample within an ask, and never sounds like a form', () => {
    for (const [key, samples] of Object.entries(ASK_PHRASINGS)) {
      expect(new Set(samples).size, key).toBe(samples.length);
    }
    for (const [key, line] of everySample) {
      expect(line, key).not.toMatch(/could you|please provide|what kind of help/i);
      // The eval's ROBOTIC_PHRASING.
      expect(line, key).not.toMatch(/could you (?:tell|describe|provide|let me know)|what kind of (?:help|vehicle|issue) do you|please provide|at this time|in order to/i);
      // The model, or a filler, has often just said the ack.
      expect(line, key).not.toMatch(/^(?:okay|ok|alright|all right|sure|got it|right|great|perfect)\b/i);
      // One question at a time.
      expect((line.match(/\?/g) ?? []).length, key).toBe(1);
    }
  });

  it('never promises a time, a price or a truck', () => {
    for (const [key, line] of everySample) {
      const filled = line.replace(/\{(\w+)\}/g, (_whole, name: keyof typeof FILL) => FILL[name]);
      expect(checkReply(filled), `${key}: ${filled}`).toEqual({ ok: true });
    }
  });

  it('clamps the attempt to the samples there are, and fills the placeholders it is given', () => {
    const vehicle = ASK_PHRASINGS.ASK_VEHICLE!;
    expect(askPhrasing('ASK_VEHICLE', 0)).toBe(vehicle[0]);
    expect(askPhrasing('ASK_VEHICLE', 99)).toBe(vehicle[vehicle.length - 1]);
    expect(askPhrasing('ASK_VEHICLE', -1)).toBe(vehicle[0]);
    expect(askPhrasing('ASK_LOCATION_DETAIL:highway', 0, { road: 'I-95' })).toBe('Where on I-95, an exit number, mile marker, or something you can see?');
    expect(askPhrasing('NO_SUCH_ASK', 0)).toBe('');
  });

  it('asks where on the road, in words for a highway or a street', () => {
    const highway = determineNextAction(ctx({ serviceType: 'towing', location: 'I-95' }), { callerTurn: 3 });
    expect(sample(highway.ask)).toBe('Where on I-95, an exit number, mile marker, or something you can see?');
    const again = determineNextAction(ctx({ serviceType: 'towing', location: 'I-95' }, asked('ASK_LOCATION_DETAIL', 1, 3)), { callerTurn: 4 });
    expect(sample(again.ask)).toBe("What's the nearest exit or mile marker on I-95?");

    const street = determineNextAction(ctx({ serviceType: 'towing', location: 'Main Street' }), { callerTurn: 3 });
    expect(sample(street.ask)).toBe('Where on Main Street, a house number or a cross street?');
  });

  it('asks a tow caller whether it rolls, and anyone else whether it drives', () => {
    const where = { location: 'exit 42 on I-95', vehicleType: 'box truck' };
    expect(sample(determineNextAction(ctx({ serviceType: 'tow', ...where })).ask)).toBe('Does it roll and steer, or is it stuck where it is?');
    expect(sample(determineNextAction(ctx({ serviceType: 'jump start', ...where })).ask)).toBe('Does it still start and drive, or is it dead?');
  });

  it('does not ask "what\'s going on" of a caller who has said what is wrong', () => {
    const plan = determineNextAction(ctx({ vehicleCondition: "won't start" }));
    expect(plan.action).toBe('ASK_SERVICE_TYPE');
    expect(plan.ask).toContain('"won\'t start"');
    expect(sample(plan.ask)).toBe('So what do you need, a tow or something else?');
  });

  it('offers the likeliest kinds of help by name', () => {
    const judgments = { service: { text: "won't start", service: 'unclear' as const, confidence: 0.5, alternatives: ['jump_start' as const, 'tow' as const] } };
    const plan = determineNextAction(ctx({}, { judgments }));
    expect(plan.ask).toContain('ask whether they need a jump start or a tow');
    expect(sample(plan.ask)).toBe('Do you need a jump start, or a tow?');
    expect(plan.because[0]).toContain('the likeliest are offered');
  });

  it.each<[string, SlotValues, Array<keyof SlotValues>, string]>([
    ['a make and model', { ...EVERYTHING, vehicleMake: 'Honda', vehicleModel: 'Civic' }, ['vehicleModel'], 'Sorry, what are you driving, a Honda Civic?'],
    ['a type said letter by letter', { ...EVERYTHING, vehicleType: 'SUV' }, ['vehicleType'], 'Sorry, what are you driving, an SUV?'],
    ['a name', EVERYTHING, ['customerName'], 'Sorry, what was your name, Mike?'],
    ['a place', EVERYTHING, ['location'], 'Sorry, where was that, I-95 near exit 42?'],
    ['a kind of help', { ...EVERYTHING, serviceType: 'tow' }, ['serviceType'], 'Sorry, what do you need, a tow?'],
    ['a vehicle that cannot move', EVERYTHING, ['vehicleMovable'], "Sorry, so it won't move at all?"],
  ])('checks %s with the value in it', (_name, values, unsure, line) => {
    const fieldSources = Object.fromEntries(unsure.map((key) => [key, 'unsure' as const]));
    const plan = determineNextAction(ctx(values, { fieldSources }));
    expect(plan.action).toBe('CLARIFY_FIELD');
    expect(sample(plan.ask)).toBe(line);
  });

  it('gives the line to ask the number again only for when they did not answer', () => {
    // "Yes." heard three times on a real call, and the question asked again each time.
    const again = determineNextAction(ctx(EVERYTHING, asked('CONFIRM_CALLBACK_NUMBER', 1, 5)), { callerTurn: 6 });
    expect(again.ask.indexOf('If they said yes')).toBeLessThan(again.ask.indexOf('Only if they did not answer'));
    expect(again.ask.indexOf('Only if they did not answer')).toBeLessThan(again.ask.indexOf('Say it like'));
    expect(sample(again.ask)).toBe('Should we call you back on this number?');
  });

  it('asks about the read-back in other words than the read-back\'s own question', () => {
    const waits = [0, 1, 2, 3].map((count) =>
      determineNextAction(
        { ...ready, pendingConfirmation: { kind: 'details', fieldVersion: 4, callerTurn: 7 }, ...(count > 0 ? asked('AWAIT_CONFIRMATION', count, 7 + count) : {}) },
        { callerTurn: 8 + count },
      ),
    );
    expect(new Set(waits.map((plan) => sample(plan.ask))).size).toBe(4);
    for (const plan of waits) {
      expect(plan.ask).not.toMatch(/did i get all that right|is that all correct/i);
      expect(plan.ask.indexOf('Only on a clear yes')).toBeLessThan(plan.ask.indexOf('Say it like'));
    }
    // The read-back itself is the note's line, word for word: no line of its own here.
    const readBack = determineNextAction(ready);
    expect(readBack.ask).toContain('word for word');
    expect(readBack.ask).not.toContain('Say it like');
  });
});
