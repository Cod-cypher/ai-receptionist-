/**
 * Does what the receptionist is saying follow the required action?
 *
 * Checked on the model's words as they are produced, with patterns rather
 * than another model call, so it costs nothing on a normal reply. It only
 * judges finished questions (a sentence ending in "?"), and only flags a
 * question about a topic the priority engine said must wait — high precision
 * by design, since a false alarm cuts off a good reply.
 */

import { ASKED_AS_ONE, type NextActionPlan, type Topic } from './next-action';

// The patterns must take every phrasing the priority engine suggests as its own
// topic and no other (see the table in response-check.test.ts): a suggested
// question the check does not recognise is scored off-plan by the eval, and
// one it takes for a later topic is cut off live.

// Kinds of help, as a receptionist offers them: "Do you need a tow, or a jump start?"
const KINDS_OF_HELP = String.raw`tow(?:ing)?|jump(?:[- ]?start)?|boost|tire change|flat(?: tire)?|lock-?out|unlock|fuel(?: delivery)?|gas|winch(?:[- ]?out)?`;

// Enough to know "Did you say Honda Civic?" checks the vehicle. Makes that are
// also common street names (Lincoln) are left out, so "did you say Lincoln
// Avenue?" stays a location check.
const VEHICLE_WORDS = String.raw`honda|toyota|ford|chevy|chevrolet|nissan|hyundai|kia|dodge|ram|jeep|gmc|bmw|mercedes(?:-benz)?|audi|volkswagen|vw|subaru|mazda|tesla|lexus|acura|infiniti|buick|cadillac|chrysler|volvo|mitsubishi|suzuki|porsche|freightliner|peterbilt|kenworth|civic|accord|corolla|camry|f-?150|silverado|mustang|altima|sentra|wrangler|tacoma|tundra|prius|elantra|sonata|car|truck|pickup|suv|van|minivan|sedan|coupe|hatchback|semi|motorcycle|motorbike|rv|motorhome|camper|trailer`;

const TOPIC_PATTERNS: Array<[Topic, RegExp]> = [
  [
    'callback_number',
    // "this number" is how a person asks to call back on the caller ID
    // ("Should we call you back on this number?"). "Your number" is not
    // enough: "So far I've just got your number" answers a question.
    // A run of seven digits is the number being checked back.
    /\b(?:best|good|right|correct|another|different|better|alternate|alternative) (?:phone |contact |callback |call-?back )?number\b|\bnumber (?:to|we can|i can|they can) (?:reach|call|contact)\b|\breach you (?:on|at)\b|\bcall(?:ing)? (?:you )?back on\b|\bcall you (?:on|at) (?:this|that|the same)\b|\bthe number you(?:'?re| are) calling (?:from|on)\b|\b(?:this|that) (?:phone )?number\b|\b(?:can|could|may) (?:i|we) (?:get|have|take) (?:your|a) (?:phone |callback |call-?back )?number\b|\b(?:best|good) way to (?:reach|contact|call) you\b|(?:\d[\s,-]*){7,}/i,
  ],
  [
    'name',
    /\b(?:your|the caller'?s) (?:full |first |last )?name\b|\bwho am i (?:speaking|talking) (?:to|with)\b|\bwho(?:'s| is) (?:this|calling|speaking)\b|\b(?:may|can|could) i (?:have|get|ask|take) (?:your |a )?name\b|\bwhat name\b/i,
  ],
  [
    'vehicle',
    // "Did you say Honda Civic?" checks a vehicle the model was not sure it
    // heard. The vehicle must be all that is checked: "did you say the car
    // won't start?" is about whether it moves.
    new RegExp(
      String.raw`\bwhat (?:kind|type|make|sort|model) of (?:vehicle|car|truck|van|suv|pickup|motorcycle|bike)\b|\bwhat (?:vehicle|car|truck) (?:is it|do you (?:have|drive)|are you)\b|\bwhat(?:'re| are| were) you driving\b|\bwhat do you drive\b|\bmake and model\b|\b(?:the|what|which) (?:make|model)\b|\b(?:did you say|was (?:that|it))\s+(?:(?:it|that)(?:'s| is| was)\s+)?(?:a |an |the |your )?(?:[\w-]+\s+){0,2}?(?:${VEHICLE_WORDS})(?:\s+[\w-]+)?\s*(?:\?|$|,?\s+or\b|,?\s+right\b)`,
      'i',
    ),
  ],
  // Framed as a question about the vehicle. A bare "move" also matched "what's
  // my next move?" and "can we move on?", and the reply was stopped as asking
  // about movability; "can you move to a safe spot?" is about the caller.
  // "Do you need a tow?" asks what help they want: only the vehicle needs
  // towing. Counted as movability, it stopped that question twice on a call.
  // Said back as a check ("Sorry, so it won't move at all?"), it still asks
  // whether the vehicle moves.
  [
    'movable',
    /\b(?:can|could|does|is|will|would) (?:it|that|the \w+|your \w+) (?:still |even )?(?:move|roll|drive|run|start|steer|stuck|be driven|be moved)\b|\b(?:it|that|the \w+|your \w+) (?:won't|can't|cannot|doesn't|does not|will not|(?:can|will) still) (?:move|roll|drive|run|start|steer|be driven|be moved)\b|\b(?:can|could) you (?:still |even )?(?:drive|move|roll|start|steer) (?:it|the \w+|your \w+)\b|\b(?:drivable|driveable|movable|moveable)\b|\bable to (?:drive|roll)\b|\bneeds? to be towed\b|\b(?:it|that|the \w+|your \w+) needs? (?:a tow|towing)\b|\bstill (?:moving|rolling|running)\b|\bunder its own power\b/i,
  ],
  [
    'destination',
    /\bwhere (?:would you like|do you want|should (?:we|it|they)) (?:it|the vehicle|the truck|the car|your \w+)? ?(?:to be )?(?:taken|towed|go|dropped)\b|\bdestination\b/i,
  ],
  [
    'details',
    // "Did I get all that right?" ends the read-back; "Is that all correct?" is
    // the older line, still used by older pipelines. Both must count, and so
    // must the short forms of asking again ("Sound right?").
    /\b(?:(?:is|was) (?:that|this|everything|all (?:of )?that|that all|this all|it all|all of it) (?:correct|right|accurate)|(?:did|do|have) i (?:get|got|have) (?:that|everything|it all|all (?:of )?that|that all) (?:right|correct|down)|(?:sounds?|looks?) (?:right|correct)|(?:is|are|were) (?:those|these|the|your) details (?:correct|right|accurate)|did i miss anything|anything i (?:got wrong|missed))\b/i,
  ],
  // A place noun counts only after an article or question word: the prompt asks
  // the model to echo a detail ("Got it, exit 42, what kind of vehicle is it?"),
  // and a bare "exit" made that a location question. "Where" after a word like
  // "stuck" is not asking: "Does it roll and steer, or is it stuck where it is?"
  // asks whether it moves.
  [
    'location',
    /(?<!\b(?:stuck|stay|stays|stayed|staying|sitting|sits|sat|parked|left|leave|stopped) (?:right )?)\bwhere\b|\b(?:what|which|any|a|an|the|your|nearest|closest|exact)\s+(?:\w+\s+)?(?:exit|mile ?marker|cross ?street|landmark|address|location|intersection)\b|\b(?:what|which) (?:road|street|highway|interstate|freeway|city|town|area|direction)\b|\b(?:are you|is it|is the (?:car|vehicle|truck)) (?:near|close to|by|at|on)\b|\b(?:business|store|building|sign|landmark|something)(?:es|s)? (?:that )?you can see\b|\b(?:did you say|was that)\b[^?]*?\b(?:exit|mile ?marker|cross ?street|intersection|street|road|avenue|highway|interstate|freeway|route|i-?\d+)\b/i,
  ],
  // What is wrong with the vehicle: "wrong with" or "happened to" something.
  // The same words with nothing after them ("What happened?") ask what is
  // going on, and are the service's. The two are one question to a caller,
  // and `checkReplyAgainstAction` treats them so (`ASKED_AS_ONE`).
  [
    'condition',
    /\bwhat(?:'s| is| was| seems to be) (?:wrong|the (?:problem|issue|trouble)) with\b|\bwhat (?:exactly )?happened (?:to|with)\b/i,
  ],
  [
    'service',
    new RegExp(
      String.raw`\bwhat (?:kind|sort|type) of (?:help|service|assistance)\b|\bhow can i help\b|\bwhat can i do for you\b|\bwhat do you need\b|\bwhat(?:'s| is| seems to be) (?:going on\b|(?:wrong|the (?:problem|issue|trouble))\b(?! with\b))|\bwhat (?:exactly )?happened\b(?! (?:to|with)\b)|\bput you down for\b|\b(?:do|would) you (?:need|want)\s+(?:help with )?(?:a |an |some )?(?:${KINDS_OF_HELP})\b|\b(?:${KINDS_OF_HELP}),? or (?:a |an |some )?(?:${KINDS_OF_HELP}|something else)\b|\b(?:${KINDS_OF_HELP}) (?:you need|you want|you're after)\b`,
      'i',
    ),
  ],
];

/**
 * The read-back's own question: one question about all of it. Run on from the
 * details without a full stop ("...we'll call you back on 8 1 7, 4 0 9, 8 4 0 8,
 * did I get all that right?"), the details in it would read as a location, a
 * vehicle and a number question. A bare "is that right?" is left out: it also
 * checks a single value ("it needs to be towed, is that right?"), and so is
 * "is that all right?", which means "is that okay?".
 */
const READ_BACK_CHECK =
  /\b(?:(?:is|was) (?:that all|this all|it all) (?:correct|accurate)|(?:is|was) (?:all (?:of )?(?:that|this|it)|everything) (?:correct|right|accurate)|(?:did|do|have) i (?:get|got|have) (?:all (?:of )?(?:that|this|it)|that all|it all|everything) (?:right|correct|down)|does (?:all (?:of )?that|that all|everything) (?:sound|look) (?:right|correct)|(?:is|are|were) (?:those|these|the|your|all the|all those) details (?:correct|right|accurate))\b/i;

/** What a finished question is about. */
function topicsOf(sentence: string): Topic[] {
  // Transcripts write "What’s"; the patterns are written with a straight apostrophe.
  const plain = sentence.replace(/[‘’ʼ]/g, "'");
  if (READ_BACK_CHECK.test(plain)) return ['details'];
  return TOPIC_PATTERNS.filter(([, pattern]) => pattern.test(plain)).map(([topic]) => topic);
}

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
    .map((sentence) => ({ text: sentence, topics: topicsOf(sentence) }));
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
  // "What happened to it?" while the help they need is required, or "what's
  // going on?" while what is wrong is: the caller hears the question asked.
  const required = plan.topic ? [plan.topic, ASKED_AS_ONE[plan.topic]] : [];
  // The question named for once this one is answered (`ifAnswered`) is asked
  // in the same reply as the save, while this plan still stands: "A Civic,
  // got it. What's wrong with it?" under ASK_VEHICLE is the reply asked for.
  const next = plan.ifAnswered ? [plan.ifAnswered.topic, ASKED_AS_ONE[plan.ifAnswered.topic]] : [];
  const allowed = [...required, ...next];

  for (const question of questions) {
    // A question that also covers the required topic ("where on I-95 — can it
    // still move?") is judged on its other topics only if none is the current one.
    if (question.topics.some((topic) => allowed.includes(topic))) continue;
    const asked = question.topics.find((topic) => plan.doNotAsk.includes(topic));
    if (asked) {
      return { deviation: { asked, question: question.text, reason: 'already_known_or_later' }, questionCount: questions.length };
    }
  }
  return { deviation: null, questionCount: questions.length };
}
