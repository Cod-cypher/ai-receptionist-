import { describe, expect, it } from 'vitest';
import type { SlotKey, SlotValues } from '@towai/shared';

import { ASK_PHRASINGS, determineNextAction, topicOfSlot, type NextAction, type Topic } from './next-action';
import { checkReplyAgainstAction, questionsIn } from './response-check';
import { initialContext } from './types';

const planFor = (values: SlotValues, extra = {}) =>
  determineNextAction({ ...initialContext({ customerPhone: '+18174098408', ...values }), ...extra });

const MIKE = { serviceType: 'vehicle towing', customerName: 'Mike', vehicleType: 'semi truck', vehicleCondition: 'broke down', location: 'I-95' };

/** Every topic asked about in a reply, in order. */
const topicsIn = (text: string): Topic[] => questionsIn(text).flatMap((q) => q.topics);

/**
 * The phrasings the priority engine suggests for each ask. A suggested
 * question the check does not take for its own topic is scored off-plan by
 * the eval; one taken for a later topic as well is cut off on a live call.
 */
const SUGGESTED: Array<[Topic, string[]]> = [
  ['service', ["What's going on with the car?", 'What happened?', 'So what do you need, a tow or something else?', 'Do you need a tow, or a jump start?']],
  [
    'location',
    [
      'Where are you right now?',
      "What's the nearest exit, cross street, or a business you can see?",
      'Last thing before I pass this on: any landmark near you?',
      'Where on I-95, an exit number, mile marker, or something you can see?',
      'Can you give me the nearest exit or a cross street?',
      "Where's the car?",
    ],
  ],
  ['vehicle', ['What are you driving?', 'What kind of car is it, make and model if you know it?', 'Did you say Honda Civic?']],
  [
    'condition',
    [
      "What's wrong with it?",
      "What happened to it, a flat, won't start, an accident?",
      "What's the problem with the car, roughly?",
      "One more thing: what's wrong with the car?",
      "What's the issue with the truck?",
    ],
  ],
  ['movable', ['Does it roll and steer, or is it stuck where it is?', 'Does it still start and drive, or is it dead?']],
  ['name', ['And who am I speaking with?', "What's your name?"]],
  [
    'callback_number',
    ['Is this the best number to reach you on?', 'Should we call you back on this number?', "What's the best number to call you back on?"],
  ],
  [
    'details',
    [
      'Did I get all that right?',
      // The older line, still used by older pipelines.
      'Is that all correct?',
      "Okay, let me make sure I've got this right. Mike, you need a tow; the car is at I-95, exit 42; it can't move; and we'll call you back on 8 1 7, 4 0 9, 8 4 0 8. Did I get all that right?",
    ],
  ],
];

describe('the phrasings the priority engine suggests', () => {
  it.each(SUGGESTED.flatMap(([topic, lines]) => lines.map((line) => [line, topic] as const)))('takes "%s" for a %s question and nothing else', (line, topic) => {
    expect(questionsIn(line)).toHaveLength(1);
    expect(topicsIn(line)).toEqual([topic]);
  });

  it.each([
    // Asks what help they want: only the vehicle needs towing. Once taken for movability, it was stopped twice on a call.
    ['Do you need a tow?', ['service']],
    ["What's my next move?", []],
    ['Can we move on?', []],
    // A meta-question answered from what is saved: the number is said, the car's place is asked.
    ["So far I've just got your number. Where's the car?", ['location']],
    ["So far I've just got your number, where's the car?", ['location']],
    // The read-back run on without a full stop is still one question about all of it.
    ["Mike, you need a tow; the car is at I-95, exit 42; it can't move; and we'll call you back on 8 1 7, 4 0 9, 8 4 0 8, did I get all that right?", ['details']],
    // "Is that all right?" means "is that okay?": the number question in it still counts.
    ["We'll call you back on this number, is that all right?", ['callback_number', 'details']],
    // Transcripts write a curly apostrophe.
    ['What’s going on with the car?', ['service']],
    ['Does it roll and steer, or is it stuck right where it is?', ['movable']],
    ['All right where are you?', ['location']],
    ['Did you say exit 42?', ['location']],
    ['Did you say 8 1 7, 4 0 9, 8 4 0 8?', ['callback_number']],
    ['Was that a Honda or a Hyundai?', ['vehicle']],
    // Only the vehicle itself is a vehicle check: this one asks whether it moves.
    ["Did you say the car won't start?", ['movable']],
    // Asked again while waiting for a yes to the read-back.
    ['Were those details right?', ['details']],
    ['Sound right?', ['details']],
    // Other ways of asking what help they want.
    ['Hi, Liberty Towing here. What can I do for you?', ['service']],
    ["What's wrong?", ['service']],
    ["What's the problem?", ['service']],
    // What happened to something is what is wrong with it: the condition, not the help.
    ['Got it. What exactly happened to the car?', ['condition']],
    ["What's wrong with your truck?", ['condition']],
  ] as Array<[string, Topic[]]>)('takes "%s" for %j', (line, topics) => {
    expect(topicsIn(line)).toEqual(topics);
  });

  it('asks nothing in an answer', () => {
    expect(questionsIn("The team will call you with an ETA as soon as they've got one.")).toEqual([]);
    expect(questionsIn("I can't quote a price from here. The team will confirm it with you before anything's done.")).toEqual([]);
  });
});

/** What each action asks about. CLOSE asks nothing; safety advice has no topic pattern, so it must match none. */
const TOPIC_OF_ACTION: Record<NextAction, Topic | null> = {
  HANDLE_SAFETY: 'safety',
  CLARIFY_FIELD: null,
  ASK_SERVICE_TYPE: 'service',
  ASK_LOCATION: 'location',
  ASK_LOCATION_DETAIL: 'location',
  ASK_VEHICLE: 'vehicle',
  ASK_VEHICLE_CONDITION: 'condition',
  ASK_VEHICLE_MOVABLE: 'movable',
  ASK_CUSTOMER_NAME: 'name',
  CONFIRM_CALLBACK_NUMBER: 'callback_number',
  ASK_CALLBACK_NUMBER: 'callback_number',
  CONFIRM_DETAILS: 'details',
  AWAIT_CONFIRMATION: 'details',
  CLOSE: null,
};

const TOPICS: readonly string[] = ['safety', 'service', 'location', 'vehicle', 'condition', 'movable', 'name', 'callback_number', 'details', 'destination'];

/** The topic a key asks about; undefined for a key this test does not know yet. */
function topicOfKey(key: string): Topic | null | undefined {
  const [action, qualifier] = key.split(':');
  if (action === 'CLARIFY_FIELD' && qualifier) {
    return TOPICS.includes(qualifier) ? (qualifier as Topic) : (topicOfSlot(qualifier as SlotKey) ?? undefined);
  }
  return action && action in TOPIC_OF_ACTION ? TOPIC_OF_ACTION[action as NextAction] : undefined;
}

/** {value}: the value being checked, as it is said. A bare CLARIFY_FIELD checks a field with no topic of its own. */
const SAMPLE_VALUE: Partial<Record<Topic, string>> = {
  service: 'a tow',
  location: 'I-95 near exit 42',
  vehicle: 'a Honda Civic',
  name: 'Mike',
};
/** The placeholders as `askPhrasing` fills them. */
const fill = (line: string, topic: Topic | null) =>
  line.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (name === 'offer') return 'a jump start, or a tow';
    if (name === 'road') return 'I-95';
    if (name === 'number') return '911';
    if (name === 'value') return (topic && SAMPLE_VALUE[topic]) ?? "Joe's Garage";
    return placeholder;
  });

// The engine's own table, keyed by action ("ASK_LOCATION", "ASK_VEHICLE_MOVABLE:tow",
// "CLARIFY_FIELD:movable:no"). A sample added there is checked here with no
// change to this file; a new key needs its topic in TOPIC_OF_ACTION.
describe("every phrasing in the engine's table", () => {
  it('is taken for its own topic and nothing else', () => {
    expect(Object.keys(ASK_PHRASINGS).length).toBeGreaterThan(0);
    const misses: string[] = [];
    for (const [key, lines] of Object.entries(ASK_PHRASINGS)) {
      const topic = topicOfKey(key);
      if (topic === undefined) {
        misses.push(`${key}: no topic known for this key; add it to TOPIC_OF_ACTION`);
        continue;
      }
      const want = topic === null || topic === 'safety' ? [] : [topic];
      for (const phrasing of lines) {
        const line = fill(phrasing, topic);
        const got = topicsIn(line).filter((t) => t !== 'safety');
        if (JSON.stringify(got) !== JSON.stringify(want)) misses.push(`${key}: "${line}" was taken for ${JSON.stringify(got)}`);
      }
    }
    expect(misses).toEqual([]);
  });
});

describe('checkReplyAgainstAction', () => {
  it('flags the live failure: asking for the phone number while the location is "I-95"', () => {
    const check = checkReplyAgainstAction('Got it, Mike. Can you confirm if this is the best number to reach you?', planFor(MIKE));
    expect(check.deviation?.asked).toBe('callback_number');
  });

  it('accepts the right question', () => {
    const check = checkReplyAgainstAction(
      "I'm sorry you're dealing with that, Mike. Can you tell me the nearest exit, mile marker, or landmark on I-95?",
      planFor(MIKE),
    );
    expect(check.deviation).toBeNull();
    expect(check.questionCount).toBe(1);
  });

  it('flags asking for something already given', () => {
    const plan = planFor({ ...MIKE, location: 'exit 42 on I-95' });
    expect(checkReplyAgainstAction('Thanks. And what is your name?', plan).deviation?.asked).toBe('name');
    expect(checkReplyAgainstAction('What kind of vehicle is it?', plan).deviation?.asked).toBe('vehicle');
  });

  it('allows a question that covers the required topic alongside another', () => {
    const plan = planFor(MIKE);
    const check = checkReplyAgainstAction('Where exactly on I-95 are you, and can the truck still move?', plan);
    expect(check.deviation).toBeNull();
  });

  it('ignores statements and unfinished sentences', () => {
    const plan = planFor(MIKE);
    expect(checkReplyAgainstAction("I'll make sure the team has the best number to reach you.", plan).deviation).toBeNull();
    expect(checkReplyAgainstAction('Is this the best number', plan).deviation).toBeNull();
  });

  it('lets the read-back mention every detail', () => {
    const plan = planFor(
      { ...MIKE, location: 'exit 42 on I-95', vehicleMovable: false },
      { phoneConfirmed: true },
    );
    expect(plan.action).toBe('CONFIRM_DETAILS');
    const check = checkReplyAgainstAction(
      'So that is Mike, a semi truck that cannot move, at exit 42 on I-95, and we will call +18174098408. Is that all correct?',
      plan,
    );
    expect(check.deviation).toBeNull();
  });

  describe('movement and place words used in passing', () => {
    // Location settled and movability known: both topics must wait.
    const settled = () => planFor({ ...MIKE, location: 'exit 42 on I-95', vehicleMovable: false });

    it.each([
      "What's my next move?",
      'Shall we move on to the vehicle?',
      'Can we move forward with your name?',
      "What's the next step?",
      'Are you able to move to a safe spot?',
      // The real call: stopped twice as a movability question while the service was being asked.
      'For example, do you need a tow, a jump start, or something else?',
      'Do you need a tow or something like a jump start?',
    ])('does not take "%s" for a question about whether the vehicle can move', (line) => {
      expect(questionsIn(line)[0]?.topics ?? []).not.toContain('movable');
    });

    it('lets "do you need a tow?" through while what help they need is being asked', () => {
      const asking = planFor({ location: 'I-88 mile marker 27' });
      expect(asking.action).toBe('ASK_SERVICE_TYPE');
      expect(checkReplyAgainstAction("I'm sorry. Do you need a tow, a jump start, or something else?", asking).deviation).toBeNull();
    });

    it.each([
      'Can it still move?',
      'Is it drivable?',
      'Does it need to be towed?',
      'Does the car need a tow?',
      'Can the car roll?',
      'Is the truck still running?',
      'Can you still drive it?',
      'Is the vehicle drivable, or does it need a tow?',
    ])('still takes "%s" for a question about whether the vehicle can move', (line) => {
      expect(questionsIn(line)[0]?.topics).toContain('movable');
    });

    it('does not take a detail echoed before the question for a location question', () => {
      const plan = planFor({ ...MIKE, location: 'exit 42 on I-95', vehicleType: undefined });
      expect(questionsIn('Got it, exit 42, what kind of vehicle is it?')[0]?.topics).toEqual(['vehicle']);
      expect(checkReplyAgainstAction('Got it, exit 42, what kind of vehicle is it?', plan).deviation).toBeNull();
      expect(checkReplyAgainstAction('Is anyone nearby who can help?', settled()).deviation).toBeNull();
    });

    it.each(['Where exactly on I-95 are you?', "What's the nearest exit?", 'Are you near a landmark?', 'Could you confirm the location again?', 'Is there a mile marker near you?'])(
      'still takes "%s" for a location question',
      (line) => {
        expect(questionsIn(line)[0]?.topics).toContain('location');
      },
    );

    it('does not stop a reply for a planning phrase', () => {
      expect(checkReplyAgainstAction("Okay. What's my next move?", settled()).deviation).toBeNull();
    });
  });

  describe('what is wrong with the vehicle and what help they need', () => {
    // Asked on the 13 Nov calls (ba50602f, fe228d39): "You also didn't ask me what was wrong with the car".
    const where = { location: 'exit 42 on I-95', vehicleType: 'box truck' };

    it('lets either stand for the other while one of them is required', () => {
      const condition = planFor({ serviceType: 'tow', ...where });
      expect(condition.action).toBe('ASK_VEHICLE_CONDITION');
      expect(checkReplyAgainstAction("Okay. What's wrong with it?", condition).deviation).toBeNull();
      expect(checkReplyAgainstAction("What's going on with the car?", condition).deviation).toBeNull();

      const service = planFor(where);
      expect(service.action).toBe('ASK_SERVICE_TYPE');
      expect(service.doNotAsk).not.toContain('condition');
      expect(checkReplyAgainstAction('Oh no. What happened to it?', service).deviation).toBeNull();
    });

    it('still stops a question about what is wrong before its turn, or once it is known', () => {
      expect(checkReplyAgainstAction("What's wrong with the car?", planFor({ serviceType: 'tow', location: 'I-95' })).deviation?.asked).toBe('condition');

      const known = planFor({ serviceType: 'tow', ...where, vehicleCondition: 'overheated', vehicleMovable: true });
      expect(known.action).toBe('ASK_CUSTOMER_NAME');
      expect(checkReplyAgainstAction("And what's wrong with the truck?", known).deviation?.asked).toBe('condition');
    });

    it('keeps either waiting once it is known', () => {
      const asking = planFor({ serviceType: 'tow', ...where });
      const said = planFor({ ...where, vehicleCondition: "won't start" });
      expect(said.action).toBe('ASK_SERVICE_TYPE');
      expect(said.doNotAsk).toContain('condition');
      expect(asking.doNotAsk).toContain('service');
    });
  });

  describe('the question named for once this one is answered', () => {
    // Real call 5176f4be: the answer is saved and the next question asked in one reply, while the plan is still the one answered.
    const vehicle = planFor({ serviceType: 'tow', location: 'exit 42 on I-95' });

    it('is not a deviation, asked in the reply that saves the answer', () => {
      expect(vehicle.action).toBe('ASK_VEHICLE');
      expect(vehicle.ifAnswered?.topic).toBe('condition');
      expect(vehicle.doNotAsk).toContain('condition');
      expect(checkReplyAgainstAction("A Civic, got it. What's wrong with it?", vehicle).deviation).toBeNull();
      // To a caller the same question, as when it is the one required.
      expect(checkReplyAgainstAction("A Civic, got it. What's going on with it?", vehicle).deviation).toBeNull();
      expect(checkReplyAgainstAction('What are you driving?', vehicle).deviation).toBeNull();
    });

    it('lets nothing else through', () => {
      expect(checkReplyAgainstAction("What's your name?", vehicle).deviation?.asked).toBe('name');
      expect(checkReplyAgainstAction('Does it roll and steer, or is it stuck where it is?', vehicle).deviation?.asked).toBe('movable');
      expect(checkReplyAgainstAction('Is this the best number to reach you on?', vehicle).deviation?.asked).toBe('callback_number');
    });

    it('is still stopped under a plan that names none', () => {
      const location = planFor({ serviceType: 'tow' });
      expect(location.ifAnswered).toBeUndefined();
      expect(checkReplyAgainstAction("What's wrong with it?", location).deviation?.asked).toBe('condition');
      // Without the follow-up, the same plan stops the same reply.
      const { ifAnswered: _named, ...alone } = vehicle;
      expect(checkReplyAgainstAction("A Civic, got it. What's wrong with it?", alone).deviation?.asked).toBe('condition');
    });
  });

  it('takes the number question however the caller ID is put', () => {
    for (const line of ["Is the number you're calling from the best one to reach you?", 'Is the number you are calling from the best one to reach you?', 'Is the number you are calling on the best one?']) {
      expect(questionsIn(line)[0]?.topics, line).toContain('callback_number');
    }
  });

  it('counts questions for the one-question rule', () => {
    expect(questionsIn('Where are you? And what vehicle is it? Thanks.').length).toBe(2);
  });
});
