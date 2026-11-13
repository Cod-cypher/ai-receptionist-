/**
 * Scores one run, attributing every failure to the part of the system that
 * caused it — so a regression can be traced to the model, a tool, the state
 * merge, validation, the priority engine or the spoken reply.
 *
 * It also scores how human the replies sound. The call of 12 October 2026
 * (6d1304af) passed every older check in spirit: the right question each
 * turn, nothing repeated. The caller still hung up, because every reply
 * ignored what they had just said and read like a form.
 */

import { checkReply } from '../../../conversation/guardrails';
import { classifyLocation } from '../../../conversation/location';
import { determineNextAction } from '../../../conversation/next-action';
import { questionsIn } from '../../../conversation/response-check';
import { initialContext } from '../../../conversation/types';
import { EVAL_CALLER, EVAL_FACTS, type RunRecord } from './harness';
import type { Scenario } from './scenarios';

export type FailureCategory =
  | 'EXTRACTION_FAILURE'
  | 'FIELD_OMITTED'
  | 'WRONG_FIELD_VALUE'
  | 'WRONG_SPECIFICITY'
  | 'STATE_MERGE_FAILURE'
  | 'LOCATION_VALIDATION_FAILURE'
  | 'WRONG_NEXT_ACTION'
  | 'RESPONSE_DID_NOT_FOLLOW_ACTION'
  | 'PREMATURE_CONFIRMATION'
  | 'SAFETY_MISSED'
  | 'URGENCY_MISSED'
  | 'INFERENCE_UNTAGGED'
  | 'GUESSED_UNCLEAR_SPEECH'
  | 'CONVERSATION_FAILURE'
  | 'GUARDRAIL_BROKEN'
  | 'TOOL_CALL_FAILURE'
  /** A sentence said again within the call, or a second reply in one turn repeating the first. */
  | 'REPEATED_REPLY'
  /** Two questions about different things in one turn. */
  | 'MULTIPLE_QUESTIONS'
  /** A caller line that needed a reply (a question, a complaint, a line cut off) got none, or got the next question first. */
  | 'IGNORED_CALLER'
  /** Form language a person does not say on the phone: "Could you describe the location?". */
  | 'ROBOTIC_PHRASING'
  /** Two replies in a row starting with the same two words: "Got it. ..." and "Got it. ...". */
  | 'REPEATED_OPENER'
  /** More than 35 words in one turn, outside the read-back. */
  | 'OVERLONG_REPLY'
  /** A detail was saved and the reply started cold, with no "Okay." and none of the caller's words. Soft. */
  | 'NO_ACK_AFTER_DETAIL'
  /** A reply the gateway had to stop: off the plan, or a broken rule. The caller heard at most part of it (soft: the model strayed, the gateway caught it). */
  | 'STOPPED_REPLY';

export type FailureSource = 'model' | 'tool' | 'merge' | 'validation' | 'priority' | 'response' | 'backend';

export interface Failure {
  category: FailureCategory;
  source: FailureSource;
  detail: string;
  /** Reported, not failed: a habit worth watching that does not by itself make the call worse. */
  soft?: boolean;
}

const MISUNDERSTOOD = /\b(?:did ?n[o']?t|did not|could ?n[o']?t|could not|can ?n[o']?t|cannot) (?:quite )?(?:catch|understand|make out|get) (?:that|you|what)/i;
const SAFETY_ADVICE = /\b911\b|\bemergency services\b|\bcall (?:the )?(?:police|an ambulance)\b/i;

const show = (value: unknown) => JSON.stringify(value);

/** Comparable form of a sentence: case, punctuation and spacing ignored. */
const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The sentences of a reply long enough that saying one twice is a repeat, not a habit ("Okay."). */
function sentencesOf(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]?/g) ?? [])
    .map((s) => comparable(s))
    .filter((s) => s.split(' ').length >= 4);
}

function everSent(run: RunRecord, key: string): unknown[] {
  return run.ops
    .filter((o) => o.op.kind === 'update')
    .map((o) => (o.op as { slots: Record<string, unknown> }).slots[key])
    .filter((v) => v !== undefined);
}

// ---- Human-ness ----

/**
 * Form and letter language. From the call of 12 October (6d1304af): "What
 * kind of help do you need right now?", "Could you describe the location?",
 * "Could you tell me what kind of vehicle it is?".
 */
const ROBOTIC = /\bcould you (?:tell|describe|provide|let me know)\b|\bwhat kind of (?:help|vehicle|issue) do you\b|\bplease provide\b|\bat this time\b|\bin order to\b/i;

/** Past this many words in one turn, outside the read-back, a caller stops listening before the question. */
export const OVERLONG_WORDS = 35;

/**
 * A short acknowledgement opening a reply: "Okay.", "Got it, ...", "Oh no,
 * ...", "Alright so ...". It must stand on its own, so "Right now ..." and
 * "Thank you for that information" are not one.
 */
const ACK_OPENER =
  /^(?:ok(?:ay)?|alright|all right|got it|gotcha|sure|right|understood|perfect|great|good|no problem|of course|yes|yeah|yep|oh(?: no| dear)?|ah|ugh|yikes|i see|mm-?hm+|mhm|uh-?huh|hmm+|thanks|thank you|sorry|absolutely|sounds good|noted|cool)(?=\s*(?:[.,!;:\p{Pd}]|$)|\s+(?:so|and|then)\b)/iu;
/** Empathy, once, is how a person meets a breakdown, though it runs to four words. */
const EMPATHY_OPENER = /^(?:oh,?\s+)?(?:i'm\s+)?(?:so\s+)?sorry to hear (?:that|it)\b/i;

/** Words too common to count as giving the caller's own words back. */
const FUNCTION_WORDS = new Set(
  (
    'the and for but you your yours our its it\'s i\'m i\'ve i\'ll that this with have has had need needs what where when how who why ' +
    'can could would will just are was were there they them from into about been not don\'t won\'t can\'t yes yeah okay hello please ' +
    'thanks some any all get got out off now here she him her his let like really very also then than'
  ).split(' '),
);

/** Curly quotes, as transcripts write "can't", made plain. */
const plainQuotes = (text: string) => text.replace(/[\p{Pi}\p{Pf}]/gu, "'");

/** Where a clause ends: a comma or a stop, or a dash between words (the hyphen in "I-95" is not one). */
const CLAUSE_END = /[.,!?;:]|(?!-)\p{Pd}|\s-\s/u;

/** Words as heard: case and punctuation ignored; "can't", "I-95" and "mm-hm" stay one word each. */
function wordsOf(text: string): string[] {
  return plainQuotes(text.toLowerCase())
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((word) => word.replace(/^['-]+|['-]+$/g, '').replace(/'s$/, ''))
    .filter(Boolean);
}

/**
 * True if `reply` opens the way a person acknowledges what was just said: a
 * short ack ("Okay.", "Got it, ...") or, in three words or fewer, a word the
 * caller used ("A Civic, got it.", "Exit 42.").
 */
export function startsWithAck(reply: string, callerLine: string): boolean {
  const text = plainQuotes(reply).trim();
  if (ACK_OPENER.test(text) || EMPATHY_OPENER.test(text)) return true;
  const end = text.search(CLAUSE_END);
  // A question first is not an acknowledgement, whatever its words.
  if (end !== -1 && text[end] === '?') return false;
  const words = wordsOf(end === -1 ? text : text.slice(0, end));
  if (words.length === 0 || words.length > 3) return false;
  const said = new Set(wordsOf(callerLine).filter((word) => /\d/.test(word) || (word.length >= 3 && !FUNCTION_WORDS.has(word))));
  return words.some((word) => said.has(word));
}

/** True if a sentence asks about something on the intake list. */
const asksIntake = (sentence: string) => questionsIn(sentence).some((q) => q.topics.length > 0);

/**
 * Where the first intake question in `text` begins, or -1. Found by clause,
 * since "Sorry about that, I'm listening, where are you?" is one sentence
 * whose apology still comes before its question.
 */
function intakeQuestionAt(text: string): number {
  for (const sentence of text.matchAll(/[^.!?]*\?/g)) {
    if (!asksIntake(sentence[0])) continue;
    let offset = sentence.index ?? 0;
    for (const clause of sentence[0].split(/(?<=[,;:]|(?!-)\p{Pd}|\s-\s)/u)) {
      if (asksIntake(`${clause.replace(/[\s,;:?\p{Pd}]+$/u, '')}?`)) return offset;
      offset += clause.length;
    }
    return sentence.index ?? 0;
  }
  return -1;
}

/** The read-back: every detail at once, so it is long by design. */
const isReadBack = (reply: string) => questionsIn(reply).some((q) => q.topics.includes('details'));

export function scoreRun(scenario: Scenario, run: RunRecord): Failure[] {
  const failures: Failure[] = [];
  const fail = (category: FailureCategory, source: FailureSource, detail: string, soft = false) =>
    failures.push({ category, source, detail, ...(soft ? { soft } : {}) });
  const final = run.finalContext;
  const values = final.values as Record<string, unknown>;
  const allReplies = run.turns.flatMap((t) => t.replies);

  // Replies are scored as heard, so a reply the gateway stopped is cut or
  // gone from them; that it had to be stopped is still worth knowing.
  for (const event of run.events) {
    if (event.type !== 'AI_RESPONSE') continue;
    const line = event.payload as { text?: string; stopped?: string | null };
    if (line.stopped === 'redirected' || line.stopped === 'guardrail') {
      fail('STOPPED_REPLY', 'response', `turn ${event.turn}: stopped (${line.stopped}): "${line.text ?? ''}"`, true);
    }
  }

  for (const error of run.errors) fail('TOOL_CALL_FAILURE', 'tool', error);
  for (const op of run.ops) {
    if (typeof op.output.error === 'string') fail('TOOL_CALL_FAILURE', 'tool', op.output.error);
  }
  if (run.turns.length < scenario.lines.length) fail('EXTRACTION_FAILURE', 'model', `only ${run.turns.length}/${scenario.lines.length} turns completed`);

  for (const reply of allReplies) {
    const verdict = checkReply(reply);
    const codes = verdict.ok ? [] : verdict.violations.map((v) => v.code).filter((c) => c !== 'too_long');
    if (codes.length > 0) fail('GUARDRAIL_BROKEN', 'response', `${codes.join(', ')}: "${reply}"`);
  }

  // ---- Repetition ----
  // Callers hear a receptionist that says the same thing twice as broken,
  // whether it is the same sentence in two turns or two replies to one turn.
  const heard = new Map<string, number>();
  run.turns.forEach((turn, index) => {
    for (const sentence of turn.replies.flatMap(sentencesOf)) {
      const before = heard.get(sentence);
      if (before !== undefined) {
        fail('REPEATED_REPLY', 'response', `turn ${index + 1} repeated turn ${before + 1}: "${sentence}"`);
      } else {
        heard.set(sentence, index);
      }
    }
    const topics = questionsIn(turn.replies.join(' ')).flatMap((q) => q.topics);
    if (new Set(topics).size > 1) {
      fail('MULTIPLE_QUESTIONS', 'response', `turn ${index + 1} asked about ${[...new Set(topics)].join(' and ')}: "${turn.replies.join(' ')}"`);
    }
  });

  // ---- Human-ness ----
  // What a caller hears as a form rather than a person: form language, the
  // same opener every turn, a paragraph where a sentence would do, and a
  // detail met with the next question and no "Okay." first.
  run.turns.forEach((turn, index) => {
    for (const reply of turn.replies) {
      const robotic = ROBOTIC.exec(reply);
      if (robotic) fail('ROBOTIC_PHRASING', 'response', `turn ${index + 1} said "${robotic[0]}": "${reply}"`);
    }
    const said = turn.replies.filter((reply) => !isReadBack(reply)).join(' ');
    const count = wordsOf(said).length;
    if (count > OVERLONG_WORDS) fail('OVERLONG_REPLY', 'response', `turn ${index + 1}: ${count} words: "${said}"`);
  });

  // Consecutive replies, as the caller hears them: each turn's words together.
  // A one-word ack followed by different words ("Okay, where ..." then "Okay,
  // what ...") is how people talk; "Got it." twice running is a script.
  const spoken = run.turns
    .map((turn, index) => ({ turn: index + 1, opener: wordsOf(turn.replies.join(' ')).slice(0, 2) }))
    .filter((reply) => reply.opener.length > 0);
  spoken.forEach((reply, i) => {
    const before = spoken[i - 1];
    if (before && reply.opener.length === 2 && reply.opener.join(' ') === before.opener.join(' ')) {
      fail('REPEATED_OPENER', 'response', `turns ${before.turn} and ${reply.turn} both start "${reply.opener.join(' ')}"`);
    }
  });

  // A detail is a turn on which something new was saved. Where a scenario
  // requires the ack, it is checked with the turn expectations and fails.
  const ackRequired = new Set((scenario.turns ?? []).filter((t) => t.startsWithAck).map((t) => t.turn));
  let savedBefore = initialContext({ customerPhone: EVAL_CALLER }).values as Record<string, unknown>;
  run.turns.forEach((turn, index) => {
    const saved = turn.stateAfter.values as Record<string, unknown>;
    const before = savedBefore;
    const gaveDetail = [...new Set([...Object.keys(saved), ...Object.keys(before)])].some((key) => show(saved[key]) !== show(before[key]));
    savedBefore = saved;
    const text = turn.replies.join(' ');
    if (!gaveDetail || !text.trim() || ackRequired.has(index + 1)) return;
    if (!startsWithAck(text, turn.caller)) {
      fail('NO_ACK_AFTER_DETAIL', 'response', `turn ${index + 1}: "${turn.caller}" was met cold: "${text}"`, true);
    }
  });

  // ---- Fields ----
  let omitted = false;
  for (const [key, want] of Object.entries(scenario.fields ?? {})) {
    const value = values[key];
    const sent = everSent(run, key);
    const matches = (v: unknown) => (want instanceof RegExp ? typeof v === 'string' && want.test(v) : v === want);
    if (value === undefined) {
      omitted = true;
      if (sent.some(matches)) fail('STATE_MERGE_FAILURE', 'merge', `${key} was sent as ${show(sent)} but not saved`);
      else if (sent.length === 0) fail('FIELD_OMITTED', 'model', `${key} never saved`);
      else fail('WRONG_FIELD_VALUE', 'model', `${key} sent as ${show(sent)}`);
    } else if (!matches(value)) {
      fail('WRONG_FIELD_VALUE', 'model', `${key} = ${show(value)}`);
    }
  }

  for (const [key, rule] of Object.entries(scenario.specific ?? {})) {
    const value = values[key];
    const sent = everSent(run, key);
    if (typeof value === 'string' && rule.want.test(value)) continue;
    if (sent.some((v) => typeof v === 'string' && rule.want.test(v))) {
      fail('STATE_MERGE_FAILURE', 'merge', `${key}: specific value sent but saved as ${show(value)}`);
    } else if (value === undefined) {
      omitted = true;
      fail('FIELD_OMITTED', 'model', `${key} never saved`);
    } else {
      fail('WRONG_SPECIFICITY', 'model', `${key} saved as ${show(value)}`);
    }
  }

  if (scenario.locationStatus) {
    const status = classifyLocation(final.values.location, { knownAreas: EVAL_FACTS.serviceAreas }).status;
    if (final.values.location && status !== scenario.locationStatus) {
      fail('LOCATION_VALIDATION_FAILURE', 'validation', `"${final.values.location}" classified ${status}, expected ${scenario.locationStatus}`);
    }
  }

  // ---- Turn expectations ----
  for (const expectation of scenario.turns ?? []) {
    const turn = run.turns[expectation.turn - 1];
    if (!turn) continue;
    const text = turn.replies.join(' ');
    const topics = new Set(questionsIn(text).flatMap((q) => q.topics));
    const gaveSafety = SAFETY_ADVICE.test(text);

    if (expectation.action && !omitted) {
      // The caller turn the state was left on: the latest on which anything was
      // asked. Without it, what was asked on this turn would count as asked before.
      const callerTurn = Math.max(0, ...Object.values(turn.stateAfter.asked ?? {}).map((asked) => asked.turn));
      const action = determineNextAction(turn.stateAfter, { emergencyNumber: '911', knownAreas: EVAL_FACTS.serviceAreas, callerTurn }).action;
      // Before the fix the backend has no safety step; judge the step after it.
      const acceptable = new Set(expectation.action);
      if (!acceptable.has(action)) fail('WRONG_NEXT_ACTION', 'priority', `turn ${expectation.turn}: backend chose ${action}`);
    }

    if (expectation.ask) {
      const askedRight = expectation.ask.some((t) => topics.has(t)) || (expectation.allowSafety && gaveSafety);
      if (!askedRight) fail('RESPONSE_DID_NOT_FOLLOW_ACTION', 'response', `turn ${expectation.turn}: did not ask about ${expectation.ask.join('/')}: "${text}"`);
    }
    const forbidden = (expectation.forbid ?? []).filter((t) => topics.has(t));
    if (forbidden.length > 0) {
      fail('RESPONSE_DID_NOT_FOLLOW_ACTION', 'response', `turn ${expectation.turn}: asked about ${forbidden.join(', ')}: "${text}"`);
    }
    if (expectation.understood && MISUNDERSTOOD.test(text)) {
      fail('CONVERSATION_FAILURE', 'response', `turn ${expectation.turn}: said it did not understand: "${text}"`);
    }
    if (expectation.mention && !expectation.mention.test(text)) {
      fail('CONVERSATION_FAILURE', 'response', `turn ${expectation.turn}: "${text}"`);
    }
    if (expectation.notMention?.test(text)) {
      fail('CONVERSATION_FAILURE', 'response', `turn ${expectation.turn}: should not have said this: "${text}"`);
    }

    // A person answers what they were asked, then carries on: the answer must
    // come before any intake question, not after it or inside it.
    if (expectation.needsReply) {
      // Same length either way, so a position in one is a position in the other.
      const answeredAt = plainQuotes(text).search(expectation.needsReply);
      const askedAt = intakeQuestionAt(text);
      if (answeredAt === -1) {
        fail('IGNORED_CALLER', 'response', `turn ${expectation.turn}: "${turn.caller}" got no reply: "${text}"`);
      } else if (askedAt !== -1 && answeredAt >= askedAt) {
        fail('IGNORED_CALLER', 'response', `turn ${expectation.turn}: asked the next question before replying to "${turn.caller}": "${text}"`);
      }
    }
    if (expectation.noIntakeQuestion && topics.size > 0) {
      fail('IGNORED_CALLER', 'response', `turn ${expectation.turn}: asked about ${[...topics].join(', ')} instead of replying to "${turn.caller}": "${text}"`);
    }
    if (expectation.startsWithAck && !startsWithAck(text, turn.caller)) {
      fail('NO_ACK_AFTER_DETAIL', 'response', `turn ${expectation.turn}: "${turn.caller}" was met cold: "${text}"`);
    }
  }

  // ---- Confirmation ----
  if (scenario.leadCreated !== undefined) {
    const created = run.leadCreatedAtTurn !== null;
    if (scenario.leadCreated && !created) fail('EXTRACTION_FAILURE', 'model', 'no lead was created');
    if (created) {
      const readBackTurn = run.turns.findIndex((t) => questionsIn(t.replies.join(' ')).some((q) => q.topics.includes('details'))) + 1;
      if (readBackTurn === 0 || run.leadCreatedAtTurn! <= readBackTurn) {
        fail('PREMATURE_CONFIRMATION', 'backend', `lead created at turn ${run.leadCreatedAtTurn} but the read-back was ${readBackTurn ? `at turn ${readBackTurn}` : 'never asked'}`);
      }
    }
  }
  if (scenario.phoneNotConfirmed && final.phoneConfirmed) {
    fail('PREMATURE_CONFIRMATION', 'backend', 'callback number marked confirmed though the caller was never asked');
  }

  // ---- Safety, urgency, provenance ----
  if (scenario.safetyBy) {
    const text = run.turns.slice(0, scenario.safetyBy).flatMap((t) => t.replies).join(' ');
    if (!SAFETY_ADVICE.test(text)) fail('SAFETY_MISSED', 'priority', `no emergency advice by turn ${scenario.safetyBy}: "${text}"`);
  }
  if (scenario.urgencyHigh && final.urgency?.level !== 'high') fail('URGENCY_MISSED', 'priority', 'lead not marked urgent');
  if (scenario.inferredMake && final.values.vehicleMake && final.fieldSources?.vehicleMake !== 'inferred') {
    fail('INFERENCE_UNTAGGED', 'tool', `make "${final.values.vehicleMake}" was never said but is not tagged inferred`);
  }
  if (scenario.garbledField) {
    const key = scenario.garbledField;
    const lastTurn = run.turns.at(-1);
    const accepted = final.values[key] !== undefined && final.fieldSources?.[key] !== 'unsure';
    const checked = lastTurn ? questionsIn(lastTurn.replies.join(' ')).some((q) => q.topics.includes('movable')) : false;
    if (accepted && !checked) fail('GUESSED_UNCLEAR_SPEECH', 'model', `${key} accepted from garbled speech without checking`);
  }

  return failures;
}
