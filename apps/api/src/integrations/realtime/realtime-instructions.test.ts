import { describe, expect, it } from 'vitest';

import { describeIntake } from '../../conversation/intake';
import { determineNextAction } from '../../conversation/next-action';
import { initialContext } from '../../conversation/types';
import { buildActionNote, isBackchannel, renderReadBack, spokenDigits } from './realtime-instructions';

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

  it('says nothing about saving, overlaps or earlier words unless there is something to say', () => {
    const note = buildActionNote(state());
    expect(note).not.toContain('ALREADY SAID');
    expect(note).not.toContain('while you were still speaking');
    expect(note).not.toContain('does not include anything');
    expect(note).not.toContain('THE CALLER');
  });

  it('puts a complaint in front of the required action, in the caller\'s words', () => {
    // The real call: "Why do you keep cutting me off?" - "What kind of help do you need right now?"
    const note = buildActionNote({ ...state(), callerSaid: { kind: 'complaint', text: 'Why do you keep cutting me off?' } });
    expect(note).toContain('THE CALLER COMPLAINED: "Why do you keep cutting me off?"');
    expect(note).toContain('say sorry');
    expect(note.indexOf('THE CALLER COMPLAINED')).toBeLessThan(note.indexOf('REQUIRED ACTION:'));
  });

  it('has a question answered first, and a line check acknowledged', () => {
    expect(buildActionNote({ ...state(), callerSaid: { kind: 'question', text: 'How much will it cost?' } })).toContain(
      'THE CALLER ASKED: "How much will it cost?"',
    );
    expect(buildActionNote({ ...state(), callerSaid: { kind: 'line_check', text: 'Can you hear me?' } })).toContain('tell them you can hear them');
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
