/**
 * The rules as a judge: what the caller said, read by its words alone.
 *
 * Stands in for Jev when there is no TypeSafe key, and while Jev is slow or
 * down (see `ResilientJudge`), so the call takes the same paths either way: a
 * question is still owed an answer, a reply that skipped it is still caught,
 * a clear "yes" is still taken, and "it's not moving" is still a tow. Built
 * from the word lists the gateway already reads the transcript with. No
 * network, so every answer is ready at once.
 *
 * Its scores are not probabilities. Each is set clearly on one side of its
 * floor in `typesafe-questions.ts`: what the words make plain is acted on, and
 * what they do not is left below the floor, or not judged at all, so the
 * model and the rules decide as they did before there was a judge. Danger and
 * urgency are not judged here, since `risk.ts` reads them from the same line,
 * and neither are a location or the help as saved: `classifyLocation` and the
 * intake's own rules decide those.
 */

import { askedAbout, type AskedAbout } from '../../conversation/ready-answers';
import { questionsIn } from '../../conversation/response-check';
import {
  type CallerWordsKind,
  classifyCallerWords,
  isBackchannel,
  isPresenceCheck,
  readYesNo,
} from '../realtime/caller-words';
import type {
  CallJudge,
  CallJudgments,
  CallerMove,
  ConfirmationJudgment,
  MoveJudgment,
  QuestionTopic,
  ServiceChoice,
  ServiceJudgment,
  SpeechContext,
} from './judgment.interface';

/* -------------------------------------------------------------------------- */
/*  Scores                                                                    */
/* -------------------------------------------------------------------------- */

/** A question, complaint or check of the line the word lists are sure of: over `MOVE_CONFIDENCE_FLOOR` (0.6). */
export const SURE_MOVE = 0.8;
/** Small talk wants a person's answer, as a question does; a detail is a request. Both still over the floor. */
export const LIKELY_MOVE = 0.7;
/** Anything else is `other`, under the floor: nothing is owed an answer. */
export const UNSURE_MOVE = 0.5;

/** A clear yes or no: over `CONFIRMATION_FLOOR` (0.7) or `CORRECTION_FLOOR` (0.5), the other one far under. */
export const CLEAR_ANSWER = 0.9;
export const NOT_THE_ANSWER = 0.05;
/** "Yes, but…": neither a yes the request can be completed on, nor a correction. */
export const NEITHER = 0.2;

/** Words that can only mean one kind of help: over `SERVICE_CONFIDENCE_FLOOR` (0.75), saved as inferred. */
export const SURE_SERVICE = 0.85;
/** Words that fit two kinds ("it won't start"): under the floor, so the two are offered instead. */
export const LIKELY_SERVICE = 0.6;
/** Words for two different kinds, each sure on its own ("a flat, and I'm out of gas"): offered, not saved. */
export const MIXED_SERVICE = 0.5;

/** Over `OVERLAP_ANSWER_FLOOR` (0.7): a detail or a no said over the receptionist is answered. */
export const OVERLAP_ANSWERS = 0.9;
/** At most `OVERLAP_ACKNOWLEDGEMENT_CEILING` (0.3): only listening, or checking the line. */
export const OVERLAP_ACKNOWLEDGES = 0.1;
/** Between the two: the gateway's word lists decide, as they did before there was a judge. */
export const OVERLAP_UNSURE = 0.5;

/** Over `ANSWERED_FLOOR` (0.5): the reply answered or acknowledged the line. */
export const REPLY_ANSWERED = 0.8;
export const REPLY_UNANSWERED = 0.2;

/** Curly apostrophes to straight ones and runs of space to one: the word lists are written plain. */
const plain = (text: string) => text.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

/* -------------------------------------------------------------------------- */
/*  What the caller is doing                                                  */
/* -------------------------------------------------------------------------- */

const MOVES: Record<CallerWordsKind, [CallerMove, number]> = {
  question: ['question', SURE_MOVE],
  complaint: ['complaint', SURE_MOVE],
  line_check: ['line_check', SURE_MOVE],
  small_talk: ['question', LIKELY_MOVE],
  detail: ['request', LIKELY_MOVE],
  unfinished: ['other', UNSURE_MOVE],
  backchannel: ['other', UNSURE_MOVE],
  asking_for_time: ['other', UNSURE_MOVE],
  unknown: ['other', UNSURE_MOVE],
};

function moveFrom(spoken: string): MoveJudgment {
  const line = plain(spoken);
  const [move, confidence] = MOVES[classifyCallerWords(line)];
  // The arrival time and the price are the topics the lead has to carry; any other question is just a question.
  const topic: QuestionTopic | undefined = askedAbout(line)[0] ?? (move === 'question' ? 'other' : undefined);
  // Turn numbers are the caller's to stamp, as with Jev.
  return { text: spoken, callerTurn: -1, move, confidence, ...(topic ? { topic } : {}) };
}

/* -------------------------------------------------------------------------- */
/*  Yes or no to the question pending                                         */
/* -------------------------------------------------------------------------- */

/**
 * Only for a line whose words settle it. Anything else is not judged, so the
 * model's own flag decides, as before there was a judge: a judgment of "not a
 * yes" would refuse its `complete_request` and have it ask again, and asking
 * again is the mistake callers complain of.
 */
function confirmationFrom(spoken: string): ConfirmationJudgment | undefined {
  const answer = readYesNo(spoken);
  if (!answer) return undefined;
  const [confirms, corrects] =
    answer === 'yes' ? [CLEAR_ANSWER, NOT_THE_ANSWER] : answer === 'no' ? [NOT_THE_ANSWER, CLEAR_ANSWER] : [NEITHER, NEITHER];
  return { text: spoken, callerTurn: -1, confirms, corrects };
}

/* -------------------------------------------------------------------------- */
/*  The help they need                                                        */
/* -------------------------------------------------------------------------- */

type Help = Exclude<ServiceChoice, 'unclear'>;

interface HelpWords {
  service: Help;
  /** Words that fit this kind or another one. Without it, the words fit this kind only. */
  or?: Help;
  pattern: RegExp;
}

/**
 * What a caller says is wrong, and the help it calls for. A caller describes
 * the problem far more often than they name the help: on a real call "it's
 * stuck, it's not moving" was met with "what kind of help do you need?" four
 * times. The kinds are those of `SERVICE_LABEL`.
 */
const HELP_WORDS: readonly HelpWords[] = [
  {
    // It will not go under its own power: it has to be taken somewhere. Not
    // "I can't move": that is the caller, and it is about danger.
    service: 'tow',
    pattern:
      /\bnot (?:moving|budging|rolling)\b|\b(?:won'?t|will not|doesn'?t|does not) (?:move|budge|roll|drive)\b|\b(?:it|car|truck|van|vehicle|suv) (?:can'?t|cannot|isn'?t|is not) (?:move|moving|budge|roll|rolling|drive|driving|be driven)\b|\bcan'?t (?:move|drive) it\b|\b(?:won'?t|will not) go\b|\bundrive?able\b|\bbroken? down\b|\bbreak ?down\b|\bneeds? (?:to be )?towed\b|\bneeds? a tow\b|\b(?:engine|motor) (?:blew|seized)\b|\b(?:crash(?:ed)?|accident|wreck(?:ed)?|collision)\b/i,
  },
  {
    service: 'jump_start',
    pattern:
      /\b(?:dead|flat|drained) batter(?:y|ies)\b|\bbatter(?:y|ies)(?: is| was|'s| has)?(?: completely| totally| just)? (?:dead|flat|drained|died|gone)\b|\bjump[- ]?start(?:ed|ing)?\b|\bneeds? a jump\b|\bgive (?:me|it|us) a jump\b|\b(?:only|just) click(?:s|ing)?\b|\bleft (?:the|my) (?:head ?)?lights on\b/i,
  },
  {
    service: 'lockout',
    pattern:
      /\blocked (?:myself )?out\b|\block(?:ed)? (?:my|the) keys\b|\bkeys? (?:are |is )?(?:locked )?(?:inside|in (?:the|my) (?:car|truck|van|vehicle))\b|\blost (?:my|the) (?:car )?keys?\b|\block-?out\b/i,
  },
  {
    service: 'fuel_delivery',
    pattern: /\bout of (?:gas|fuel|petrol|diesel)\b|\bempty (?:gas |fuel )?tank\b|\bno (?:gas|fuel|petrol|diesel) left\b/i,
  },
  {
    service: 'flat_tire',
    pattern:
      /\bflat (?:tire|tyre)s?\b|\b(?:tire|tyre)s? (?:is |are |went |'s )?flat\b|\ba flat\b(?!\s+(?:rate|fee|price|battery)\b)|\bblow-?out\b|\bblew (?:a |out (?:a |the |my )?|my )(?:tire|tyre)\b|\bpunctured?\b/i,
  },
  {
    // A dead battery or worse: a jump gets one going, the other needs a tow.
    service: 'tow',
    or: 'jump_start',
    pattern:
      /\b(?:won'?t|will not|doesn'?t|does not|didn'?t|did not|wouldn'?t|not) (?:start|starting|turn over|turning over|crank|cranking)\b|\b(?:car|truck|van|vehicle|engine|it)(?:'s| is| just)? (?:dead|died)\b|\bstall(?:ed|s|ing)?\b/i,
  },
  {
    // It would run if it were free; if it is damaged it needs a tow.
    service: 'winch_out',
    or: 'tow',
    pattern: /\bstuck in (?:the |a |some )?(?:mud|sand|snow|ditch)\b|\bin (?:a|the) ditch\b/i,
  },
];

/** "It's not a flat", "I'm not out of gas": the words say what the problem is not. */
const NEGATION = new Set(['no', 'not', 'never', 'dont', 'didnt', 'isnt', 'wasnt', 'aint', 'without']);

function negated(line: string, index: number): boolean {
  const before = line.slice(0, index).toLowerCase().match(/[a-z']+/g) ?? [];
  return before.slice(-2).some((word) => NEGATION.has(word) || word.endsWith("n't"));
}

function helpFrom(spoken: string): ServiceJudgment | undefined {
  const line = plain(spoken);
  const sure = new Set<Help>();
  const likely: Help[] = [];
  for (const words of HELP_WORDS) {
    const match = words.pattern.exec(line);
    if (!match || negated(line, match.index)) continue;
    if (words.or) likely.push(words.service, words.or);
    else sure.add(words.service);
  }
  const [first, second] = sure.size > 0 ? [...sure] : [...new Set(likely)];
  if (!first) return undefined;
  if (sure.size === 1) return { text: spoken, service: first, confidence: SURE_SERVICE, alternatives: [first] };
  const alternatives = second ? [first, second] : [first];
  return { text: spoken, service: first, confidence: sure.size > 1 ? MIXED_SERVICE : LIKELY_SERVICE, alternatives };
}

/* -------------------------------------------------------------------------- */
/*  Did the reply answer the caller                                           */
/* -------------------------------------------------------------------------- */

/** For a complaint: an apology, or owning the mistake. */
const APOLOGY = /\b(?:sorry|apologi[sz]e|apologies|my (?:bad|mistake)|you'?re (?:right|correct)|fair (?:enough|point)|that'?s on me)\b/i;

/** For a check of the line: the receptionist is there and can hear them. */
const HEARS_YOU =
  /\b(?:i can hear you|i hear you|i'?m (?:still )?(?:here|with you)|i am (?:still )?(?:here|with you)|loud and clear)\b|^(?:yes|yeah|yep|yup|hi|hello|hey)\b/i;

/** A sentence that only fills time: "Hmm.", "Let me check.", "One moment." */
const FILLER_SENTENCE =
  /^(?:(?:h+m+|u+m+|u+h+|o+h+|a+h+|let me (?:see|check|look)|one (?:moment|sec(?:ond)?)|just a (?:moment|sec(?:ond)?)|bear with me)\b[,.!?\s]*)+$/i;

/** A question about the arrival time or the price is only answered by a reply that speaks of it. */
const SPEAKS_OF: Record<AskedAbout, RegExp> = {
  eta: /\b(?:eta|how long|minutes?|hours?|soon|arriv\w*|on (?:the|their|its) way|time)\b/i,
  price: /\b(?:price|pricing|cost\w*|quote|charge\w*|fees?|rates?|pay|dollars?)\b|\$/i,
};

/**
 * The reply's first sentence that says something, not only "Got it." or "Let
 * me check.": an intake question there means the reply went straight past
 * the caller. Anything else answered or acknowledged them. That leans towards
 * "answered", on purpose: a line wrongly taken as unanswered is put to the
 * model again on the next turn, and a receptionist that answers the same
 * thing twice is the mistake callers complain of most.
 */
function replyAnswers(callerSaid: string, reply: string): boolean {
  const kind = classifyCallerWords(callerSaid);
  if (kind === 'complaint' && APOLOGY.test(reply)) return true;
  if (kind === 'line_check' && HEARS_YOU.test(reply)) return true;
  const asked = askedAbout(callerSaid);
  if (asked.length > 0 && !asked.some((topic) => SPEAKS_OF[topic].test(reply))) return false;
  const first = (reply.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((sentence) => sentence.trim())
    .find((sentence) => sentence && !isBackchannel(sentence) && !FILLER_SENTENCE.test(sentence));
  if (!first) return false;
  return !questionsIn(first).some((question) => question.topics.length > 0);
}

/* -------------------------------------------------------------------------- */
/*  Words said over the receptionist                                          */
/* -------------------------------------------------------------------------- */

/**
 * A detail, or a yes or no that is one ("No.", "Yes, exit 12"), is an answer;
 * a check of the line or a sound of listening is not. A bare "yes" or "okay"
 * after a question may be the answer to it, so that is left to the gateway's
 * word lists, which answer it.
 */
function overlapAnswers(spoken: string, receptionistSaid: string): number {
  const kind = classifyCallerWords(spoken);
  if (kind === 'detail') return OVERLAP_ANSWERS;
  if (kind === 'line_check' || isPresenceCheck(spoken)) return OVERLAP_ACKNOWLEDGES;
  if (kind === 'backchannel' || isBackchannel(spoken)) {
    return /\?\s*$/.test(receptionistSaid.trim()) ? OVERLAP_UNSURE : OVERLAP_ACKNOWLEDGES;
  }
  return OVERLAP_UNSURE;
}

/* -------------------------------------------------------------------------- */
/*  The judge                                                                 */
/* -------------------------------------------------------------------------- */

export class RulesJudge implements CallJudge {
  /** `classifyLocation` decides, as it always has without a judge. */
  async judgeLocation(): Promise<CallJudgments | null> {
    return null;
  }

  /** The help as saved is kept as the model saved it. */
  async judgeService(): Promise<CallJudgments | null> {
    return null;
  }

  /** Asked the same things as Jev, on the same conditions: a confirmation only while a question is pending, the help only while none is saved. */
  async judgeSpeech(spoken: string, about: SpeechContext): Promise<CallJudgments | null> {
    const judgments: CallJudgments = { move: moveFrom(spoken) };
    const confirmation = about.pending ? confirmationFrom(spoken) : undefined;
    if (confirmation) judgments.confirmation = confirmation;
    const service = about.serviceMissing ? helpFrom(spoken) : undefined;
    if (service) judgments.service = service;
    return judgments;
  }

  async judgeOverlap(spoken: string, receptionistSaid: string): Promise<CallJudgments | null> {
    return { overlap: { text: spoken, answers: overlapAnswers(spoken, receptionistSaid) } };
  }

  async judgeReply(callerSaid: string, reply: string): Promise<CallJudgments | null> {
    const answered = replyAnswers(plain(callerSaid), plain(reply)) ? REPLY_ANSWERED : REPLY_UNANSWERED;
    return { reply: { text: callerSaid, reply, answered } };
  }
}
