import { describe, expect, it } from 'vitest';

import type { CallerMove, PendingQuestion, ServiceChoice } from './judgment.interface';
import { RulesJudge } from './rules.judge';
import {
  ANSWERED_FLOOR,
  CONFIRMATION_FLOOR,
  CORRECTION_FLOOR,
  MOVE_CONFIDENCE_FLOOR,
  OVERLAP_ACKNOWLEDGEMENT_CEILING,
  OVERLAP_ANSWER_FLOOR,
  SERVICE_CONFIDENCE_FLOOR,
} from './typesafe-questions';

const judge = new RulesJudge();

const READ_BACK: PendingQuestion = {
  kind: 'details',
  question: 'Are these details correct?',
  readBack: [{ label: 'Location', value: 'I-95, exit 42' }],
};
const NUMBER: PendingQuestion = {
  kind: 'callback_number',
  question: 'Is +18174090001, the number you are calling from, the best number to reach you?',
};

/** What the intake does with a move: only these, over the floor, are owed an answer. */
const owedAnAnswer = (move: CallerMove, confidence: number) =>
  confidence >= MOVE_CONFIDENCE_FLOOR && (move === 'question' || move === 'complaint' || move === 'line_check');

describe('RulesJudge', () => {
  describe('what the caller is doing', () => {
    // The caller lines of the real calls 6d1304af and ba50602f.
    const LINES: Array<[string, CallerMove, boolean]> = [
      ['Are you there?', 'line_check', true],
      ['Hello? Can you hear me?', 'line_check', true],
      ['I asked you something else.', 'complaint', true],
      ['Why do you keep cutting me off?', 'complaint', true],
      ['What kind of information have I already given you?', 'question', true],
      ['Can you help me?', 'question', true],
      ["How's the weather today?", 'question', true],
      ["It's not moving?", 'request', false],
      ["I'm at exit 42.", 'request', false],
      ['Okay.', 'other', false],
      ['Hold on, let me find the exit.', 'other', false],
      ['Okay, so what happens if we try to', 'other', false],
    ];

    it.each(LINES)('%j is %s', async (said, move, owed) => {
      const judged = await judge.judgeSpeech(said, {});
      expect(judged?.move).toMatchObject({ text: said, callerTurn: -1, move });
      expect(owedAnAnswer(judged!.move!.move, judged!.move!.confidence)).toBe(owed);
    });

    it('notes a question about the arrival time or the price, for the lead', async () => {
      expect((await judge.judgeSpeech('How long will it take?', {}))?.move?.topic).toBe('eta');
      expect((await judge.judgeSpeech("What's this going to cost me?", {}))?.move?.topic).toBe('price');
      expect((await judge.judgeSpeech('Who am I talking to?', {}))?.move?.topic).toBe('other');
      expect((await judge.judgeSpeech("I'm at exit 42.", {}))?.move?.topic).toBeUndefined();
    });

    it('judges no danger and no urgency: the rules in risk.ts read those from the same line', async () => {
      const judged = await judge.judgeSpeech("We crashed and my friend is bleeding, it's an emergency", { serviceMissing: true });
      expect(judged?.risk).toBeUndefined();
    });
  });

  describe('a yes or no to the question pending', () => {
    const isConfirmation = (c: { confirms: number; corrects: number }) => c.confirms >= CONFIRMATION_FLOOR && c.corrects < CORRECTION_FLOOR;
    const isCorrection = (c: { confirms: number; corrects: number }) => c.corrects >= CORRECTION_FLOOR;

    const CLEAR_YES = ['Yes.', 'Yeah.', 'Yep.', 'Correct.', "That's right.", "Yes, that's all correct.", 'It is.', 'Yeah it is', "Okay, yes, that's my number.", 'Sounds good.'];
    const CLEAR_NO = ['No.', 'Nope.', "That's wrong.", "No, that's not my number.", "No, it's 555 0199.", "It's not.", 'It is not my number.'];
    const NEITHER = ['Yes, but how long will it take?', 'Yeah, what happens next?'];
    const NOT_JUDGED = ['Okay.', 'Uh-huh.', 'Hello?', 'I think so.', 'No problem.', "No, no, that's right.", "Yes, it's a Honda Civic.", "I'm at exit 42."];

    it.each(CLEAR_YES)('%j confirms', async (said) => {
      for (const pending of [READ_BACK, NUMBER]) {
        const confirmation = (await judge.judgeSpeech(said, { pending }))?.confirmation;
        expect(confirmation).toMatchObject({ text: said, callerTurn: -1 });
        expect(isConfirmation(confirmation!), said).toBe(true);
      }
    });

    it.each(CLEAR_NO)('%j corrects', async (said) => {
      const confirmation = (await judge.judgeSpeech(said, { pending: NUMBER }))?.confirmation;
      expect(isConfirmation(confirmation!), said).toBe(false);
      expect(isCorrection(confirmation!), said).toBe(true);
    });

    it.each(NEITHER)('%j neither confirms nor corrects', async (said) => {
      const confirmation = (await judge.judgeSpeech(said, { pending: READ_BACK }))?.confirmation;
      expect(isConfirmation(confirmation!), said).toBe(false);
      expect(isCorrection(confirmation!), said).toBe(false);
    });

    // A judgment would refuse the model's own reading; where the words do not say, it is left to the model.
    it.each(NOT_JUDGED)('%j is left to the model', async (said) => {
      expect((await judge.judgeSpeech(said, { pending: READ_BACK }))?.confirmation).toBeUndefined();
    });

    it('is only asked while a question is pending, as Jev is', async () => {
      expect((await judge.judgeSpeech('Yes.', {}))?.confirmation).toBeUndefined();
    });
  });

  describe('the help a described problem calls for', () => {
    const service = async (said: string) => (await judge.judgeSpeech(said, { serviceMissing: true }))?.service;
    const saved = (judged: { service: ServiceChoice; confidence: number } | undefined) =>
      judged !== undefined && judged.service !== 'unclear' && judged.confidence >= SERVICE_CONFIDENCE_FLOOR ? judged.service : null;

    const SURE: Array<[string, ServiceChoice]> = [
      ["It's not moving?", 'tow'],
      ["It's stuck, it won't move", 'tow'],
      ['The car broke down on the highway', 'tow'],
      ['It needs to be towed', 'tow'],
      ['I got a flat tire', 'flat_tire'],
      ['I had a blowout', 'flat_tire'],
      ['I locked my keys in the car', 'lockout'],
      ["I'm locked out of my car", 'lockout'],
      ['I ran out of gas', 'fuel_delivery'],
      ['The battery is dead', 'jump_start'],
      ["It won't start, I think the battery's dead", 'jump_start'],
      ['I need a jump start', 'jump_start'],
    ];

    it.each(SURE)('%j is %s, sure enough to save', async (said, kind) => {
      const judged = await service(said);
      expect(judged).toMatchObject({ text: said, service: kind });
      expect(saved(judged)).toBe(kind);
    });

    it('offers two kinds of help for words that fit both, without saving either', async () => {
      for (const said of ["My car won't start", "It's dead", 'It stalled on me']) {
        const judged = await service(said);
        expect(saved(judged), said).toBeNull();
        expect(judged?.alternatives, said).toEqual(['tow', 'jump_start']);
      }
      expect((await service("I'm stuck in a ditch"))?.alternatives).toEqual(['winch_out', 'tow']);
    });

    it('reads nothing into a problem the caller says they do not have', async () => {
      expect(await service("It's not a flat tire")).toBeUndefined();
      expect(await service("I'm not out of gas")).toBeUndefined();
    });

    it('says nothing when the words name no problem, or when the help is already saved', async () => {
      expect(await service('Hello?')).toBeUndefined();
      expect((await judge.judgeSpeech("It's not moving?", {}))?.service).toBeUndefined();
    });
  });

  describe('words said over the receptionist', () => {
    const answers = async (said: string, receptionist = 'So that is a Honda Civic at exit 12.') =>
      (await judge.judgeOverlap(said, receptionist))!.overlap!.answers;

    it('answers a detail, or a no', async () => {
      expect(await answers('Exit 12.')).toBeGreaterThanOrEqual(OVERLAP_ANSWER_FLOOR);
      expect(await answers('No, exit 14.')).toBeGreaterThanOrEqual(OVERLAP_ANSWER_FLOOR);
      expect(await answers('No.', 'Is that the best number to reach you?')).toBeGreaterThanOrEqual(OVERLAP_ANSWER_FLOOR);
    });

    it('leaves alone a sound of listening or a check of the line', async () => {
      for (const said of ['Okay.', 'Uh-huh.', 'Got it, thanks.', 'Hello?', 'Are you there?']) {
        expect(await answers(said), said).toBeLessThanOrEqual(OVERLAP_ACKNOWLEDGEMENT_CEILING);
      }
    });

    it('leaves a "yes" after a question to the word lists, which may take it for the answer', async () => {
      const after = await answers('Yes.', 'Is that the best number to reach you?');
      expect(after).toBeGreaterThan(OVERLAP_ACKNOWLEDGEMENT_CEILING);
      expect(after).toBeLessThan(OVERLAP_ANSWER_FLOOR);
    });
  });

  describe('whether a reply answered the caller', () => {
    const answered = async (said: string, reply: string) => (await judge.judgeReply(said, reply))!.reply!.answered >= ANSWERED_FLOOR;

    it('keeps the line and the reply it was given', async () => {
      expect(await judge.judgeReply('Are you there?', 'Yes, I am here.')).toEqual({
        reply: { text: 'Are you there?', reply: 'Yes, I am here.', answered: expect.any(Number) },
      });
    });

    it('takes an apology for a complaint, and a reply that does not go straight to the next question', async () => {
      expect(await answered('I asked you something else.', "Sorry, you're right. Go ahead, I'm listening.")).toBe(true);
      expect(await answered('What kind of information have I already given you?', "So far I've got your number and that it's a Honda.")).toBe(true);
      expect(await answered('Are you there?', "Yes, I'm here. Where are you right now?")).toBe(true);
      expect(
        await answered('How long will it take?', "I don't have an ETA from here, but the team will call you with one as soon as they've got it. Where are you right now?"),
      ).toBe(true);
    });

    it('catches a reply that went straight past the caller', async () => {
      expect(await answered('Are you there?', 'Where are you right now?')).toBe(false);
      expect(await answered('I asked you something else.', 'What kind of vehicle is it?')).toBe(false);
      expect(await answered('What kind of information have I already given you?', 'Got it. Where is the vehicle right now?')).toBe(false);
      expect(await answered('How much will it cost?', 'Okay, and what is your name?')).toBe(false);
      // Only filling time: the answer, if any, comes in the next part of the reply.
      expect(await answered('How long will it take?', 'Mm-hmm. Let me check.')).toBe(false);
    });
  });

  it('leaves a location and the help as saved to the intake rules', async () => {
    expect(await judge.judgeLocation()).toBeNull();
    expect(await judge.judgeService()).toBeNull();
  });
});
