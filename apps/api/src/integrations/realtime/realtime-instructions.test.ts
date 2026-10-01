import { describe, expect, it } from 'vitest';

import { describeIntake } from '../../conversation/intake';
import { determineNextAction } from '../../conversation/next-action';
import { initialContext } from '../../conversation/types';
import { checkReply } from '../../conversation/guardrails';
import { ETA_ANSWER, PRICE_ANSWER } from '../../conversation/ready-answers';
import {
  buildActionNote,
  buildReceptionistInstructions,
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
