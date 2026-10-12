import { describe, expect, it } from 'vitest';

import { checkReply } from '../../conversation/guardrails';
import { describeIntake } from '../../conversation/intake';
import { determineNextAction } from '../../conversation/next-action';
import { initialContext } from '../../conversation/types';
import { confirmedGoodbyeLine, guardrailRecoveryInstructions, renderReadBack, renderReadBackRest, spokenDigits } from './spoken-lines';

const state = () => {
  const ctx = initialContext({ customerPhone: '+18174098408', serviceType: 'vehicle towing', customerName: 'Mike', location: 'I-95' });
  return describeIntake(ctx, determineNextAction(ctx, { emergencyNumber: '911' }));
};

const ALI = [
  { label: 'Name', value: 'Ali' },
  { label: 'Service', value: 'tow' },
  { label: 'Location', value: '3114 Holloway Street' },
  { label: 'Vehicle', value: 'Hyundai Sonata' },
  { label: 'Vehicle movable', value: 'no' },
  { label: 'Callback number', value: '+18174098408' },
];

describe('the goodbye after a yes', () => {
  it('thanks the caller by name and says what the towing team will call about', () => {
    expect(confirmedGoodbyeLine({ ...state(), missing: ['serviceType', 'location'] })).toBe(
      "Thank you, Mike. I've passed your details to the towing team, and they'll call you to get what help you need and where the vehicle is. Goodbye.",
    );
    expect(confirmedGoodbyeLine({ ...state(), missing: [] })).toBe("Thank you, Mike. I've passed your details to the towing team, and they'll be in touch. Goodbye.");
    expect(confirmedGoodbyeLine(undefined)).toBe("Thank you. I've passed your details to the towing team, and they'll be in touch. Goodbye.");
  });

  it('breaks no rule and asks nothing', () => {
    const line = confirmedGoodbyeLine({ ...state(), missing: ['location'] });
    expect(checkReply(line)).toEqual({ ok: true });
    expect(line).not.toContain('?');
  });
});

describe('the rest of a read-back', () => {
  it('starts at the first detail the caller did not hear in full', () => {
    // The real call: "How long will it take?" came 8 s in, after "it".
    expect(renderReadBackRest(ALI, 'Let me read that back. Your name is Ali, you need a tow, the vehicle is at 3114 Holloway')).toBe(
      "And the rest: the vehicle is at 3114 Holloway Street, it is a Hyundai Sonata, it can't move, the callback number is 8 1 7, 4 0 9, 8 4 0 8. Is that all correct?",
    );
  });

  it('is only the question when every detail was heard', () => {
    expect(renderReadBackRest(ALI, renderReadBack(ALI).replace(' Is that all correct?', ''))).toBe('Is that all correct?');
  });

  it('is the whole read-back when the caller heard none of the details', () => {
    expect(renderReadBackRest(ALI, 'Let me read')).toBe(renderReadBack(ALI));
    expect(renderReadBackRest(ALI, '')).toBe(renderReadBack(ALI));
  });
});

describe('the read-back', () => {
  it('reads every detail in a fixed order and the number digit by digit', () => {
    const text = renderReadBack([
      { label: 'Name', value: 'Victor' },
      { label: 'Service', value: 'tow' },
      { label: 'Location', value: 'Dakolani' },
      { label: 'Vehicle', value: 'Small Car' },
      { label: 'Vehicle movable', value: 'no' },
      { label: 'Notes', value: 'Caller was unclear.' },
      { label: 'Callback number', value: '+18142027042' },
    ]);
    expect(text).toBe(
      "Let me read that back. Your name is Victor, you need a tow, the vehicle is at Dakolani, it is a Small Car, it can't move, the callback number is 8 1 4, 2 0 2, 7 0 4 2. Is that all correct?",
    );
  });

  it('spells numbers outside North America with their country code', () => {
    expect(spokenDigits('+923001234567')).toBe('plus 9 2 3, 0 0 1, 2 3 4, 5 6 7');
  });
});

describe('the instructions after a stopped reply', () => {
  it('say the caller heard nothing only when nothing was heard', () => {
    expect(guardrailRecoveryInstructions('states a price')).toContain('stopped before the caller heard it, because it states a price');
    expect(guardrailRecoveryInstructions('states a price', 'It costs')).toContain('The caller heard you begin "It costs"');
  });
});
