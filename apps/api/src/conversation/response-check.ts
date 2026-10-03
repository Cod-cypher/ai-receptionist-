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
    /\b(?:best|good|right|correct|another|different|better|alternate|alternative) (?:phone |contact |callback |call-?back )?number\b|\bnumber (?:to|we can|i can|they can) (?:reach|call|contact)\b|\breach you (?:on|at)\b|\bcall(?:ing)? (?:you )?back on\b|\bthe number you(?:'?re| are) calling (?:from|on)\b/i,
  ],
  ['name', /\b(?:your|the caller'?s) (?:full |first )?name\b|\bwho am i (?:speaking|talking) (?:to|with)\b|\bmay i (?:have|get|ask) (?:your )?name\b/i],
  [
    'vehicle',
    /\bwhat (?:kind|type|make|sort|model) of (?:vehicle|car|truck|van|motorcycle)\b|\bwhat (?:vehicle|car) (?:is it|do you have|are you)\b|\bmake and model\b/i,
  ],
  // Framed as a question about the vehicle. A bare "move" also matched "what's
  // my next move?" and "can we move on?", and the reply was stopped as asking
  // about movability; "can you move to a safe spot?" is about the caller.
  // "Do you need a tow?" asks what help they want: only the vehicle needs
  // towing. Counted as movability, it stopped that question twice on a call.
  [
    'movable',
    /\b(?:can|could|does|is|will|would) (?:it|that|the \w+|your \w+) (?:still |even )?(?:move|roll|drive|run|start|be driven|be moved)\b|\b(?:can|could) you (?:still |even )?(?:drive|move|roll|start) (?:it|the \w+|your \w+)\b|\b(?:drivable|driveable|movable|moveable)\b|\bable to (?:drive|roll)\b|\bneeds? to be towed\b|\b(?:it|that|the \w+|your \w+) needs? (?:a tow|towing)\b|\bstill (?:moving|rolling|running)\b|\bunder its own power\b/i,
  ],
  [
    'destination',
    /\bwhere (?:would you like|do you want|should (?:we|it|they)) (?:it|the vehicle|the truck|the car|your \w+)? ?(?:to be )?(?:taken|towed|go|dropped)\b|\bdestination\b/i,
  ],
  [
    'details',
    // "Is that all correct?" is the phrasing the receptionist is asked to use; it must count.
    /\b(?:is (?:that|this|everything|all (?:of )?that|that all|this all|it all|all of it) (?:correct|right|accurate)|(?:did|do) i (?:get|have) (?:that|everything|it all|all that) right|does (?:that|this|everything) (?:sound|look) (?:right|correct)|(?:is|are) (?:those|these|the|your) details (?:correct|right))\b/i,
  ],
  // A place noun counts only after an article or question word: the prompt asks
  // the model to echo a detail ("Got it, exit 42, what kind of vehicle is it?"),
  // and a bare "exit" made that a location question.
  [
    'location',
    /\bwhere\b|\b(?:what|which|any|a|an|the|your|nearest|closest|exact)\s+(?:\w+\s+)?(?:exit|mile ?marker|cross ?street|landmark|address|location|intersection)\b|\b(?:what|which) (?:road|street|highway)\b|\b(?:are you|is it|is the (?:car|vehicle|truck)) (?:near|close to|by|at|on)\b/i,
  ],
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
