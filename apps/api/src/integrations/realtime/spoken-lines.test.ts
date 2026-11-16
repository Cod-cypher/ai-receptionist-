import { describe, expect, it } from 'vitest';

import { checkReply } from '../../conversation/guardrails';
import { describeIntake } from '../../conversation/intake';
import { determineNextAction } from '../../conversation/next-action';
import { initialContext } from '../../conversation/types';
import { SERVICE_LABEL } from '../judgment/typesafe-questions';
import {
  ENDING_NOTE,
  READ_BACK_QUESTION,
  SAFE_FALLBACK_LINE,
  SELF_TALK_RECOVERY_INSTRUCTIONS,
  SILENCE_CHECK_LINE,
  SILENCE_GOODBYE_INSTRUCTIONS,
  TURN_LIMIT_GOODBYE_INSTRUCTIONS,
  UNCONFIRMED_GOODBYE_INSTRUCTIONS,
  confirmedGoodbyeLine,
  guardrailRecoveryInstructions,
  renderReadBack,
  renderReadBackRest,
  spokenDigits,
} from './spoken-lines';

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

const ALI_READ_BACK =
  "Let me make sure I've got this right. Ali, you need a tow; the Hyundai Sonata is at 3114 Holloway Street; it can't move; and we'll call you back on 8 1 7, 4 0 9, 8 4 0 8. Did I get all that right?";

/** The same call, the caller having said the number they are ringing from is the best one. */
const ALI_ON_CALLER_ID = [...ALI.slice(0, -1), { label: 'Callback caller ID', value: '+18174098408' }];

const ALI_ON_CALLER_ID_READ_BACK =
  "Let me make sure I've got this right. Ali, you need a tow; the Hyundai Sonata is at 3114 Holloway Street; it can't move; and we'll call you back on the number you're calling from. Did I get all that right?";

/** The shape of real call 5176f4be: a confirmed caller ID, and a condition that only says the car does not move. */
const NOT_MOVING = [
  { label: 'Name', value: 'Sam' },
  { label: 'Service', value: 'tow' },
  { label: 'Location', value: '2200 Elm Street' },
  { label: 'Vehicle', value: 'Honda Civic' },
  { label: 'Vehicle movable', value: 'no' },
  { label: 'Condition', value: 'not moving' },
  { label: 'Callback caller ID', value: '+18174098408' },
];

/** Every detail the read-back can carry. */
const EVERYTHING = [
  { label: 'Name', value: 'Mike' },
  { label: 'Service', value: 'vehicle towing' },
  { label: 'Location', value: 'I-95, exit 42' },
  { label: 'Destination', value: "Joe's Garage on Main Street" },
  { label: 'Vehicle', value: 'Ford F-150 (Pickup)' },
  { label: 'Vehicle movable', value: 'no' },
  { label: 'Condition', value: 'a blowout' },
  { label: 'Notes', value: 'Caller was calm.' },
  { label: 'Callback number', value: '+18174098408' },
];

describe('the goodbye after a yes', () => {
  it('uses the caller name and says what the towing team will call about', () => {
    expect(confirmedGoodbyeLine({ ...state(), missing: ['serviceType', 'location'] })).toBe(
      "You're all set, Mike. I've passed everything to the towing team and they'll give you a call to ask what help you need and where the vehicle is. Take care.",
    );
    expect(confirmedGoodbyeLine({ ...state(), missing: [] })).toBe(
      "You're all set, Mike. I've passed everything to the towing team and they'll give you a call. Take care.",
    );
    expect(confirmedGoodbyeLine(undefined)).toBe("You're all set. I've passed everything to the towing team and they'll give you a call. Take care.");
  });

  it('never says the team will call to get the vehicle, which sounds like a promise to come for it', () => {
    expect(confirmedGoodbyeLine({ ...state(), missing: ['vehicle', 'vehicleMovable', 'customerName', 'customerPhone'] })).toBe(
      "You're all set, Mike. I've passed everything to the towing team and they'll give you a call to ask what you're driving, whether it can move and your name. Take care.",
    );
  });

  it('says what is wrong with the vehicle is still to be asked, when it is', () => {
    // The calls of 13 November: "You also didn't ask me what was wrong with the car".
    expect(confirmedGoodbyeLine({ ...state(), missing: ['vehicleCondition'] })).toBe(
      "You're all set, Mike. I've passed everything to the towing team and they'll give you a call to ask what's wrong with it. Take care.",
    );
    expect(confirmedGoodbyeLine({ ...state(), missing: ['vehicle', 'vehicleCondition', 'vehicleMovable'] })).toBe(
      "You're all set, Mike. I've passed everything to the towing team and they'll give you a call to ask what you're driving, what's wrong with it and whether it can move. Take care.",
    );
  });

  it('breaks no rule and asks nothing', () => {
    for (const missing of [[], ['location'], ['serviceType', 'location', 'vehicle', 'vehicleCondition', 'vehicleMovable', 'customerName']] as const) {
      const line = confirmedGoodbyeLine({ ...state(), missing: [...missing] });
      expect(checkReply(line)).toEqual({ ok: true });
      expect(line).not.toContain('?');
    }
    expect(checkReply(confirmedGoodbyeLine(undefined))).toEqual({ ok: true });
  });
});

describe('the read-back', () => {
  it('reads every detail in a fixed order and the number digit by digit', () => {
    expect(renderReadBack(ALI)).toBe(ALI_READ_BACK);
  });

  it('says a vehicle type in lower case, and leaves out the notes', () => {
    // The real call: "it is a Small Car".
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
      "Let me make sure I've got this right. Victor, you need a tow; the small car is at Dakolani; it can't move; and we'll call you back on 8 1 4, 2 0 2, 7 0 4 2. Did I get all that right?",
    );
  });

  it('says "a tow" for "vehicle towing"', () => {
    // The gateway's read-back once said "you need a vehicle towing".
    expect(
      renderReadBack([
        { label: 'Name', value: 'Mike' },
        { label: 'Service', value: 'vehicle towing' },
        { label: 'Location', value: 'I-95, exit 42' },
        { label: 'Vehicle', value: 'semi truck' },
        { label: 'Vehicle movable', value: 'no' },
        { label: 'Callback number', value: '+18174098408' },
      ]),
    ).toBe(
      "Let me make sure I've got this right. Mike, you need a tow; the semi truck is at I-95, exit 42; it can't move; and we'll call you back on 8 1 7, 4 0 9, 8 4 0 8. Did I get all that right?",
    );
  });

  it('keeps every detail: destination, condition, a make and model with its type', () => {
    expect(renderReadBack(EVERYTHING)).toBe(
      "Let me make sure I've got this right. Mike, you need a tow; the Ford F-150 pickup is at I-95, exit 42, going to Joe's Garage on Main Street; it can't move; the problem is a blowout; and we'll call you back on 8 1 7, 4 0 9, 8 4 0 8. Did I get all that right?",
    );
  });

  // The words each kind of help is saved as, the label Jev saves first.
  const SAID: Record<keyof typeof SERVICE_LABEL, string> = {
    tow: 'a tow',
    jump_start: 'a jump start',
    flat_tire: 'help with a flat tire',
    lockout: 'a lockout',
    fuel_delivery: 'fuel',
    winch_out: 'a winch-out',
  };
  it.each(Object.entries(SERVICE_LABEL) as Array<[keyof typeof SERVICE_LABEL, string]>)('says the %s label as speech', (kind, label) => {
    expect(renderReadBack([{ label: 'Service', value: label }])).toBe(`Let me make sure I've got this right. You need ${SAID[kind]}. ${READ_BACK_QUESTION}`);
  });

  it.each([
    ['towing', 'a tow'],
    ['Towing service', 'a tow'],
    ['a tow', 'a tow'],
    ['jump-start', 'a jump start'],
    ['boost', 'a jump start'],
    ['flat tyre', 'help with a flat tire'],
    ['locked out', 'a lockout'],
    ['gas', 'fuel'],
    ['winch-out', 'a winch-out'],
    // Not a label: said as saved, so no detail is lost.
    ['roadside assistance', 'roadside assistance'],
    ['two flat tires', 'two flat tires'],
  ])('says "%s" as "you need %s"', (saved, said) => {
    expect(renderReadBack([{ label: 'Service', value: saved }])).toContain(`You need ${said}.`);
  });

  it.each([
    ['Small Car', 'the small car is at'],
    ['Pickup Truck', 'the pickup truck is at'],
    ['SUV', 'the SUV is at'],
    ['Suv', 'the SUV is at'],
    ['Hyundai Sonata', 'the Hyundai Sonata is at'],
    ['Toyota Hilux (Pickup)', 'the Toyota Hilux pickup is at'],
    ['Ford Transit Van', 'the Ford Transit Van is at'],
  ])('says the vehicle "%s" as "%s"', (vehicle, said) => {
    const lines = [
      { label: 'Name', value: 'Ali' },
      { label: 'Vehicle', value: vehicle },
      { label: 'Location', value: 'exit 42' },
    ];
    expect(renderReadBack(lines)).toContain(`Ali, ${said} exit 42.`);
  });

  it('starts with what they need when there is no name', () => {
    expect(renderReadBack(ALI.filter((line) => line.label !== 'Name'))).toBe(
      "Let me make sure I've got this right. You need a tow; the Hyundai Sonata is at 3114 Holloway Street; it can't move; and we'll call you back on 8 1 7, 4 0 9, 8 4 0 8. Did I get all that right?",
    );
  });

  it('says what the vehicle is on its own when the location was given up on', () => {
    expect(renderReadBack(ALI.filter((line) => line.label !== 'Location'))).toBe(
      "Let me make sure I've got this right. Ali, you need a tow; it's a Hyundai Sonata; it can't move; and we'll call you back on 8 1 7, 4 0 9, 8 4 0 8. Did I get all that right?",
    );
    expect(renderReadBack([{ label: 'Vehicle', value: 'SUV' }])).toContain("It's an SUV.");
    expect(renderReadBack([{ label: 'Location', value: 'exit 42' }, { label: 'Vehicle movable', value: 'yes' }])).toContain(
      'The vehicle is at exit 42; and it can still move.',
    );
  });

  it('spells numbers outside North America with their country code', () => {
    expect(spokenDigits('+923001234567')).toBe('plus 9 2 3, 0 0 1, 2 3 4, 5 6 7');
  });

  it('does not spell out the number the caller is ringing from once they have confirmed it', () => {
    // Real call 5176f4be: ten digits read one turn after "Is this the best
    // number to reach you on?" "Yeah.", and the caller hung up 12 s into a
    // read-back of 15 s.
    const text = renderReadBack(ALI_ON_CALLER_ID);
    expect(text).toBe(ALI_ON_CALLER_ID_READ_BACK);
    expect(text).not.toMatch(/\d \d/);
    expect(text).not.toContain('8174098408');
    // Not printed a second time as a detail with no clause of its own.
    expect(text.toLowerCase()).not.toContain('callback caller id');
  });

  it('still reads a number the caller dictated, or has not confirmed, digit by digit', () => {
    expect(renderReadBack([{ label: 'Callback number', value: '+18174098408' }])).toBe(
      `Let me make sure I've got this right. We'll call you back on 8 1 7, 4 0 9, 8 4 0 8. ${READ_BACK_QUESTION}`,
    );
    // Both labels at once: the digits are the caller's chance to catch a wrong one.
    const both = renderReadBack([...ALI, { label: 'Callback caller ID', value: '+18174098408' }]);
    expect(both).toBe(ALI_READ_BACK);
  });

  it('says once that the vehicle cannot move', () => {
    // The same call: "it can't move; the problem is not moving".
    expect(renderReadBack(NOT_MOVING)).toBe(
      "Let me make sure I've got this right. Sam, you need a tow; the Honda Civic is at 2200 Elm Street; it can't move; and we'll call you back on the number you're calling from. Did I get all that right?",
    );
  });

  const withCondition = (condition: string, movable: string | null = 'no') => [
    { label: 'Service', value: 'tow' },
    ...(movable ? [{ label: 'Vehicle movable', value: movable }] : []),
    { label: 'Condition', value: condition },
  ];

  it.each([
    'not moving',
    'Not moving.',
    "won't move",
    'won’t move',
    'wont move',
    "can't move",
    'cannot move',
    "doesn't move",
    "isn't moving",
    "It won't move",
    "it's not moving",
    "the car won't move",
    'stuck',
    'Immobile',
  ])('leaves out the condition "%s" when the vehicle cannot move', (condition) => {
    expect(renderReadBack(withCondition(condition))).toBe(`Let me make sure I've got this right. You need a tow; and it can't move. ${READ_BACK_QUESTION}`);
  });

  it.each([
    ["won't start", "the problem is won't start"],
    ['blowout', 'the problem is a blowout'],
    ['stuck in a ditch', 'the problem is stuck in a ditch'],
    ["engine died and it won't move", "the problem is engine died and it won't move"],
    ['not moving, smoke from the hood', 'the problem is not moving, smoke from the hood'],
  ])('still reads the condition "%s", which says more than that', (condition, said) => {
    expect(renderReadBack(withCondition(condition))).toBe(`Let me make sure I've got this right. You need a tow; it can't move; and ${said}. ${READ_BACK_QUESTION}`);
  });

  it('reads "not moving" when nothing else says the vehicle cannot move', () => {
    expect(renderReadBack(withCondition('not moving', null))).toContain('and the problem is not moving.');
    // Saved as able to move and as not moving: both are read, for the caller to put right.
    expect(renderReadBack(withCondition('not moving', 'yes'))).toContain('it can still move; and the problem is not moving.');
  });
});

describe('the rest of a read-back', () => {
  it('starts at the first detail the caller did not hear in full', () => {
    expect(renderReadBackRest(ALI, "Let me make sure I've got this right. Ali, you need a tow; the Hyundai Sonata is at 3114 Holloway")).toBe(
      "As I was saying, the Hyundai Sonata is at 3114 Holloway Street; it can't move; and we'll call you back on 8 1 7, 4 0 9, 8 4 0 8. Did I get all that right?",
    );
  });

  it('carries on after the last detail heard in full', () => {
    // The real call: "How long will it take?" came 8 s in, after "it".
    expect(renderReadBackRest(ALI, "Let me make sure I've got this right. Ali, you need a tow; the Hyundai Sonata is at 3114 Holloway Street; it")).toBe(
      "As I was saying, it can't move; and we'll call you back on 8 1 7, 4 0 9, 8 4 0 8. Did I get all that right?",
    );
    expect(renderReadBackRest(ALI, "Let me make sure I've got this right. Ali, you need a tow; the Hyundai Sonata is at 3114 Holloway Street; it can't move; and")).toBe(
      "As I was saying, we'll call you back on 8 1 7, 4 0 9, 8 4 0 8. Did I get all that right?",
    );
    expect(renderReadBackRest(ALI, "Let me make sure I've got this right. Ali")).toBe(
      "As I was saying, you need a tow; the Hyundai Sonata is at 3114 Holloway Street; it can't move; and we'll call you back on 8 1 7, 4 0 9, 8 4 0 8. Did I get all that right?",
    );
  });

  it('is only the question when every detail was heard', () => {
    expect(renderReadBackRest(ALI, ALI_READ_BACK.replace(` ${READ_BACK_QUESTION}`, ''))).toBe(READ_BACK_QUESTION);
    // Heard as the model's transcript wrote it: other apostrophes and punctuation.
    expect(renderReadBackRest(ALI, ALI_READ_BACK.replace(/'/g, '’').replace(/;/g, ','))).toBe(READ_BACK_QUESTION);
  });

  it('is the whole read-back when the caller heard none of the details', () => {
    expect(renderReadBackRest(ALI, 'Let me make')).toBe(renderReadBack(ALI));
    expect(renderReadBackRest(ALI, "Let me make sure I've got this right. Al")).toBe(renderReadBack(ALI));
    expect(renderReadBackRest(ALI, '')).toBe(renderReadBack(ALI));
  });

  it('finishes with the number they are calling from, in the same words as the read-back', () => {
    expect(renderReadBackRest(ALI_ON_CALLER_ID, "Let me make sure I've got this right. Ali, you need a tow; the Hyundai Sonata is at 3114 Holloway Street; it can't move; and")).toBe(
      "As I was saying, we'll call you back on the number you're calling from. Did I get all that right?",
    );
    // Cut off inside the clause: it is said again whole.
    expect(
      renderReadBackRest(
        ALI_ON_CALLER_ID,
        "Let me make sure I've got this right. Ali, you need a tow; the Hyundai Sonata is at 3114 Holloway Street; it can't move; and we'll call you back on the number",
      ),
    ).toBe("As I was saying, we'll call you back on the number you're calling from. Did I get all that right?");
    expect(renderReadBackRest(ALI_ON_CALLER_ID, ALI_ON_CALLER_ID_READ_BACK.replace(` ${READ_BACK_QUESTION}`, ''))).toBe(READ_BACK_QUESTION);
    expect(renderReadBackRest(ALI_ON_CALLER_ID, ALI_ON_CALLER_ID_READ_BACK.replace(/'/g, '’').replace(/;/g, ','))).toBe(READ_BACK_QUESTION);
  });

  it('leaves out the condition the read-back left out', () => {
    // Call 5176f4be: the caller spoke 12 s in. What is left never brings "the problem is not moving" back.
    expect(renderReadBackRest(NOT_MOVING, "Let me make sure I've got this right. Sam, you need a tow; the Honda Civic is at 2200 Elm Street; it")).toBe(
      "As I was saying, it can't move; and we'll call you back on the number you're calling from. Did I get all that right?",
    );
    expect(renderReadBackRest(NOT_MOVING, "Let me make sure I've got this right. Sam, you need a tow; the Honda Civic is at 2200 Elm Street; it can't move")).toBe(
      "As I was saying, we'll call you back on the number you're calling from. Did I get all that right?",
    );
  });
});

describe('the fixed lines', () => {
  const lines = {
    SILENCE_CHECK_LINE,
    SAFE_FALLBACK_LINE,
    READ_BACK_QUESTION,
    'read-back': renderReadBack(ALI),
    'read-back with every detail': renderReadBack(EVERYTHING),
    'read-back without a name': renderReadBack(ALI.slice(1)),
    'rest of a read-back': renderReadBackRest(ALI, "Let me make sure I've got this right. Ali, you need a tow"),
    'read-back with a confirmed caller ID': renderReadBack(ALI_ON_CALLER_ID),
    'read-back of a vehicle that is not moving': renderReadBack(NOT_MOVING),
    'rest of a read-back with a confirmed caller ID': renderReadBackRest(ALI_ON_CALLER_ID, "Let me make sure I've got this right. Ali, you need a tow"),
    'goodbye with nothing missing': confirmedGoodbyeLine({ ...state(), missing: [] }),
    'goodbye with details missing': confirmedGoodbyeLine({ ...state(), missing: ['serviceType', 'location', 'vehicle', 'vehicleMovable', 'customerName'] }),
    'goodbye without a state': confirmedGoodbyeLine(undefined),
  };

  it.each(Object.entries(lines))('%s breaks no rule', (_name, line) => {
    expect(checkReply(line)).toEqual({ ok: true });
  });

  it('end a read-back with the one question the backend waits for, and ask nothing else', () => {
    const readBacks = [renderReadBack(ALI), renderReadBack(EVERYTHING), renderReadBack(ALI_ON_CALLER_ID), renderReadBack(NOT_MOVING)];
    for (const line of readBacks) expect(line.startsWith("Let me make sure I've got this right. ")).toBe(true);
    for (const line of [...readBacks, renderReadBackRest(ALI, 'Let me make sure'), renderReadBackRest(NOT_MOVING, "Let me make sure I've got this right. Sam")]) {
      expect(line.endsWith(` ${READ_BACK_QUESTION}`)).toBe(true);
      expect(line.split('?')).toHaveLength(2);
    }
  });

  it('do not ask the caller anything but whether they are there', () => {
    expect(SILENCE_CHECK_LINE).toBe('Still there?');
    expect(SAFE_FALLBACK_LINE).not.toContain('?');
  });
});

describe('the instructions for a goodbye', () => {
  it.each([
    ['turn limit', TURN_LIMIT_GOODBYE_INSTRUCTIONS],
    ['unconfirmed', UNCONFIRMED_GOODBYE_INSTRUCTIONS],
    ['silence', SILENCE_GOODBYE_INSTRUCTIONS],
    ['ending note', ENDING_NOTE],
  ])('%s: forbid a question, the details again and any time, "soon" included', (_name, text) => {
    expect(text).toContain('Ask nothing');
    expect(text).toContain("don't read the details again");
    expect(text).toContain('don\'t say when the team will call, not even "soon"');
  });

  it('keep the ending note headed by its required action', () => {
    expect(ENDING_NOTE.startsWith('REQUIRED ACTION: CLOSE\n')).toBe(true);
  });
});

describe('the instructions after a stopped reply', () => {
  it('say the caller heard nothing only when nothing was heard', () => {
    expect(guardrailRecoveryInstructions('states a price')).toContain('Your last reply was stopped before the caller heard it, because it states a price');
    expect(guardrailRecoveryInstructions('states a price', 'It costs')).toContain('The caller heard you begin "It costs"');
  });

  it('say how to answer a question about what was stopped, in the words of the fixed line', () => {
    expect(guardrailRecoveryInstructions('promises an arrival time')).toContain('the team will go over it with them when they call');
    expect(SAFE_FALLBACK_LINE).toContain('the team will go over it with you when they call');
  });

  it('say what thinking aloud is, without an apology', () => {
    expect(SELF_TALK_RECOVERY_INSTRUCTIONS).toContain('thinking aloud');
    expect(SELF_TALK_RECOVERY_INSTRUCTIONS).toContain("Don't apologise");
  });
});
