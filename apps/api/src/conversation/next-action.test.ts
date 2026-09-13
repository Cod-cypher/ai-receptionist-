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

  it('closes a finished call', () => {
    expect(determineNextAction(ctx(EVERYTHING, { state: ConversationState.ENDED })).action).toBe('CLOSE');
  });
});
