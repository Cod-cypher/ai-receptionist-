import { describe, expect, it } from 'vitest';

import { describeIntake } from '../../conversation/intake';
import { determineNextAction } from '../../conversation/next-action';
import { initialContext } from '../../conversation/types';
import { buildActionNote, redirectNote } from './action-note';
import type { CallerWordsKind } from './caller-words';

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

  it('never has the model make up a live fact, and still has small talk answered like a person', () => {
    // The real calls: "How is the weather?" - "The weather is clear right now.";
    // then, told only not to make answers up, "How are you?" - "I'm here to help", three times.
    for (const note of [
      buildActionNote(state(), { beforeSave: true }),
      buildActionNote(state()),
      buildActionNote({ ...state(), callerSaid: { kind: 'question', text: 'How is the weather?' } }),
    ]) {
      expect(note).toContain('never make one up');
      expect(note).toContain('Small talk gets a normal, friendly answer ("I\'m well, thanks.")');
    }
  });

  it('has a question said over the receptionist answered first, and anything else replied to', () => {
    // The real calls: "Ipi? How's the weather?" - "Where is the vehicle right now?";
    // "The sun rises." - "Sorry, I didn't catch that".
    const note = buildActionNote(state(), { beforeSave: true, overlap: "How's the weather?" });
    expect(note).toContain('If it was a question or a complaint, answer it first');
    expect(note).toContain('do not say you did not catch it');
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

describe('the note when the caller\'s words are known', () => {
  const KINDS: CallerWordsKind[] = ['question', 'complaint', 'line_check', 'small_talk', 'unfinished', 'backchannel', 'asking_for_time', 'detail', 'unknown'];

  it('quotes the words and gives one directive for every kind, in place of the before-save rules', () => {
    for (const kind of KINDS) {
      const note = buildActionNote(state(), { beforeSave: true, callerJustSaid: { text: 'I asked you something else.', kind } });
      expect(note, kind).toContain('THE CALLER JUST SAID: "I asked you something else."');
      expect(note, kind).not.toContain('This state does not include anything from what the caller just said');
      expect(note.indexOf('THE CALLER JUST SAID'), kind).toBeLessThan(note.indexOf('REQUIRED ACTION:'));
    }
  });

  it('has a cut-off line finished before anything is asked, and a detail saved first', () => {
    expect(buildActionNote(state(), { callerJustSaid: { text: 'Okay, so what happens if we try to', kind: 'unfinished' } })).toContain(
      'ask them to finish what they were saying. Ask nothing else.',
    );
    expect(buildActionNote(state(), { callerJustSaid: { text: "I'm at exit 42, how long will it take?", kind: 'detail' } })).toContain(
      'If it also asked something, answer that after the save.',
    );
  });

  it('quotes an unanswered line once when it is the very line the caller just said', () => {
    const said = { kind: 'complaint' as const, text: 'I asked you something else.' };
    const once = buildActionNote({ ...state(), callerSaid: said }, { callerJustSaid: { text: said.text, kind: 'complaint' } });
    expect(once.match(/I asked you something else\./g)).toHaveLength(1);
    expect(once).not.toContain('YOU DID NOT ANSWER THIS');
    const twice = buildActionNote({ ...state(), callerSaid: said }, { callerJustSaid: { text: 'What do you have so far?', kind: 'question' } });
    expect(twice).toContain('YOU DID NOT ANSWER THIS');
    expect(twice).toContain('THE CALLER JUST SAID: "What do you have so far?"');
  });
});

describe('the note after a stopped reply', () => {
  const plan = () => determineNextAction(initialContext({ customerPhone: '+18174098408', serviceType: 'tow', location: 'I-95' }));

  it('says the caller heard nothing only when nothing was heard', () => {
    expect(redirectNote('callback_number', plan())).toContain('stopped before the caller heard it: the callback number has to wait');
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
  });
});
