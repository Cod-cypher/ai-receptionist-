/**
 * Does what the receptionist is saying follow the required action?
 *
 * Checked on the model's words as they are produced, with patterns rather
 * than another model call, so it costs nothing on a normal reply. It only
 * judges finished questions (a sentence ending in "?"), and only flags a
 * question about a topic the priority engine said must wait — high precision
 * by design, since a false alarm cuts off a good reply.
 */

import type { NextActionPlan, Topic } from './next-action';

const TOPIC_PATTERNS: Array<[Topic, RegExp]> = [
  [
    'callback_number',
    /\b(?:best|good|right|correct|another|different|better|alternate|alternative) (?:phone |contact |callback |call-?back )?number\b|\bnumber (?:to|we can|i can|they can) (?:reach|call|contact)\b|\breach you (?:on|at)\b|\bcall(?:ing)? (?:you )?back on\b|\bthe number you'?re calling from\b/i,
  ],
  ['name', /\b(?:your|the caller'?s) (?:full |first )?name\b|\bwho am i (?:speaking|talking) (?:to|with)\b|\bmay i (?:have|get|ask) (?:your )?name\b/i],
  [
    'vehicle',
    /\bwhat (?:kind|type|make|sort|model) of (?:vehicle|car|truck|van|motorcycle)\b|\bwhat (?:vehicle|car) (?:is it|do you have|are you)\b|\bmake and model\b/i,
  ],
  ['movable', /\b(?:still )?(?:move|moving|movable|be driven|drivable|driveable|roll|rolling)\b|\bable to drive\b|\bneeds? to be towed\b/i],
  [
    'destination',
    /\bwhere (?:would you like|do you want|should (?:we|it|they)) (?:it|the vehicle|the truck|the car|your \w+)? ?(?:to be )?(?:taken|towed|go|dropped)\b|\bdestination\b/i,
  ],
  ['details', /\b(?:is (?:that|everything|all (?:of )?that) (?:correct|right)|did i get (?:that|everything) right|does that (?:sound|look) right)\b/i],
  ['location', /\b(?:where|exit|mile ?marker|cross ?street|landmark|address|location|intersection|what road|which road|nearest|nearby)\b/i],
  ['service', /\bwhat (?:kind|sort|type) of (?:help|service|assistance)\b|\bhow can i help\b|\bwhat do you need\b|\bwhat(?:'s| is) going on\b/i],
];

export interface AskedQuestion {
  text: string;
  topics: Topic[];
}

/** The finished questions in a reply, and what each is about. */
export function questionsIn(text: string): AskedQuestion[] {
  const sentences = text.match(/[^.!?]*\?/g) ?? [];
  return sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => ({
      text: sentence,
      topics: TOPIC_PATTERNS.filter(([, pattern]) => pattern.test(sentence)).map(([topic]) => topic),
    }));
}

export interface ActionDeviation {
  asked: Topic;
  question: string;
  /** A topic already settled, or one lower in the order than the current action. */
  reason: 'already_known_or_later';
}

export interface ActionCheck {
  deviation: ActionDeviation | null;
  /** Questions with a recognised topic; more than one breaks the one-question rule. */
  questionCount: number;
}

export function checkReplyAgainstAction(text: string, plan: NextActionPlan): ActionCheck {
  const questions = questionsIn(text).filter((q) => q.topics.length > 0);

  for (const question of questions) {
    // A question that also covers the required topic ("where on I-95 — can it
    // still move?") is judged on its other topics only if none is the current one.
    if (plan.topic && question.topics.includes(plan.topic)) continue;
    const asked = question.topics.find((topic) => plan.doNotAsk.includes(topic));
    if (asked) {
      return { deviation: { asked, question: question.text, reason: 'already_known_or_later' }, questionCount: questions.length };
    }
  }
  return { deviation: null, questionCount: questions.length };
}
