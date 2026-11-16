import { describe, expect, it } from 'vitest';

import { describeIntake, type IntakeSnapshot } from '../../conversation/intake';
import { determineNextAction } from '../../conversation/next-action';
import { initialContext } from '../../conversation/types';
import { buildActionNote, replyInstructions, redirectNote, type ActionNoteOptions } from './action-note';
import type { CallerWordsKind } from './caller-words';
import { TOOL } from './realtime-tools';
import { renderReadBack, renderReadBackRest } from './spoken-lines';

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

/** The vehicle is asked, and what is wrong with it is known to come next: the plan names it (`ifAnswered`). */
const vehicleState = () => {
  const ctx = initialContext({ customerPhone: '+18174098408', serviceType: 'tow', location: '3114 Holloway Street' });
  return describeIntake(ctx, determineNextAction(ctx, { emergencyNumber: '911' }));
};
const SAVE_AND_ASK = `If it answers your question: save it with ${TOOL.UPDATE} and, in the same reply, say a short ack and ask: "What's wrong with it?"`;

const lastLine = (note: string) => note.split('\n').at(-1)!;
const lineOf = (note: string, start: string) => note.split('\n').findIndex((line) => line.startsWith(start));

/** One line per kind, from the real calls where there is one. */
const SAID: Record<CallerWordsKind, string> = {
  question: 'What kind of information have I already given you?',
  complaint: 'I asked you something else.',
  line_check: 'Can you hear me?',
  small_talk: "How's the weather today?",
  unfinished: 'Okay, so what happens if we try to',
  backchannel: 'Okay.',
  asking_for_time: 'Hold on, let me find the exit.',
  detail: "I'm at exit 42, how long will it take?",
  unknown: 'The sun rises.',
};
const KINDS = Object.keys(SAID) as CallerWordsKind[];

describe('the action note', () => {
  it('puts the state first, the context before the required action, and the live rule last', () => {
    const note = buildActionNote(state(), { beforeSave: true, alreadySaid: 'Got it.', overlap: 'Okay' });
    const lines = note.split('\n');
    expect(lines[0]).toBe('CALL STATE');
    expect(note.indexOf('You ALREADY SAID')).toBeLessThan(note.indexOf('REQUIRED ACTION: ASK_LOCATION_DETAIL'));
    expect(note.indexOf('while you were still speaking')).toBeLessThan(note.indexOf('REQUIRED ACTION:'));
    // The ask on the line after the marker, then DO NOT ASK, then the rule.
    expect(lines[lineOf(note, 'REQUIRED ACTION:') + 1]).toBe(state().ask);
    expect(lineOf(note, 'DO NOT ASK ABOUT:')).toBeGreaterThan(lineOf(note, 'REQUIRED ACTION:'));
    expect(lineOf(note, 'This state does not include')).toBeGreaterThan(lineOf(note, 'DO NOT ASK ABOUT:'));
    expect(lastLine(note)).toContain('ANY detail');
  });

  it('ends, when the caller\'s words are not known yet, with the answer-first rule and then the save rule', () => {
    // The real call: "How are you doing?" - "Could you tell me what kind of help you need?"
    // The save rule is last since the live check where a line full of details was met with a question and nothing was saved.
    const note = buildActionNote(state(), { beforeSave: true });
    const lines = note.split('\n');
    expect(lines.at(-2)).toBe("This state does not include anything from what the caller just said. Not a detail? Answer it in one sentence FIRST, then ask the next thing.");
    expect(lines.at(-1)).toBe(`ANY detail (a yes or no counts): save it with ${TOOL.UPDATE} first and say nothing until the result.`);
  });

  it('tells the model to answer the caller after a save too, when the note before it is gone', () => {
    // The real call: a question was taken for a detail, and the reply after the save ignored it.
    const note = buildActionNote(state(), { alreadySaid: 'Okay.' });
    expect(lastLine(note)).toBe('If what they just said needs a reply, answer it in one sentence FIRST, then ask the next thing.');
    expect(note).not.toContain('does not include anything');
  });

  it('never has the model make up a live fact, where a question may ask for one, and has small talk answered like a person', () => {
    // The real calls: "How is the weather?" - "The weather is clear right now.";
    // then, told only not to make answers up, "How are you?" - "I'm here to help", three times.
    for (const note of [
      buildActionNote(state(), { callerJustSaid: { text: 'How is the weather?', kind: 'question' } }),
      buildActionNote(state(), { callerJustSaid: { text: 'How is the weather?', kind: 'small_talk' } }),
      buildActionNote({ ...state(), callerSaid: { kind: 'question', text: 'How is the weather?' } }),
    ]) {
      expect(note).toContain("Never make up a live fact like the weather; say you can't check it.");
    }
    expect(buildActionNote(state(), { callerJustSaid: { text: 'How are you?', kind: 'small_talk' } })).toContain('Answer it like a person, in a few words');
    // Not where it would only make the model evasive.
    expect(buildActionNote(state(), { callerJustSaid: { text: 'I asked you something else.', kind: 'complaint' } })).not.toContain('live fact');
  });

  it('has a line said over the receptionist replied to, never "didn\'t catch it", nor what it said repeated', () => {
    // The real calls: "Ipi? How's the weather?" - "Where is the vehicle right now?";
    // "The sun rises." - "Sorry, I didn't catch that".
    const note = buildActionNote(state(), { beforeSave: true, overlap: "How's the weather?" });
    expect(note).toContain(`The caller said "How's the weather?" while you were still speaking, then heard you finish`);
    expect(note).toContain("never say you didn't catch it");
    expect(note).toContain("don't repeat what you said");
    expect(note).toContain('Answer it in one sentence FIRST');
  });

  it('says the caller\'s answer is saved when the backend took it, instead of the before-save rules', () => {
    const note = buildActionNote(state(), { answered: 'Yes.' });
    expect(note).toContain('The caller said "Yes.", and that answer to your question is saved');
    expect(note).toContain("don't ask it again");
    expect(note).not.toContain('This state does not include anything from what the caller just said');
    expect(note.indexOf('is saved')).toBeLessThan(note.indexOf('REQUIRED ACTION:'));
    expect(lastLine(note)).toBe(`If they also gave another detail, save it with ${TOOL.UPDATE} first; otherwise ask the next thing now.`);
  });

  it('lets a question asked in the same breath as the save be answered, rather than asking another', () => {
    const note = buildActionNote(state(), { alreadySaid: 'Got it. What happened to the car?' });
    expect(note).toContain('You ALREADY SAID: "Got it. What happened to the car?"');
    expect(note).toContain("That question came before the details were saved: don't ask it again or anything else until they answer.");
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

  it('never shows the number they are calling from until it is confirmed', () => {
    // The real call: the caller ID in CALL STATE was sent back as a "detail" on a turn with none.
    const note = buildActionNote(state());
    expect(note).toContain("- Callback number: the number they're calling from (not confirmed yet)");
    expect(note).not.toContain('8174098408');
    expect(buildActionNote({ ...state(), phoneConfirmed: true })).toContain('- Callback number: +18174098408 (confirmed)');
  });

  it('puts a complaint that went unanswered just before the last line, in the caller\'s words', () => {
    // The real call: "Why do you keep cutting me off?" - "What kind of help do you need right now?"
    const note = buildActionNote({ ...state(), callerSaid: { kind: 'complaint', text: 'Why do you keep cutting me off?' } });
    expect(note).toContain('YOU DID NOT ANSWER THIS. The caller complained: "Why do you keep cutting me off?"');
    expect(note).toContain('a short apology');
    const lines = note.split('\n');
    expect(lineOf(note, 'YOU DID NOT ANSWER THIS')).toBe(lines.length - 2);
    expect(lineOf(note, 'YOU DID NOT ANSWER THIS')).toBeGreaterThan(lineOf(note, 'DO NOT ASK ABOUT:'));
  });

  it('has an unanswered question answered first, and a line check acknowledged', () => {
    expect(buildActionNote({ ...state(), callerSaid: { kind: 'question', text: 'How much will it cost?' } })).toContain(
      'The caller asked: "How much will it cost?"',
    );
    expect(buildActionNote({ ...state(), callerSaid: { kind: 'line_check', text: 'Can you hear me?' } })).toContain('saying you can hear them');
  });

  it('gives the rest of a read-back the caller spoke over, word for word, and not the list to start again from', () => {
    const heard = 'Let me read that back. Your name is Ali, you need a tow, the vehicle is at 3114 Holloway Street, it';
    const note = buildActionNote({ ...state(), nextAction: 'AWAIT_CONFIRMATION', readBack: ALI, readBackHeard: heard });
    expect(note).toContain(`To finish the read-back, say exactly: "${renderReadBackRest(ALI, heard)}"`);
    expect(note).not.toContain('- Name: Ali');
    expect(lastLine(note)).toContain('then finish the read-back.');
  });

  it('gives the whole read-back word for word, not a list to phrase, after the required action', () => {
    // The real call: handed a list, the model read the number as "+18174098408".
    const note = buildActionNote({ ...state(), nextAction: 'CONFIRM_DETAILS', readBack: ALI }, { callerJustSaid: { text: 'How long?', kind: 'question' } });
    expect(note).toContain(`To read the details back, say exactly: "${renderReadBack(ALI)}"`);
    // No list of the details to phrase: the saved facts above it stay as they are.
    expect(note).not.toContain('- Name: Ali');
    expect(note).not.toMatch(/^- Callback number: \+18174098408$/m);
    expect(lineOf(note, 'To read the details back')).toBe(lineOf(note, 'REQUIRED ACTION: CONFIRM_DETAILS') + 2);
    // Asked a question first, the model answers it and then reads, rather than asking.
    expect(lastLine(note)).toContain('Answer it in one sentence, then read the details back.');
  });

  it('has the safety advice given after an answer, not "the next thing" asked', () => {
    const note = buildActionNote({ ...state(), nextAction: 'HANDLE_SAFETY' }, { callerJustSaid: { text: 'Can you hear me?', kind: 'line_check' } });
    expect(lastLine(note)).toBe("They're checking the line. Say you can hear them, then give the safety advice.");
  });
});

describe('the live rule is the last thing the model reads', () => {
  const READ_BACK = { ...state(), nextAction: 'CONFIRM_DETAILS' as const, readBack: ALI };
  const cases: Array<[string, IntakeSnapshot, ActionNoteOptions, string]> = [
    ['before the save', state(), { beforeSave: true }, 'ANY detail'],
    ['after the save', state(), { alreadySaid: 'Got it.' }, 'If what they just said needs a reply'],
    ['an answer the backend saved', state(), { answered: 'Yes.', overlap: 'Yes.' }, 'If they also gave another detail'],
    ['the caller\'s words known', state(), { beforeSave: true, callerJustSaid: { text: SAID.complaint, kind: 'complaint' } }, "That's a complaint."],
    ['with an unanswered earlier line', { ...state(), callerSaid: { kind: 'question', text: 'Who is this?' } }, { beforeSave: true }, 'ANY detail'],
    ['with the read-back', READ_BACK, { callerJustSaid: { text: SAID.backchannel, kind: 'backchannel' } }, 'Just an acknowledgement: read the details back.'],
    ['with the question after this one', vehicleState(), { beforeSave: true }, 'But if it answers your question: save it'],
    ['with the question after this one and an unanswered earlier line', { ...vehicleState(), callerSaid: { kind: 'question', text: 'Who is this?' } }, { beforeSave: true }, 'But if it answers your question: save it'],
  ];

  it.each(cases)('%s', (_, snapshot, options, rule) => {
    const note = buildActionNote(snapshot, options);
    const last = note.split('\n').length - 1;
    expect(lastLine(note).startsWith(rule)).toBe(true);
    for (const marker of ['REQUIRED ACTION:', 'DO NOT ASK ABOUT:', 'To read the details back', 'YOU DID NOT ANSWER THIS', 'THE CALLER JUST SAID']) {
      expect(lineOf(note, marker), marker).toBeLessThan(last);
    }
  });
});

describe('the note when the caller\'s words are known', () => {
  it('quotes the words and gives one directive for every kind, last, in place of the before-save rules', () => {
    for (const kind of KINDS) {
      const note = buildActionNote(state(), { beforeSave: true, callerJustSaid: { text: 'I asked you something else.', kind } });
      const lines = note.split('\n');
      expect(lines.at(-2), kind).toBe('THE CALLER JUST SAID: "I asked you something else."');
      expect(note, kind).not.toContain('This state does not include anything from what the caller just said');
      expect(lineOf(note, 'THE CALLER JUST SAID'), kind).toBeGreaterThan(lineOf(note, 'DO NOT ASK ABOUT:'));
    }
  });

  it.each<[CallerWordsKind, string]>([
    ['question', "That's a question. Answer it in one sentence, then ask the next thing."],
    ['complaint', "That's a complaint. Say sorry in a few words and that you're listening, then ask the next thing. Don't explain."],
    ['line_check', "They're checking the line. Say you can hear them, then ask the next thing."],
    ['small_talk', "That's small talk. Answer it like a person, in a few words, then ask the next thing."],
    ['asking_for_time', "They asked for a moment. Say that's fine and wait; ask nothing."],
    ['unknown', 'If it needs an answer, answer it in one sentence; then ask the next thing.'],
  ])('tells the model what to do about a %s', (kind, directive) => {
    expect(lastLine(buildActionNote(state(), { callerJustSaid: { text: SAID[kind], kind } }))).toContain(directive);
  });

  it('has a cut-off line finished before anything is asked, in the caller\'s own last words', () => {
    // The real call: "Okay, so what happens if we try to" - "Where is the vehicle right now?"
    const finish = (text: string) => lastLine(buildActionNote(state(), { callerJustSaid: { text, kind: 'unfinished' } }));
    expect(finish(SAID.unfinished)).toBe('They were cut off mid-sentence. Ask them to finish, like: "Sorry, try to what?" Say only that: the REQUIRED ACTION question waits for your next reply.');
    expect(finish('My car is on I-95 at the')).toContain('"Sorry, at the what?"');
    expect(finish('So I,')).toContain('"Sorry, so I what?"');
    expect(finish('...')).toContain('"Sorry, go on?"');
  });

  it('has a detail saved first while the state predates it, and only what is missing saved after', () => {
    const before = buildActionNote(state(), { beforeSave: true, callerJustSaid: { text: SAID.detail, kind: 'detail' } });
    expect(lastLine(before)).toBe(
      `That's a rough transcript: save what you heard them say, in their words. Save it with ${TOOL.UPDATE} first and say nothing until the result. If it also asked something, answer that after the save.`,
    );
    // After the save it is in CALL STATE; the question in the same line is answered then.
    const after = buildActionNote(state(), { alreadySaid: 'Okay.', callerJustSaid: { text: SAID.detail, kind: 'detail' } });
    expect(lastLine(after)).toBe(
      `If any of it isn't in CALL STATE yet, save that with ${TOOL.UPDATE} first. If it also asked something, answer that in one sentence; then ask the next thing.`,
    );
  });

  it('has a short line that may answer the question saved first while the state predates it', () => {
    // A yes is an answer: on a real call "Yes." was heard three times, nothing saved, and the question asked again.
    for (const kind of ['backchannel', 'unknown'] as const) {
      expect(lastLine(buildActionNote(state(), { beforeSave: true, callerJustSaid: { text: 'Yeah.', kind } })), kind).toContain(
        `save it with ${TOOL.UPDATE} first and say nothing until the result`,
      );
      expect(lastLine(buildActionNote(state(), { callerJustSaid: { text: 'Yeah.', kind } })), kind).not.toContain(TOOL.UPDATE);
    }
    expect(lastLine(buildActionNote(state(), { callerJustSaid: { text: 'Okay.', kind: 'backchannel' } }))).toBe('Just an acknowledgement: ask the next thing.');
  });

  it('never has a line that needs a reply saved', () => {
    for (const kind of ['question', 'complaint', 'line_check', 'small_talk', 'unfinished', 'asking_for_time'] as const) {
      expect(lastLine(buildActionNote(state(), { beforeSave: true, callerJustSaid: { text: SAID[kind], kind } })), kind).not.toContain(TOOL.UPDATE);
    }
  });

  it('quotes an unanswered line once when it is the very line the caller just said', () => {
    const said = { kind: 'complaint' as const, text: 'I asked you something else.' };
    const once = buildActionNote({ ...state(), callerSaid: said }, { callerJustSaid: { text: said.text, kind: 'complaint' } });
    expect(once.match(/I asked you something else\./g)).toHaveLength(1);
    expect(once).not.toContain('YOU DID NOT ANSWER THIS');
    const twice = buildActionNote({ ...state(), callerSaid: said }, { callerJustSaid: { text: 'What do you have so far?', kind: 'question' } });
    expect(twice).toContain('YOU DID NOT ANSWER THIS');
    expect(twice).toContain('THE CALLER JUST SAID: "What do you have so far?"');
    expect(lineOf(twice, 'YOU DID NOT ANSWER THIS')).toBe(lineOf(twice, 'THE CALLER JUST SAID') - 1);
  });
});

describe('the note that names the question after this one', () => {
  // Real call 5176f4be: told to save, say nothing and wait for a second reply
  // to ask with, the model kept the caller waiting a median of two seconds.
  const ROUGH = "That's a rough transcript: save what you heard them say, in their words.";
  const SAVE_FIRST = `save it with ${TOOL.UPDATE} first and say nothing until the result`;
  const without = (): IntakeSnapshot => {
    const { ifAnswered: _named, ...rest } = vehicleState();
    return rest;
  };

  it('is built from a plan that names one', () => {
    expect(vehicleState().nextAction).toBe('ASK_VEHICLE');
    expect(vehicleState().ifAnswered).toEqual({ topic: 'condition', sample: "What's wrong with it?" });
    expect(state().ifAnswered).toBeUndefined();
  });

  it('ends, with the caller\'s words unknown, on saving the answer and asking that question in one reply', () => {
    const lines = buildActionNote(vehicleState(), { beforeSave: true }).split('\n');
    expect(lines.slice(-3)).toEqual([
      'This state does not include anything from what the caller just said. Not a detail? Answer it in one sentence FIRST, then ask the REQUIRED ACTION question.',
      // Every detail is still saved, in the words that rule had; one that is not the answer changes what comes next, and waits for the result.
      `ANY detail (a yes or no counts): save it with ${TOOL.UPDATE} first and say nothing until the result.`,
      `But if it answers your question: save it with ${TOOL.UPDATE} and, in the same reply, say a short ack and ask: "What's wrong with it?"`,
    ]);
  });

  it.each<[CallerWordsKind, string]>([
    [
      'detail',
      `${ROUGH} Save it with ${TOOL.UPDATE} first and say nothing until the result. But if it answers your question: save it with ${TOOL.UPDATE} and, in the same reply, say a short ack, answer anything it asked, and ask: "What's wrong with it?"`,
    ],
    ['backchannel', `If it's only an acknowledgement, ask the REQUIRED ACTION question. ${SAVE_AND_ASK}`],
    [
      'unknown',
      `If it needs an answer, answer it in one sentence; then ask the REQUIRED ACTION question. If it's a detail, ${SAVE_FIRST}. But if it answers your question: save it with ${TOOL.UPDATE} and, in the same reply, say a short ack and ask: "What's wrong with it?"`,
    ],
  ])('ends a quoted %s on it too, after the caller\'s words', (kind, rule) => {
    const lines = buildActionNote(vehicleState(), { beforeSave: true, callerJustSaid: { text: SAID[kind], kind } }).split('\n');
    expect(lines.at(-2)).toBe(`THE CALLER JUST SAID: "${SAID[kind]}"`);
    expect(lines.at(-1)).toBe(rule);
    // The line to say is the last thing read, and the save is in the same sentence as it.
    expect(lines.at(-1)!.endsWith('ask: "What\'s wrong with it?"')).toBe(true);
    expect(lines.at(-1)!.lastIndexOf(TOOL.UPDATE)).toBeGreaterThan(lines.at(-1)!.lastIndexOf('. '));
  });

  it('keeps saving the rule for any detail, and silence until the result for one that is not the answer', () => {
    const notes = [
      buildActionNote(vehicleState(), { beforeSave: true }),
      ...(['detail', 'unknown'] as const).map((kind) => buildActionNote(vehicleState(), { beforeSave: true, callerJustSaid: { text: SAID[kind], kind } })),
    ];
    for (const note of notes) {
      expect(note).toContain(`with ${TOOL.UPDATE} first`);
      expect(note).toContain('say nothing until the result');
      expect(note.indexOf('say nothing until the result')).toBeLessThan(note.indexOf('But if it answers your question:'));
    }
    expect(notes[0]).toContain('ANY detail (a yes or no counts): save it');
  });

  it('leaves a line that needs a reply of its own as it was', () => {
    for (const kind of ['question', 'complaint', 'line_check', 'small_talk', 'unfinished', 'asking_for_time'] as const) {
      const options: ActionNoteOptions = { beforeSave: true, callerJustSaid: { text: SAID[kind], kind } };
      expect(buildActionNote(vehicleState(), options), kind).toBe(buildActionNote(without(), options));
    }
  });

  it('is not named without one on the plan, on the note after a save, or once the backend has saved the answer', () => {
    const named = 'in the same reply';
    const quoted = { text: SAID.detail, kind: 'detail' } as const;
    for (const options of [{ beforeSave: true }, { beforeSave: true, callerJustSaid: quoted }] satisfies ActionNoteOptions[]) {
      expect(buildActionNote(vehicleState(), options)).toContain(named);
      expect(buildActionNote(without(), options)).not.toContain(named);
      expect(buildActionNote(state(), options)).not.toContain(named);
    }
    // The note with the tool results asks from a state that has the answer in it.
    for (const options of [{}, { alreadySaid: 'Got it.' }, { callerJustSaid: quoted }, { answered: 'A Civic.' }] satisfies ActionNoteOptions[]) {
      expect(buildActionNote(vehicleState(), options)).toBe(buildActionNote(without(), options));
      expect(buildActionNote(vehicleState(), options)).not.toContain("What's wrong with it?");
    }
    expect(replyInstructions(vehicleState(), { text: SAID.question, kind: 'question' })).toBe(replyInstructions(without(), { text: SAID.question, kind: 'question' }));
  });

  it('is not named when a line said word for word comes next', () => {
    const readBack: IntakeSnapshot = { ...vehicleState(), nextAction: 'CONFIRM_DETAILS', readBack: ALI };
    expect(buildActionNote(readBack, { beforeSave: true })).not.toContain('in the same reply');
  });
});

describe('a quoted detail is a transcript, not what the caller said', () => {
  // Real call 5176f4be: the transcriber wrote "Kalimantan Malay is 73rd", the
  // note quoted it, and the model saved that text as the location and read it back.
  const heard = { text: 'Kalimantan Malay is 73rd', kind: 'detail' } as const;
  const TRUST = "That's a rough transcript: save what you heard them say, in their words.";

  it('says so before the save, where the quote is what would be saved', () => {
    for (const snapshot of [state(), vehicleState()]) {
      const lines = buildActionNote(snapshot, { beforeSave: true, callerJustSaid: heard }).split('\n');
      // The label is as it was: the prompt and the gateway refer to it.
      expect(lines.at(-2)).toBe('THE CALLER JUST SAID: "Kalimantan Malay is 73rd"');
      expect(lines.at(-1)!.startsWith(TRUST)).toBe(true);
    }
  });

  it('says nothing of it for any other kind of line, or once the save is done', () => {
    for (const kind of KINDS.filter((k) => k !== 'detail')) {
      expect(buildActionNote(vehicleState(), { beforeSave: true, callerJustSaid: { text: SAID[kind], kind } }), kind).not.toContain('rough transcript');
    }
    expect(buildActionNote(state(), { callerJustSaid: heard })).not.toContain('rough transcript');
  });
});

describe('the note is short', () => {
  /**
   * Words in the note, without DO NOT ASK (a list of labels, as long as the
   * plan's) and any read-back (said word for word). The ask is the
   * next-action engine's and is being made short in its own file; this one is
   * the length it aims at.
   */
  const words = (note: string) =>
    note
      .split('\n')
      .filter((line) => !line.startsWith('DO NOT ASK ABOUT:') && !line.includes('say exactly:'))
      .join(' ')
      .split(/\s+/)
      .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  const midCall = (): IntakeSnapshot => ({ ...state(), ask: 'Ask exactly where on I-95. Say it like: "Where on I-95 are you? An exit or a mile marker?"' });

  it('is at most 90 words before the save, with the caller\'s words unknown', () => {
    expect(words(buildActionNote(midCall(), { beforeSave: true }))).toBeLessThanOrEqual(90);
  });

  it.each(KINDS)('is at most 90 words with a %s quoted, before or after the save', (kind) => {
    expect(words(buildActionNote(midCall(), { beforeSave: true, callerJustSaid: { text: SAID[kind], kind } }))).toBeLessThanOrEqual(90);
    expect(words(buildActionNote(midCall(), { callerJustSaid: { text: SAID[kind], kind } }))).toBeLessThanOrEqual(90);
  });

  it('is at most 110 words where it also names the question after this one', () => {
    // The follow-up costs some twenty words: a second reply costs the caller two seconds.
    expect(words(buildActionNote(vehicleState(), { beforeSave: true }))).toBeLessThanOrEqual(110);
    for (const kind of ['detail', 'backchannel', 'unknown'] as const) {
      expect(words(buildActionNote(vehicleState(), { beforeSave: true, callerJustSaid: { text: SAID[kind], kind } })), kind).toBeLessThanOrEqual(110);
    }
    // Every other note for that state is as short as before.
    for (const kind of KINDS.filter((k) => !['detail', 'backchannel', 'unknown'].includes(k))) {
      expect(words(buildActionNote(vehicleState(), { beforeSave: true, callerJustSaid: { text: SAID[kind], kind } })), kind).toBeLessThanOrEqual(90);
    }
    expect(words(buildActionNote(vehicleState(), { alreadySaid: 'Got it.' }))).toBeLessThanOrEqual(90);
  });

  it('is at most 90 words after a save, with what the model already said', () => {
    expect(words(buildActionNote(midCall(), { alreadySaid: 'Got it, Mike.' }))).toBeLessThanOrEqual(90);
    expect(words(buildActionNote(midCall(), { alreadySaid: 'Got it. What happened to the car?' }))).toBeLessThanOrEqual(90);
  });
});

describe('the note after a stopped reply', () => {
  const plan = () => determineNextAction(initialContext({ customerPhone: '+18174098408', serviceType: 'tow', location: 'I-95' }));

  it('says the caller heard nothing only when nothing was heard, then gives the required action and its ask', () => {
    const note = redirectNote('callback_number', plan());
    expect(note).toContain('stopped before the caller heard it: the callback number has to wait');
    expect(note.split('\n').slice(1)).toEqual([`REQUIRED ACTION: ${plan().action}`, plan().ask]);
  });

  it('says a settled topic is settled, not "to wait", and gives the read-back word for word', () => {
    const ctx = {
      ...initialContext({ customerPhone: '+18174098408', serviceType: 'tow', location: 'I-95 near exit 42', vehicleType: 'car', vehicleCondition: 'flat tire', vehicleMovable: false, customerName: 'Ali' }),
      phoneConfirmed: true,
    };
    const plan = determineNextAction(ctx);
    expect(plan.action).toBe('CONFIRM_DETAILS');
    const note = redirectNote('callback_number', plan, 'Is the number');
    expect(note).toContain('the callback number is already settled, so do not ask about it again');
    expect(note).not.toContain('has to wait');
    expect(lastLine(note)).toBe(`To read the details back, say exactly: "${renderReadBack(plan.summary!)}"`);
  });

  it('names what is wrong with the vehicle in words, when it has to wait', () => {
    expect(redirectNote('condition', plan())).toContain('what is wrong with the vehicle has to wait');
    expect(buildActionNote(state())).toContain('what is wrong with the vehicle');
  });

  it('says what the caller heard when they heard some of it', () => {
    const note = redirectNote('callback_number', plan(), 'Is this the best');
    expect(note).toContain('The caller heard you begin "Is this the best"');
    expect(note).toContain("Don't finish that question.");
    expect(note).not.toContain('before the caller heard it');
  });
});

describe("the instructions sent with a reply to the caller's words", () => {
  it('quote the words, say what to do, and give the next question, for a line that needs a reply', () => {
    // The real call (07fd8ed3): "How's your day going?" four times; the note said to answer first; three replies were the next question.
    const text = replyInstructions(state(), { text: "How's your day going?", kind: 'small_talk' })!;
    expect(text).toContain(`The caller just said: "How's your day going?"`);
    expect(text).toContain("That's small talk");
    expect(text).toContain(`The next thing: ${state().ask}`);
    expect(text.split(/\n/).at(-1)).toContain('Start your reply with your answer');
  });

  it('ask only for the rest of a sentence that was cut off', () => {
    const text = replyInstructions(state(), { text: 'Okay, so what happens if we try to', kind: 'unfinished' })!;
    expect(text).toContain('Sorry, try to what?');
    expect(text).not.toContain('The next thing');
  });

  it('are not sent for a detail, an acknowledgement, or when a word-for-word line follows', () => {
    expect(replyInstructions(state(), { text: "I'm at exit 42.", kind: 'detail' })).toBeNull();
    expect(replyInstructions(state(), { text: 'Okay.', kind: 'backchannel' })).toBeNull();
    expect(replyInstructions({ ...state(), nextAction: 'CONFIRM_DETAILS' }, { text: 'How long will it take?', kind: 'question' })).toBeNull();
  });
});
