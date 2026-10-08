import { describe, expect, it } from 'vitest';
import { ConversationState, type SlotValues } from '@towai/shared';

import { MAX_LOCATION_DETAIL_ATTEMPTS, determineNextAction } from './next-action';
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
    expect(shoulder.ask).toContain('one short sentence');
    expect(shoulder.ask).toContain('911');
    expect(shoulder.ask).not.toContain('may be in danger');

    const crash = determineNextAction(ctx(EVERYTHING, { safety: { hazard: 'an accident', issuedAtTurn: null } }), { emergencyNumber: '911' });
    expect(crash.ask).toContain('may be in danger (an accident)');
    expect(crash.ask).toContain('everyone is safe and off the road');
    expect(crash.ask).toContain('911');
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
      expect(second.ask).toContain('You have asked this before');
      expect(second.ask).toContain('a different, simpler way');
      // A caller who asked about the weather was told "I'm not sure where the vehicle is".
      expect(second.ask).toContain('If they talked about something else, answer that');
      expect(second.ask).toContain('Never say you did not hear them when you did');
      expect(second.ask).not.toContain('say in a few words that you did not get it');
    });

    it('moves on after three turns without an answer, and does not come back to it', () => {
      // The real call of 29 September: "what kind of help do you need?" on five turns.
      const plan = determineNextAction(ctx({}, asked('ASK_SERVICE_TYPE', 3, 3)), { callerTurn: 4 });
      expect(plan.action).toBe('ASK_LOCATION');
      expect(plan.doNotAsk).toContain('service');
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
