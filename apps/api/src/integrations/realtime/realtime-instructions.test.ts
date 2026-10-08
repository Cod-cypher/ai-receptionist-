import { describe, expect, it } from 'vitest';

import { describeIntake } from '../../conversation/intake';
import { determineNextAction } from '../../conversation/next-action';
import { initialContext } from '../../conversation/types';
import { checkReply } from '../../conversation/guardrails';
import { ETA_ANSWER, PRICE_ANSWER } from '../../conversation/ready-answers';
import {
  buildActionNote,
  buildReceptionistInstructions,
  confirmedGoodbyeLine,
  guardrailRecoveryInstructions,
  redirectNote,
  isBackchannel,
  renderReadBack,
  renderReadBackRest,
  spokenDigits,
} from './realtime-instructions';

const state = () => {
  const ctx = initialContext({ customerPhone: '+18174098408', serviceType: 'vehicle towing', customerName: 'Mike', location: 'I-95' });
  return describeIntake(ctx, determineNextAction(ctx, { emergencyNumber: '911' }));
};

describe('the action note', () => {
  it('ends with the required action, whatever else it carries', () => {
    const note = buildActionNote(state(), { beforeSave: true, alreadySaid: 'Got it.', overlap: 'Okay' });
    const lines = note.split('\n');
    expect(lines[0]).toBe('CALL STATE');
    expect(note.indexOf('You ALREADY SAID')).toBeLessThan(note.indexOf('REQUIRED ACTION: ASK_LOCATION_DETAIL'));
    expect(note.indexOf('while you were still speaking')).toBeLessThan(note.indexOf('REQUIRED ACTION:'));
    expect(note).toContain('DO NOT ASK ABOUT:');
  });

  it('ends, before the required action, by telling the model to answer what the caller said', () => {
    // The real call: "How are you doing?" - "Could you tell me what kind of help you need?"
    const note = buildActionNote(state(), { beforeSave: true });
    expect(note).toContain('ANSWER THAT FIRST');
    expect(note).toContain('If they answered your last question with yes or no, that is an answer');
    expect(note.indexOf('ANSWER THAT FIRST')).toBeLessThan(note.indexOf('REQUIRED ACTION:'));
    expect(note).not.toContain('- If they gave no detail: do the REQUIRED ACTION below.');
  });

  it('tells the model to answer the caller after a save too, when the note before it is gone', () => {
    // The real call: a question was taken for a detail, and the reply after the save ignored it.
    const note = buildActionNote(state(), { alreadySaid: 'Okay.' });
    expect(note).toContain('If what the caller just said also needs a reply (a question, a complaint, small talk), answer that first');
    expect(note.indexOf('answer that first')).toBeLessThan(note.indexOf('REQUIRED ACTION:'));
  });

  it('never has the model make up an answer it cannot know', () => {
    // The real call: "How is the weather?" - "The weather is clear right now."
    const never = 'never make up an answer';
    expect(buildActionNote(state(), { beforeSave: true })).toContain(never);
    expect(buildActionNote(state())).toContain(never);
    expect(buildActionNote({ ...state(), callerSaid: { kind: 'question', text: 'How is the weather?' } })).toContain(never);
  });

  it('has a question said over the receptionist answered first', () => {
    // The real call: "Ipi? How's the weather?" - "Where is the vehicle right now?"
    expect(buildActionNote(state(), { beforeSave: true, overlap: "How's the weather?" })).toContain('If it was a question or a complaint, answer it first');
  });

  it('says the caller\'s answer is saved when the backend took it, instead of the before-save rules', () => {
    const note = buildActionNote(state(), { answered: 'Yes.' });
    expect(note).toContain('The caller said "Yes.", and that answer to your question is saved');
    expect(note).toContain('Do not ask that question again');
    expect(note).not.toContain('This state does not include anything from what the caller just said');
    expect(note.indexOf('saved in the state above')).toBeLessThan(note.indexOf('REQUIRED ACTION:'));
  });

  it('asks for the urgency to be acknowledged only on the turn it is due', () => {
    expect(buildActionNote({ ...state(), urgent: true, acknowledgeUrgency: true })).toContain('urgent situation: acknowledge it briefly, once');
    expect(buildActionNote({ ...state(), urgent: true, acknowledgeUrgency: false })).not.toContain('urgent');
  });

  it('says nothing about saving, overlaps or earlier words unless there is something to say', () => {
    const note = buildActionNote(state());
    expect(note).not.toContain('ALREADY SAID');
    expect(note).not.toContain('while you were still speaking');
    expect(note).not.toContain('does not include anything');
    expect(note).not.toContain('THE CALLER');
  });

  it('puts a complaint that went unanswered in front of the required action, in the caller\'s words', () => {
    // The real call: "Why do you keep cutting me off?" - "What kind of help do you need right now?"
    const note = buildActionNote({ ...state(), callerSaid: { kind: 'complaint', text: 'Why do you keep cutting me off?' } });
    expect(note).toContain('YOU DID NOT ANSWER THIS. The caller complained: "Why do you keep cutting me off?"');
    expect(note).toContain('a short apology');
    expect(note.indexOf('YOU DID NOT ANSWER THIS')).toBeLessThan(note.indexOf('REQUIRED ACTION:'));
  });

  it('has an unanswered question answered first, and a line check acknowledged', () => {
    expect(buildActionNote({ ...state(), callerSaid: { kind: 'question', text: 'How much will it cost?' } })).toContain(
      'The caller asked: "How much will it cost?"',
    );
    expect(buildActionNote({ ...state(), callerSaid: { kind: 'line_check', text: 'Can you hear me?' } })).toContain('telling them you can hear them');
  });

  it('gives the rest of a read-back the caller spoke over, word for word, and not the list to start again from', () => {
    const note = buildActionNote({
      ...state(),
      nextAction: 'AWAIT_CONFIRMATION',
      readBack: ALI,
      readBackHeard: 'Let me read that back. Your name is Ali, you need a tow, the vehicle is at 3114 Holloway Street, it',
    });
    expect(note).toContain(
      'To finish the read-back, say exactly: "And the rest: it is a Hyundai Sonata, it can\'t move, the callback number is 8 1 7, 4 0 9, 8 4 0 8. Is that all correct?"',
    );
    expect(note).not.toContain('- Name: Ali');
  });

  it('gives the whole read-back word for word, with the number digit by digit, not a list to phrase', () => {
    // The real call: handed a list, the model read the number as "+18174098408".
    const note = buildActionNote({ ...state(), nextAction: 'CONFIRM_DETAILS', readBack: ALI });
    expect(note).toContain(
      'To read the details back, say exactly: "Let me read that back. Your name is Ali, you need a tow, the vehicle is at 3114 Holloway Street, it is a Hyundai Sonata, it can\'t move, the callback number is 8 1 7, 4 0 9, 8 4 0 8. Is that all correct?"',
    );
    // No list of the details to phrase: the saved facts above it stay as they are.
    expect(note).not.toContain('- Name: Ali');
    expect(note).not.toMatch(/^- Callback number: \+18174098408$/m);
    expect(note.indexOf('REQUIRED ACTION: CONFIRM_DETAILS')).toBeLessThan(note.indexOf('say exactly'));
  });
});

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

const ALI = [
  { label: 'Name', value: 'Ali' },
  { label: 'Service', value: 'tow' },
  { label: 'Location', value: '3114 Holloway Street' },
  { label: 'Vehicle', value: 'Hyundai Sonata' },
  { label: 'Vehicle movable', value: 'no' },
  { label: 'Callback number', value: '+18174098408' },
];

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

describe('the receptionist\'s instructions', () => {
  const FACTS = {
    name: 'Liberty Towing',
    phone: null,
    website: null,
    address: null,
    serviceAreas: ['Dallas'],
    services: ['Local towing'],
    businessHoursText: null,
    isOpenNow: true,
    pricingInfo: null,
    emergencyContact: null,
    faq: [],
    tone: 'friendly' as const,
    businessInstructions: null,
  };
  const instructions = buildReceptionistInstructions({ facts: FACTS, callerNumber: '+18174098408' });

  it('state the three rules for a caller\'s question, word for word', () => {
    expect(instructions).toContain('1. If the caller asks a question, answer that question before continuing the current intake or confirmation step.');
    expect(instructions).toContain('2. Never repeat an intake question or confirmation merely because the caller asked an unrelated question.');
    expect(instructions).toContain('3. After answering, resume the previous step from its current state.');
    expect(instructions.indexOf('WHEN THE CALLER ASKS SOMETHING')).toBeLessThan(instructions.indexOf('CAPTURE RULES'));
  });

  it('give a ready answer to "how soon" and "how much" that needs no lookup', () => {
    expect(instructions).toContain(`say "${ETA_ANSWER}"`);
    expect(instructions).toContain(`say "${PRICE_ANSWER}"`);
    expect(instructions).toContain('with NO tool call');
  });

  it('have a configured price looked up, since that is what allows a price to be spoken', () => {
    const priced = buildReceptionistInstructions({ facts: { ...FACTS, pricingInfo: 'Local tows start at $95.' }, callerNumber: null });
    expect(priced).not.toContain(PRICE_ANSWER);
    expect(priced).toContain('topic "pricing"');
    // The price itself is never in the prompt: it comes from the lookup.
    expect(priced).not.toContain('$95');
  });

  it('forbid making up what the receptionist cannot know', () => {
    expect(instructions).toContain('make up anything you have not been told and cannot check, such as the weather');
    expect(instructions).toContain('Say you did not catch it only if you did not');
  });

  it('show what to do with a yes to the number question', () => {
    expect(instructions).toContain('Caller: "Yes." (after you asked whether the number they are calling from is the best one to reach them)');
    expect(instructions).toContain('callerIdConfirmed true and nothing else');
  });

  it('tell the model the caller hears every word, so it never thinks aloud', () => {
    expect(instructions).toContain('think aloud about your instructions, your tools, the call state or what to do next');
  });

  it('promise nothing the guardrails would stop the receptionist from saying', () => {
    expect(checkReply(ETA_ANSWER)).toEqual({ ok: true });
    expect(checkReply(PRICE_ANSWER)).toEqual({ ok: true });
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

describe('isBackchannel', () => {
  it('recognises words of acknowledgement, in any mix', () => {
    for (const said of ['Okay.', 'uh-huh', 'Yeah, okay.', 'Mm-hmm.', 'Right, got it.', 'yes', 'Sure!']) {
      expect(isBackchannel(said), said).toBe(true);
    }
  });

  it('treats anything with content as the caller taking the floor', () => {
    for (const said of ['Okay, but it is a Ford.', 'Hello?', 'Wait.', 'Yes, exit 12.', 'No.']) {
      expect(isBackchannel(said), said).toBe(false);
    }
  });
});

describe('the note after a stopped reply', () => {
  const plan = () => determineNextAction(initialContext({ customerPhone: '+18174098408', serviceType: 'tow', location: 'I-95' }));

  it('says the caller heard nothing only when nothing was heard', () => {
    expect(redirectNote('callback_number', plan())).toContain('stopped before the caller heard it: the callback number has to wait');
    expect(guardrailRecoveryInstructions('states a price')).toContain('stopped before the caller heard it, because it states a price');
  });

  it('says a settled topic is settled, not "to wait", and gives the read-back word for word', () => {
    const ctx = { ...initialContext({ customerPhone: '+18174098408', serviceType: 'tow', location: 'I-95 near exit 42', vehicleType: 'car', vehicleMovable: false, customerName: 'Ali' }), phoneConfirmed: true };
    const plan = determineNextAction(ctx);
    expect(plan.action).toBe('CONFIRM_DETAILS');
    const note = redirectNote('callback_number', plan, 'Is the number');
    expect(note).toContain('the callback number is already settled, so do not ask about it again');
    expect(note).not.toContain('has to wait');
    expect(note).toContain('say exactly: "Let me read that back.');
  });

  it('says what the caller heard when they heard some of it', () => {
    const note = redirectNote('callback_number', plan(), 'Is this the best');
    expect(note).toContain('The caller heard you begin "Is this the best"');
    expect(note).toContain('Do not finish that question.');
    expect(note).not.toContain('before the caller heard it');
    expect(guardrailRecoveryInstructions('states a price', 'It costs')).toContain('The caller heard you begin "It costs"');
  });
});
