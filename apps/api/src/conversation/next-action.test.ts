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

  it('keeps the safety advice required for the whole turn it was issued on, then moves on', () => {
    // Issued by the note before the caller's words were saved; the plan that
    // follows the save, on the same turn, must still be the advice.
    const issued = ctx(EVERYTHING, { safety: { hazard: 'fire or fuel risk', issuedAtTurn: 4 } });
    expect(determineNextAction(issued, { callerTurn: 4 }).action).toBe('HANDLE_SAFETY');
    expect(determineNextAction(issued, { callerTurn: 5 }).action).not.toBe('HANDLE_SAFETY');
    expect(determineNextAction(ctx(EVERYTHING, { safety: { hazard: 'fire or fuel risk', issuedAtTurn: null } })).action).toBe('HANDLE_SAFETY');
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

    const waiting = determineNextAction({ ...ready, pendingConfirmation: { kind: 'details', fieldVersion: 4, callerTurn: 7 } });
    expect(waiting.action).toBe('AWAIT_CONFIRMATION');

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

    it('asks a second time in different words, and says it did not get it', () => {
      const first = determineNextAction(ctx({}), { callerTurn: 1 });
      expect(first.ask).not.toContain('asked this already');

      const second = determineNextAction(ctx({}, asked('ASK_SERVICE_TYPE', 1, 1)), { callerTurn: 2 });
      expect(second.action).toBe('ASK_SERVICE_TYPE');
      expect(second.ask).toContain('You have asked this already');
      expect(second.ask).toContain('a different, simpler way');
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
  });

  it('closes a finished call', () => {
    expect(determineNextAction(ctx(EVERYTHING, { state: ConversationState.ENDED })).action).toBe('CLOSE');
  });
});
