import { describe, expect, it } from 'vitest';

import { type CallerWordsKind, NEEDS_REPLY, type YesNo, classifyCallerWords, isBackchannel, isHesitation, readYesNo } from './caller-words';

describe('isHesitation', () => {
  it('recognises a sound of thinking with no word in it', () => {
    // The real call 09ba2f2a: "Um", then "5532" as a turn of its own.
    for (const said of ['Um', 'um...', 'Uh.', 'Umm, uh', 'Hmm.', 'Er', 'erm', 'Ah.', 'Uhh -']) {
      expect(isHesitation(said), said).toBe(true);
    }
  });

  it('leaves anything with a word or a question in it to be answered', () => {
    for (const said of ['Um, 5532', 'Uh, I think it is a Honda', 'Hm?', 'Ah?', 'Okay.', 'Mm-hm.', 'Yes', 'Umbrella', '']) {
      expect(isHesitation(said), said).toBe(false);
    }
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

  it('answers at once on a long hum', () => {
    // Without a word boundary after each word, "mm+" could split a hum every
    // possible way: 28 m's took 58 ms, and each extra m doubled it.
    const started = performance.now();
    expect(isBackchannel(`${'m'.repeat(200)}, it's a Ford`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

/** Every caller line of the 12 Oct call (6d1304af): the caller never gave a detail and probed the bot. */
const REAL_CALL: Array<[string, CallerWordsKind]> = [
  ['Can you help me?', 'question'],
  // The "No" answers nothing: it is followed by "but" and a question.
  ['No, but are you capable of helping me with my issues?', 'question'],
  ["How's the weather today?", 'small_talk'],
  // Cut off by the turn detector, and answered with "Where is the vehicle right now?".
  ['Okay, so what happens if we try to', 'unfinished'],
  // As the transcriber wrote it on a live check: the mark does not finish the sentence.
  ['Okay, so what happens if we try to?', 'unfinished'],
  ['Okay, so what happens if we try to.', 'unfinished'],
  ['Who am I talking to?', 'question'],
  ['Is that what you were talking about?', 'question'],
  ['I asked you something else.', 'complaint'],
  ['What kind of information have I already given you?', 'question'],
  ['Now, what kind of information have I already given you?', 'question'],
];

const DETAILS: Array<[string, CallerWordsKind]> = [
  // A detail wins even when the line also asks something: the save must not be blocked.
  ["I'm at exit 42, how long will it take?", 'detail'],
  ['My Civic died at 5th and Main', 'detail'],
  ["It's a Honda", 'detail'],
  ['I need a tow', 'detail'],
  ['My name is Mike.', 'detail'],
  ['This is Sarah.', 'detail'],
  ["My husband's name is Ali, can you call him?", 'detail'],
  ["I'm on the highway", 'detail'],
  ['Exit forty two', 'detail'],
  ['five five five one two three four', 'detail'],
  ["It's a pickup.", 'detail'],
  ['A Ram.', 'detail'],
  ['Can you tow a Mehran?', 'detail'],
  ['Do you guys do jump starts?', 'detail'],
  ['Do you go as far as Lahore?', 'detail'],
  ['Can you hurry, there are kids in the car?', 'detail'],
  ['Could you call me on my cell instead?', 'detail'],
  ["What if I'm in the city center?", 'detail'],
  ['The cross street is Elm.', 'detail'],
  ["Hold on, I'm at the Walmart.", 'detail'],
  ["Let me see, I think it's exit 12.", 'detail'],
  ['What is your price for a tow?', 'detail'],
  // A name or a place said back as a question would otherwise be sent with no tool.
  ['Dallas?', 'detail'],
  ['Mike Johnson.', 'detail'],
  // The eval scenarios' caller lines.
  ['I need a tow. My name is Mike and my semi truck broke down on I-95.', 'detail'],
  ["I need a tow for my pickup truck. It's on Highway 10 and I want it taken to Joe's Garage.", 'detail'],
  ['I need a tow, my box truck broke down on the interstate.', 'detail'],
  ['I need a jump start for my SUV in the Walmart parking lot on Preston Road.', 'detail'],
  ["I was in an accident at Main Street and Elm, the car's smashed up.", 'detail'],
  ['Hi, I broke down.', 'detail'],
  ["Yes, I'm safe.", 'detail'],
  ['Yes, this number is the best one.', 'detail'],
];

const YES_AND_NO: Array<[string, CallerWordsKind]> = [
  // A bare "No." answers the pending question; a bare "Yes." takes the model's normal path.
  ['No.', 'detail'],
  ["No, that's not my number.", 'detail'],
  ['Nope.', 'detail'],
  ['Yeah it is', 'detail'],
  ['Correct.', 'detail'],
  ["That's right.", 'detail'],
  ["That's wrong.", 'detail'],
  ["Yes, that's all correct.", 'detail'],
  ['I said no.', 'detail'],
  ['Yes.', 'backchannel'],
  ['Okay.', 'backchannel'],
  ['Yes, please.', 'backchannel'],
  ['Mm-hmm.', 'backchannel'],
  ['Thank you so much.', 'backchannel'],
  ['Okay, thank you so much.', 'backchannel'],
  ['No problem.', 'backchannel'],
  ['Okay then', 'backchannel'],
  ['Yes, but how long will it take?', 'question'],
  ['No, I asked you something else.', 'complaint'],
];

const NO_DETAIL: Array<[string, CallerWordsKind]> = [
  ['Hold on, let me find the exit.', 'asking_for_time'],
  ['Hold on, let me check the cross street.', 'asking_for_time'],
  ['Let me look at the sign.', 'asking_for_time'],
  ["One sec, I'm checking the mile marker.", 'asking_for_time'],
  ['Hold on, let me find my keys.', 'asking_for_time'],
  ["Sorry, one second, my kid is talking to me. Okay, I'm back.", 'asking_for_time'],
  ['Hello? Can you hear me?', 'line_check'],
  ['Hello?', 'line_check'],
  ['Hello, can you hear me okay?', 'line_check'],
  ['Are you still there?', 'line_check'],
  // A complaint beats a question.
  ['Why do you keep cutting me off?', 'complaint'],
  ['You already asked me that.', 'complaint'],
  ["You're not listening.", 'complaint'],
  ["That's not what I asked.", 'complaint'],
  ['Let me finish.', 'complaint'],
  ['Are you a real person?', 'small_talk'],
  ['Am I talking to a robot?', 'small_talk'],
  ['Hi, how are you doing today?', 'small_talk'],
  // Real call fe228d39: met with "What's going on with the car?".
  ['How are you doing this day?', 'small_talk'],
  ['Good morning.', 'small_talk'],
  ['How soon can you get someone here?', 'question'],
  ['How much is this going to cost me?', 'question'],
  // The tow truck already coming is not a request for one.
  ['When will the tow truck get here?', 'question'],
  ['How long will the tow take?', 'question'],
  ["Is this Joe's Towing?", 'question'],
  ['Is this a towing company?', 'question'],
  ['Is it a flat rate?', 'question'],
  ['Is twenty minutes okay?', 'question'],
  ["I don't understand.", 'question'],
  ['Can I talk to a real person?', 'question'],
  ['Wait, what?', 'question'],
  ['Really?', 'question'],
  ['', 'unknown'],
  ["I'm not sure.", 'unknown'],
  ["I'll call you", 'unknown'],
];

/** Transcripts often lack the full stop: only a line that ends on a word no sentence ends on is unfinished. */
const UNFINISHED: Array<[string, CallerWordsKind]> = [
  ['the car is', 'unfinished'],
  ["Alright, I'll", 'unfinished'],
  ['The car is a', 'unfinished'],
  ['I was wondering if', 'unfinished'],
  ["I'm calling about", 'unfinished'],
  ['I need help with', 'unfinished'],
  ['What happens if the car is', 'unfinished'],
  ['Can you', 'unfinished'],
  ['What do you', 'unfinished'],
  ["I'm on", 'unfinished'],
  ['I think that', 'unfinished'],
  ['and then', 'unfinished'],
  ['So,', 'unfinished'],
  ['Um', 'unfinished'],
  ['can you help me', 'question'],
  ['who am I talking to', 'question'],
  ['Who am I speaking with', 'question'],
  ['Where are they', 'question'],
  ["What's going on", 'question'],
  ["I don't know where I am", 'unknown'],
  ['There it is', 'unknown'],
  ['Come on', 'unknown'],
  ['I know that', 'unknown'],
];

describe('classifyCallerWords', () => {
  it.each(REAL_CALL)('the 12 Oct call: %j is %s', (said, kind) => {
    expect(classifyCallerWords(said)).toBe(kind);
  });

  it.each(DETAILS)('%j is %s', (said, kind) => {
    expect(classifyCallerWords(said)).toBe(kind);
  });

  it.each(YES_AND_NO)('%j is %s', (said, kind) => {
    expect(classifyCallerWords(said)).toBe(kind);
  });

  it.each(NO_DETAIL)('%j is %s', (said, kind) => {
    expect(classifyCallerWords(said)).toBe(kind);
  });

  it.each(UNFINISHED)('%j is %s', (said, kind) => {
    expect(classifyCallerWords(said)).toBe(kind);
  });

  it('reads curly apostrophes and extra spaces as plain ones', () => {
    expect(classifyCallerWords('  It’s   a Honda ')).toBe('detail');
    expect(classifyCallerWords('Alright,  I’ll')).toBe('unfinished');
  });

  // The gateway sends a reply to a needs-reply line with `toolChoice: 'none'`;
  // a detail in such a line would not be saved on that turn.
  describe('a line that carries a detail is always a detail', () => {
    const needsReply = [...REAL_CALL, ...NO_DETAIL, ...UNFINISHED, ...YES_AND_NO].filter(([, kind]) => NEEDS_REPLY.includes(kind));
    const fragments = [
      "I'm at exit 42.",
      'My Civic died at 5th and Main.',
      "It's a Honda.",
      'I need a tow.',
      'My name is Mike.',
      "It won't start.",
      'My number is 555 0134.',
      "I'm on the highway.",
      'The battery is dead.',
      "It's a pickup truck.",
      'Take it to my mechanic.',
      "We're at the Walmart on Preston Road.",
      'Mile marker one eighteen.',
      "No, that's not my number.",
    ];

    it('covers every kind that needs a reply', () => {
      expect(new Set(needsReply.map(([, kind]) => kind))).toEqual(new Set(NEEDS_REPLY));
    });

    it.each(fragments)('with %j, before or after any needs-reply line', (detail) => {
      for (const [said] of needsReply) {
        expect(classifyCallerWords(`${said} ${detail}`), `${said} ${detail}`).toBe('detail');
        expect(classifyCallerWords(`${detail} ${said}`), `${detail} ${said}`).toBe('detail');
      }
    });
  });

  it('is cheap enough to run on every caller turn', () => {
    const lines = [...REAL_CALL, ...DETAILS, ...YES_AND_NO, ...NO_DETAIL, ...UNFINISHED].map(([said]) => said);
    const started = performance.now();
    for (let i = 0; i < 100; i++) for (const said of lines) classifyCallerWords(said);
    // About 15 microseconds a line; the bound only catches runaway backtracking.
    expect((performance.now() - started) / (100 * lines.length)).toBeLessThan(1);
    const humStarted = performance.now();
    expect(classifyCallerWords(`${'M'.repeat(200)}, no`)).toBe('detail');
    expect(performance.now() - humStarted).toBeLessThan(100);
  });
});

describe('readYesNo', () => {
  const LINES: Array<[string, YesNo | null]> = [
    ['Yes.', 'yes'],
    ['Yeah.', 'yes'],
    ['Yep, that is correct.', 'yes'],
    ["Yes, that's all correct, thank you.", 'yes'],
    ["That's right.", 'yes'],
    ["That's all correct.", 'yes'],
    ['It is.', 'yes'],
    ['Correct.', 'yes'],
    ["Okay, yes, that's my number.", 'yes'],
    ['Sounds good.', 'yes'],
    ['Perfect, thank you.', 'yes'],
    ['No.', 'no'],
    ['Nope.', 'no'],
    ["That's wrong.", 'no'],
    ["No, that's not my number.", 'no'],
    ["No, it's a Ford.", 'no'],
    ["It's not.", 'no'],
    ['It is not my number.', 'no'],
    ["I don't think so.", 'no'],
    ['Yes, but how long will it take?', 'yes_but'],
    ['Yeah, what happens next?', 'yes_but'],
    // Not plain enough for the backend to act on: left to the model.
    ['Okay.', null],
    ['Uh-huh.', null],
    ['Thank you.', null],
    ['I think so.', null],
    ['No problem.', null],
    ["No, no, that's right.", null],
    ["Yes, it's a Honda Civic.", null],
    ['Hello?', null],
    ['', null],
  ];

  it.each(LINES)('%j is %s', (said, answer) => {
    expect(readYesNo(said)).toBe(answer);
  });
});
