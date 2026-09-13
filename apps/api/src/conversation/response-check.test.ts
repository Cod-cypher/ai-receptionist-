import { describe, expect, it } from 'vitest';
import type { SlotValues } from '@towai/shared';

import { determineNextAction } from './next-action';
import { checkReplyAgainstAction, questionsIn } from './response-check';
import { initialContext } from './types';

const planFor = (values: SlotValues, extra = {}) =>
  determineNextAction({ ...initialContext({ customerPhone: '+18174098408', ...values }), ...extra });

const MIKE = { serviceType: 'vehicle towing', customerName: 'Mike', vehicleType: 'semi truck', location: 'I-95' };

describe('checkReplyAgainstAction', () => {
  it('flags the live failure: asking for the phone number while the location is "I-95"', () => {
    const check = checkReplyAgainstAction('Got it, Mike. Can you confirm if this is the best number to reach you?', planFor(MIKE));
    expect(check.deviation?.asked).toBe('callback_number');
  });

  it('accepts the right question', () => {
    const check = checkReplyAgainstAction(
      "I'm sorry you're dealing with that, Mike. Can you tell me the nearest exit, mile marker, or landmark on I-95?",
      planFor(MIKE),
    );
    expect(check.deviation).toBeNull();
    expect(check.questionCount).toBe(1);
  });

  it('flags asking for something already given', () => {
    const plan = planFor({ ...MIKE, location: 'exit 42 on I-95' });
    expect(checkReplyAgainstAction('Thanks. And what is your name?', plan).deviation?.asked).toBe('name');
    expect(checkReplyAgainstAction('What kind of vehicle is it?', plan).deviation?.asked).toBe('vehicle');
  });

  it('allows a question that covers the required topic alongside another', () => {
    const plan = planFor(MIKE);
    const check = checkReplyAgainstAction('Where exactly on I-95 are you, and can the truck still move?', plan);
    expect(check.deviation).toBeNull();
  });

  it('ignores statements and unfinished sentences', () => {
    const plan = planFor(MIKE);
    expect(checkReplyAgainstAction("I'll make sure the team has the best number to reach you.", plan).deviation).toBeNull();
    expect(checkReplyAgainstAction('Is this the best number', plan).deviation).toBeNull();
  });

  it('lets the read-back mention every detail', () => {
    const plan = planFor(
      { ...MIKE, location: 'exit 42 on I-95', vehicleMovable: false },
      { phoneConfirmed: true },
    );
    expect(plan.action).toBe('CONFIRM_DETAILS');
    const check = checkReplyAgainstAction(
      'So that is Mike, a semi truck that cannot move, at exit 42 on I-95, and we will call +18174098408. Is that all correct?',
      plan,
    );
    expect(check.deviation).toBeNull();
  });

  it('counts questions for the one-question rule', () => {
    expect(questionsIn('Where are you? And what vehicle is it? Thanks.').length).toBe(2);
  });
});
