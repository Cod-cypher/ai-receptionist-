import { describe, expect, it } from 'vitest';

import { initialContext, type ConversationContext } from '../../../conversation/types';
import { emptyUsage } from '../usage';
import { EVAL_CALLER, heardReplies, type RunRecord } from './harness';
import { SCENARIOS, type Scenario, type TurnExpectation } from './scenarios';
import { OVERLONG_WORDS, scoreRun, startsWithAck, type Failure, type FailureCategory } from './score';

interface TurnSketch {
  caller: string;
  replies: string[];
  /** Values saved on this turn, on top of everything saved before. */
  saved?: Record<string, unknown>;
}

/** A run as the harness records it: each caller line, what the receptionist said, and what was saved by then. */
function runOf(turns: TurnSketch[]): RunRecord {
  let values: Record<string, unknown> = { customerPhone: EVAL_CALLER };
  const records = turns.map((turn) => {
    values = { ...values, ...turn.saved };
    const stateAfter = { ...initialContext(), values: { ...values } } as ConversationContext;
    return { caller: turn.caller, replies: turn.replies, stateAfter };
  });
  return {
    turns: records,
    ops: [],
    events: [],
    finalContext: records.at(-1)?.stateAfter ?? initialContext({ customerPhone: EVAL_CALLER }),
    leadCreatedAtTurn: null,
    usage: emptyUsage(),
    errors: [],
    rateLimited: false,
    durationMs: 0,
    replyLatencyMs: [],
    endpointMs: [],
    lastWordToReplyMs: [],
  };
}

function scenarioOf(turns: TurnSketch[], expectations: TurnExpectation[] = []): Scenario {
  return { name: 'test', group: 'conversation', targeted: true, what: 'test', lines: turns.map((t) => t.caller), turns: expectations };
}

const named = (name: string) => {
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error(`no scenario ${name}`);
  return scenario;
};

/** A scenario's caller lines with these replies; a turn not given one gets a plain question. */
const playScenario = (scenario: Scenario, replies: Record<number, string>) =>
  runOf(scenario.lines.map((caller, i) => ({ caller, replies: [replies[i + 1] ?? 'Okay. Where are you right now?'] })));

const only = (failures: Failure[], category: FailureCategory) => failures.filter((f) => f.category === category);

/** The dash a transcript writes between two clauses. */
const DASH = String.fromCharCode(0x2014);

describe('IGNORED_CALLER', () => {
  // The replies of the real call of 12 October 2026 (6d1304af), word for word.
  it.each([
    ['cut-off-mid-sentence', 2, 'Where is the vehicle right now?'],
    ['complaint-asked-something-else', 3, 'Could you describe the location? For example, near an exit, off a street, or a mile marker?'],
    ['meta-what-do-you-have', 2, "Right. Sorry, I'm listening. Could you tell me the exact location, like the nearest exit or cross street?"],
    ['meta-what-do-you-have', 2, 'Could you tell me what kind of vehicle it is?'],
    ['capable-of-helping', 1, 'What kind of help do you need right now?'],
    // Not one of the call's replies: "I can't" must not pass for a yes, however the apostrophe is written.
    ['capable-of-helping', 1, `I can${String.fromCharCode(0x2019)}t say from here. What's going on with the car?`],
  ])('fails %s when turn %i got "%s", as on the 12 October call', (name, turn, reply) => {
    const failures = scoreRun(named(name), playScenario(named(name), { [turn]: reply }));
    expect(only(failures, 'IGNORED_CALLER')).not.toHaveLength(0);
  });

  it.each([
    ['cut-off-mid-sentence', { 2: 'Sorry, try to what?' }],
    ['cut-off-mid-sentence', { 2: "Sorry, I didn't catch the end of that. Go on?" }],
    ['complaint-asked-something-else', { 2: "I'm not sure about cards, the team can tell you. Where are you right now?", 3: "Sorry about that, I'm listening. What did you want to know?" }],
    ['meta-what-do-you-have', { 2: "So far just that you need a tow, and the number you're calling from. Where are you right now?" }],
    ['capable-of-helping', { 1: "Yes, I can. What's going on with the car?" }],
    ['small-talk-then-detail', { 1: "Good, thanks! What's going on with the car?" }],
    [
      'two-questions-in-a-row',
      {
        2: "I can't quote a price from here. The team will confirm it with you before anything's done. Where are you right now?",
        3: "No exact time from here, but the team will call you with an ETA. What's the nearest exit or cross street?",
      },
    ],
  ])('passes %s answered the way a person would', (name, replies) => {
    const failures = scoreRun(named(name), playScenario(named(name), replies));
    expect(only(failures, 'IGNORED_CALLER')).toEqual([]);
  });

  const asked = { caller: 'What kind of information have I already given you?', replies: [] as string[] };
  const expectTow: TurnExpectation[] = [{ turn: 1, needsReply: /\btow\b(?!\s+truck)/i }];

  it('fails an answer given only after the next question', () => {
    const turns = [{ ...asked, replies: ['Where are you right now? So far you need a tow.'] }];
    expect(only(scoreRun(scenarioOf(turns, expectTow), runOf(turns)), 'IGNORED_CALLER')).toHaveLength(1);
  });

  it('fails a word that only appears inside the next question', () => {
    const turns = [{ ...asked, replies: ['Where should we send the tow?'] }];
    expect(only(scoreRun(scenarioOf(turns, expectTow), runOf(turns)), 'IGNORED_CALLER')).toHaveLength(1);
  });

  it('fails a turn with no reply at all', () => {
    const turns = [{ ...asked, replies: [] }];
    expect(only(scoreRun(scenarioOf(turns, expectTow), runOf(turns)), 'IGNORED_CALLER')).toHaveLength(1);
  });

  it.each(["Sorry about that, I'm listening, where are you right now?", `Sorry about that ${DASH} where are you right now?`, `Sorry${DASH}where are you right now?`])(
    'counts an apology as first when it shares a sentence with the question: "%s"',
    (reply) => {
      const turns = [{ caller: 'I asked you something else.', replies: [reply] }];
      const failures = scoreRun(scenarioOf(turns, [{ turn: 1, needsReply: /\bsorry\b/i }]), runOf(turns));
      expect(only(failures, 'IGNORED_CALLER')).toEqual([]);
    },
  );

  it('fails a caller cut off mid-sentence who is asked anything on the intake list', () => {
    const turns = [{ caller: 'Okay, so what happens if we try to', replies: ['Sorry, you got cut off there. Where are you right now?'] }];
    const failures = scoreRun(scenarioOf(turns, [{ turn: 1, needsReply: /cut off/i, noIntakeQuestion: true }]), runOf(turns));
    expect(only(failures, 'IGNORED_CALLER').map((f) => f.detail)).toEqual([expect.stringContaining('asked about location instead of replying')]);
  });
});

describe('ROBOTIC_PHRASING', () => {
  it.each([
    // The 12 October call.
    'Sure. What kind of help do you need right now?',
    'Could you describe the location? For example, near an exit, off a street, or a mile marker?',
    'Could you tell me what kind of vehicle it is?',
    'Please provide your full name.',
    "I'm unable to give a price at this time.",
    'In order to send someone, I need the address.',
  ])('flags "%s"', (reply) => {
    const turns = [{ caller: 'I need a tow.', replies: [reply] }];
    expect(only(scoreRun(scenarioOf(turns), runOf(turns)), 'ROBOTIC_PHRASING')).toHaveLength(1);
  });

  it.each(["What's going on with the car?", 'Where are you right now?', 'What kind of car is it?', 'And who am I speaking with?'])(
    'leaves "%s" alone',
    (reply) => {
      const turns = [{ caller: 'I need a tow.', replies: [reply] }];
      expect(only(scoreRun(scenarioOf(turns), runOf(turns)), 'ROBOTIC_PHRASING')).toEqual([]);
    },
  );
});

describe('REPEATED_OPENER', () => {
  const twoTurns = (first: string, second: string) => [
    { caller: 'I need a tow.', replies: [first] },
    { caller: "It's a Honda Civic.", replies: [second] },
  ];
  const openers = (turns: TurnSketch[]) => only(scoreRun(scenarioOf(turns), runOf(turns)), 'REPEATED_OPENER');

  it('flags two replies in a row that start with the same two words', () => {
    expect(openers(twoTurns('Got it. Where are you right now?', 'Got it. What kind of car is it?'))).toHaveLength(1);
  });

  it('ignores case and punctuation', () => {
    expect(openers(twoTurns(`got it ${DASH} where are you right now?`, 'Got it! What kind of car is it?'))).toHaveLength(1);
  });

  it.each([
    ['Okay, where are you right now?', 'Okay, what kind of car is it?'],
    ['Mm-hm. Where are you right now?', 'Mm-hm. What kind of car is it?'],
    ['Got it. Where are you right now?', 'Alright, what kind of car is it?'],
  ])('does not count a one-word ack followed by different words, or a different opener: "%s" then "%s"', (first, second) => {
    expect(openers(twoTurns(first, second))).toEqual([]);
  });

  it('only compares replies next to each other', () => {
    const turns = [
      { caller: 'I need a tow.', replies: ['Got it. Where are you right now?'] },
      { caller: "I'm at 123 Main Street.", replies: ['Alright, what kind of car is it?'] },
      { caller: "It's a Honda Civic.", replies: ['Got it, and who am I speaking with?'] },
    ];
    expect(openers(turns)).toEqual([]);
  });
});

describe('OVERLONG_REPLY', () => {
  const overlong = (replies: string[]) => {
    const turns = [{ caller: 'How long will it take?', replies }];
    return only(scoreRun(scenarioOf(turns), runOf(turns)), 'OVERLONG_REPLY');
  };

  it('flags a turn of more than 35 words', () => {
    const reply =
      "I can't give you a time from here, but the team will call you with an ETA as soon as they've got one, and in the meantime I just need a few more details from you, so where are you right now?";
    expect(overlong([reply])).toHaveLength(1);
  });

  it('counts every reply of the turn, as the caller hears them together', () => {
    const half = `${'word '.repeat(20).trim()}.`;
    expect(overlong([half, half])).toHaveLength(1);
  });

  it('allows exactly 35 words', () => {
    expect(overlong([`${'word '.repeat(OVERLONG_WORDS).trim()}.`])).toEqual([]);
  });

  it.each(['Did I get all that right?', 'Is that all correct?'])('leaves the read-back alone, ending "%s"', (question) => {
    const readBack =
      "Let me make sure I've got this right. Mike, you need a tow; the pickup truck is at 123 Main Street in Dallas; it can't move; " +
      `and we'll call you back on eight one seven, four zero nine, eight four zero eight. ${question}`;
    expect(overlong([readBack])).toEqual([]);
  });
});

describe('NO_ACK_AFTER_DETAIL', () => {
  const detail = { caller: "My Honda Civic won't start.", saved: { vehicleMake: 'Honda', vehicleModel: 'Civic' } };
  const noAck = (turn: TurnSketch, expectations: TurnExpectation[] = []) =>
    only(scoreRun(scenarioOf([turn], expectations), runOf([turn])), 'NO_ACK_AFTER_DETAIL');

  it('reports, without failing, a detail met with the next question and nothing else', () => {
    const found = noAck({ ...detail, replies: ['Where are you right now?'] });
    expect(found).toHaveLength(1);
    expect(found[0]!.soft).toBe(true);
  });

  it.each([
    'Okay, where are you right now?',
    'Got it. Where are you right now?',
    'A Civic, got it. Where are you right now?',
    'Oh no. Where are you right now?',
    "Sorry to hear that. Where's the car right now?",
  ])('is satisfied by "%s"', (reply) => {
    expect(noAck({ ...detail, replies: [reply] })).toEqual([]);
  });

  it('reports wordy thanks, which the prompt bans', () => {
    expect(noAck({ ...detail, replies: ['Thank you for that information. Where are you right now?'] })).toHaveLength(1);
  });

  it('leaves a turn alone when nothing new was saved', () => {
    expect(noAck({ caller: 'How does this work?', replies: ['Where are you right now?'] })).toEqual([]);
  });

  it('fails, not just reports, where the scenario requires the ack', () => {
    const found = noAck({ ...detail, replies: ['Where are you right now?'] }, [{ turn: 1, startsWithAck: true }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.soft).toBeUndefined();
  });

  it.each([
    ['Okay.', 'I need a tow.', true],
    ['Alright so where are you right now?', 'I need a tow.', true],
    ['Exit 42, got it.', "I'm at exit 42 on I-95.", true],
    ['Your Civic. Where is it?', "My Honda Civic won't start.", true],
    ['An 18-wheeler, got it.', 'My 18-wheeler needs a tow.', true],
    [`Got it${DASH}where are you right now?`, 'I need a tow.', true],
    [`I${String.fromCharCode(0x2019)}m sorry to hear that. Where are you?`, 'My car broke down.', true],
    ['Where are you right now?', 'I need a tow.', false],
    ['Right now, where are you?', 'I need a tow.', false],
    ['The car, where is it?', 'I need a tow.', false],
  ])('startsWithAck("%s") after "%s" is %s', (reply, caller, expected) => {
    expect(startsWithAck(reply, caller)).toBe(expected);
  });
});

describe('the older categories', () => {
  it('still scores a repeated sentence and two questions in one turn', () => {
    const turns = [
      { caller: 'I need a tow.', replies: ['Okay. Where is the car right now?'] },
      { caller: 'Hold on.', replies: ['Sure. Where is the car right now? And who am I speaking with?'] },
    ];
    const categories = scoreRun(scenarioOf(turns), runOf(turns)).map((f) => f.category);
    expect(categories).toEqual(expect.arrayContaining(['REPEATED_REPLY', 'MULTIPLE_QUESTIONS']));
  });
});

describe('the conversation scenarios', () => {
  const conversation = SCENARIOS.filter((s) => s.group === 'conversation');

  it('are targeted, and each checks how a reply treats the caller', () => {
    expect(conversation.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'meta-what-do-you-have',
        'cut-off-mid-sentence',
        'complaint-asked-something-else',
        'capable-of-helping',
        'ack-then-ask',
        'small-talk-then-detail',
        'two-questions-in-a-row',
      ]),
    );
    for (const scenario of conversation) {
      expect(scenario.targeted).toBe(true);
      expect(scenario.turns?.some((t) => t.needsReply || t.startsWithAck)).toBe(true);
      for (const turn of scenario.turns ?? []) expect(turn.turn).toBeLessThanOrEqual(scenario.lines.length);
    }
  });
});

describe('heardReplies', () => {
  it('keeps what the caller heard: a dropped reply is left out, a stopped one is cut to what played, fillers and the greeting are not replies', () => {
    const events = [
      { type: 'AI_RESPONSE', turn: 1, payload: { text: 'Sorry, try to what?', stopped: 'stale' } },
      { type: 'AI_RESPONSE', turn: 1, payload: { text: 'Okay.', filler: true } },
      { type: 'AI_RESPONSE', turn: 1, payload: { text: 'Got it. What happened with the car?', stopped: 'redirected', heard: 'Got it. What happ' } },
      { type: 'AI_RESPONSE', turn: 1, payload: { text: 'Sorry, try to what?', stopped: null } },
      { type: 'AI_RESPONSE', turn: 0, payload: { text: 'Thanks for calling.', greeting: true } },
      { type: 'AI_RESPONSE', turn: 2, payload: { text: 'Where are you?', stopped: null } },
    ];
    expect(heardReplies(events, 1)).toEqual(['Got it. What happ', 'Sorry, try to what?']);
    expect(heardReplies(events, 2)).toEqual(['Where are you?']);
  });

  it('counts the recorded ack for a silent save as part of the reply: the model is told it was said and says no other', () => {
    const events = [
      { type: 'AI_RESPONSE', turn: 1, payload: { text: 'Got it.', filler: true, ack: true } },
      { type: 'AI_RESPONSE', turn: 1, payload: { text: 'Where are you right now?', stopped: null } },
    ];
    expect(heardReplies(events, 1)).toEqual(['Got it.', 'Where are you right now?']);
  });
});

describe('STOPPED_REPLY', () => {
  it('notes, without failing the run, a reply the gateway had to stop', () => {
    const turn = { caller: 'I need a tow for my car.', replies: ['Where are you right now?'] };
    const run = runOf([turn]);
    run.events.push({ type: 'AI_RESPONSE', turn: 1, payload: { text: 'Got it. What happened with the car?', stopped: 'redirected', heard: 'Got it.' } });
    const stopped = scoreRun(scenarioOf([turn]), run).filter((f) => f.category === 'STOPPED_REPLY');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.soft).toBe(true);
    expect(stopped[0]?.detail).toContain('redirected');
  });
});
