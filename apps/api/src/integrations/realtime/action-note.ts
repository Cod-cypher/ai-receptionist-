/**
 * The per-turn note: what is saved, what the caller just said, and the one
 * thing to do next. Pinned before each reply, decided by the backend's
 * priority engine. The model phrases the required action; it does not choose
 * it.
 *
 * The model obeys the last thing it reads. On the 12 Oct call the note said
 * "YOU DID NOT ANSWER THIS" above some 250 words of rules ending in the
 * required action, and the model did the action: a complaint and then two
 * questions went unanswered, and the caller hung up. So the note is short
 * (about 90 words without the read-back and the DO NOT ASK line, up to 110
 * where it also names the question after this one), in this order: the
 * state, one line of context, the required action, and LAST the rule for
 * what the caller just said.
 */

import type { IntakeSnapshot } from '../../conversation/intake';
import type { NextActionPlan, Topic } from '../../conversation/next-action';
import { NEEDS_REPLY, type CallerWordsKind } from './caller-words';
import { TOOL } from './realtime-tools';
import { renderReadBack, renderReadBackRest } from './spoken-lines';

export const TOPIC_LABEL: Record<Topic, string> = {
  safety: 'safety',
  service: 'what help they need',
  location: 'the location',
  vehicle: 'the vehicle',
  condition: 'what is wrong with the vehicle',
  movable: 'whether it can move',
  name: 'their name',
  callback_number: 'the callback number',
  details: 'reading the details back',
  destination: 'where to take the vehicle',
};

/** What the caller said on this turn, and what kind of thing it is, when the transcript is known before the reply. */
export interface CallerJustSaid {
  text: string;
  kind: CallerWordsKind;
}

export interface ActionNoteOptions {
  /**
   * The note is pinned when the caller's turn ends, before anything they just
   * said has been saved. The required action is therefore the one from before
   * their words; the model must save first and will then get a fresh note.
   */
  beforeSave?: boolean;
  /** What the model said in the response that called the tools, so it carries on rather than repeating it. */
  alreadySaid?: string;
  /** What the caller said while the receptionist was still speaking, and heard the rest of. */
  overlap?: string;
  /**
   * The caller's line, whose answer the backend has saved itself (a clear
   * yes the model had not acted on). Replaces the before-save rules: this
   * state does include what they just said.
   */
  answered?: string;
  /**
   * The caller's words on this turn, known before the reply. Replaces the
   * conditional before-save rules with one directive about these words.
   */
  callerJustSaid?: CallerJustSaid;
}

/**
 * Live facts only. Told to answer "How is the weather?" in one sentence, the
 * model said "The weather is clear right now." Told only not to make an
 * answer up, it met "how are you?" with "I'm here to help", and "what does a
 * car need to run?" with "I can't check that": the rule is for live facts, and
 * small talk is answered like a person (the small-talk directive says so).
 */
const NEVER_MAKE_UP = "Never make up a live fact like the weather; say you can't check it.";

/** Said mid-sentence, after an "If ...,": the fresh note that comes with the save's result says what to ask. */
const SAVE_FIRST = `save it with ${TOOL.UPDATE} first and say nothing until the result`;

/**
 * The quoted words are the transcriber's, not the caller's. On a real call
 * (5176f4be) it wrote "Kalimantan Malay is 73rd", the note quoted that, and
 * the model saved the text as the location and read it back. The model heard
 * the caller itself; the quote only tells it which line is meant.
 */
const ROUGH_TRANSCRIPT = "That's a rough transcript: save what you heard them say, in their words.";

/**
 * The first thing to ask, where the note also names the question after it
 * (`saveAndAsk`). "The next thing" would then read as either of the two.
 */
const ASK_REQUIRED = 'ask the REQUIRED ACTION question';

/**
 * Save the answer and ask the question after it in one reply
 * (`IntakeSnapshot.ifAnswered`). Told to save, say nothing and wait for a
 * second reply to ask with, the model kept callers waiting a median of two
 * seconds for every reply (real call 5176f4be). Always the note's last
 * sentence: the model does the last thing it reads, and says the quoted line
 * word for word. The save is named in it for the same reason: read last
 * without it, the line would be asked and nothing saved. It opens with "But"
 * where the sentence before it says to say nothing until the result, which
 * holds for every other detail. `alsoAsked` is for a line known to carry a
 * detail, which may ask something too.
 */
function saveAndAsk(sample: string, options: { but?: boolean; alsoAsked?: boolean } = {}): string {
  const say = options.alsoAsked ? 'say a short ack, answer anything it asked, and ask' : 'say a short ack and ask';
  return `${options.but ? 'But if' : 'If'} it answers your question: save it with ${TOOL.UPDATE} and, in the same reply, ${say}: "${sample}"`;
}

/**
 * Something the caller said that the receptionist's reply did not answer.
 * On a real call the caller asked "why do you keep cutting me off?" twice and
 * was asked "what kind of help do you need?" both times. Only sent when the
 * reply is known to have missed it: sent on a guess, it made the model answer
 * a question it had already answered. Placed just before the last line, as
 * the 12 Oct call showed one placed above the required action is skipped.
 */
const CALLER_SAID: Record<NonNullable<IntakeSnapshot['callerSaid']>['kind'], (text: string) => string> = {
  complaint: (text) =>
    `YOU DID NOT ANSWER THIS. The caller complained: "${text}". Unless they've moved on, start with a short apology and that you're listening; don't explain.`,
  question: (text) =>
    `YOU DID NOT ANSWER THIS. The caller asked: "${text}". Unless they've moved on, start by answering it in one sentence. ${NEVER_MAKE_UP}`,
  line_check: (text) => `YOU DID NOT ANSWER THIS. The caller checked the line: "${text}". Start by saying you can hear them.`,
};

/**
 * What follows the answer to the caller, in the live rule's own words. Mostly
 * a question; "ask the next thing" is the wrong instruction, read last, when
 * the next thing is the read-back, the safety advice or the goodbye.
 */
function nextThing(state: IntakeSnapshot): string {
  if (state.nextAction === 'CONFIRM_DETAILS') return 'read the details back';
  if (state.nextAction === 'AWAIT_CONFIRMATION' && state.readBack && state.readBackHeard !== undefined) return 'finish the read-back';
  if (state.nextAction === 'HANDLE_SAFETY') return 'give the safety advice';
  if (state.nextAction === 'CLOSE') return 'say goodbye';
  return 'ask the next thing';
}

/**
 * "Sorry, try to what?": the caller's own last words, so they can pick up
 * where they were cut off. The model says the samples it is given word for
 * word, and a fixed "try to what?" after "my car is at the" is nonsense.
 */
function finishQuestion(text: string): string {
  const words = text
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}'-]/gu, '').replace(/^[-']+|[-']+$/g, ''))
    .filter(Boolean);
  const tail = words.slice(-2);
  const first = tail[0];
  if (first === undefined) return 'Sorry, go on?';
  // The first word of the line loses its capital, unless it is "I"; later words keep theirs ("on I-95").
  if (words.length <= 2 && !/^I\b/.test(first)) tail[0] = first.charAt(0).toLowerCase() + first.slice(1);
  return `Sorry, ${tail.join(' ')} what?`;
}

/**
 * The directive for the caller's quoted words: specific, one or two
 * sentences, the last thing the model reads. The kinds that may carry an
 * answer the word lists missed ("Bob." to "what's your name?", "Yeah." to
 * "is this the best number?") are saved first while the state predates them:
 * told only to ask the next thing, the model would ask the question just
 * answered, from a state without the answer. With `followUp`, the line to
 * ask once that question is answered, those kinds end with `saveAndAsk`.
 */
function callerJustSaidRule(said: CallerJustSaid, then: string, beforeSave: boolean, followUp?: string): string {
  switch (said.kind) {
    case 'question':
      return `That's a question. Answer it in one sentence, then ${then}. ${NEVER_MAKE_UP}`;
    case 'complaint':
      return `That's a complaint. Say sorry in a few words and that you're listening, then ${then}. Don't explain.`;
    case 'line_check':
      return `They're checking the line. Say you can hear them, then ${then}.`;
    case 'small_talk':
      return `That's small talk. Answer it like a person, in a few words, then ${then}. ${NEVER_MAKE_UP}`;
    case 'unfinished':
      // The 12 Oct call: "Okay, so what happens if we try to" was met with "Where is the vehicle right now?".
      return `They were cut off mid-sentence. Ask them to finish, like: "${finishQuestion(said.text)}" Say only that: the REQUIRED ACTION question waits for your next reply.`;
    case 'asking_for_time':
      return "They asked for a moment. Say that's fine and wait; ask nothing.";
    case 'detail':
      // A detail that is not the answer ("I'm on I-95" to "what are you
      // driving?") changes what is asked next, so it still waits for the result.
      if (beforeSave && followUp) {
        return `${ROUGH_TRANSCRIPT} Save it with ${TOOL.UPDATE} first and say nothing until the result. ${saveAndAsk(followUp, { but: true, alsoAsked: true })}`;
      }
      // After a save the words are usually in the state already; a caller
      // who spoke while the tools ran may have said something that is not.
      return beforeSave
        ? `${ROUGH_TRANSCRIPT} Save it with ${TOOL.UPDATE} first and say nothing until the result. If it also asked something, answer that after the save.`
        : `If any of it isn't in CALL STATE yet, save that with ${TOOL.UPDATE} first. If it also asked something, answer that in one sentence; then ${then}.`;
    case 'backchannel':
      if (beforeSave && followUp) return `If it's only an acknowledgement, ${ASK_REQUIRED}. ${saveAndAsk(followUp)}`;
      return beforeSave ? `If it answers your last question, ${SAVE_FIRST}. If it's only an acknowledgement, ${then}.` : `Just an acknowledgement: ${then}.`;
    case 'unknown':
      if (beforeSave && followUp) {
        return `If it needs an answer, answer it in one sentence; then ${ASK_REQUIRED}. If it's a detail, ${SAVE_FIRST}. ${saveAndAsk(followUp, { but: true })}`;
      }
      return beforeSave
        ? `If it's a detail or answers your question, ${SAVE_FIRST}. If it needs an answer, answer it in one sentence; then ${then}.`
        : `If it needs an answer, answer it in one sentence; then ${then}.`;
  }
}

/**
 * What to do about the caller's words, as instructions for that one reply.
 *
 * The note says the same, and on a real call (07fd8ed3) it was not enough:
 * "How's your day going?" was asked four times, each time the note quoted it
 * and said to answer first, and three times the reply was the next intake
 * question. Instructions sent with a reply are the last thing the model reads
 * before it speaks, and the lines sent that way (greeting, read-back,
 * goodbye) are followed. Null when the words need no reply of their own, or
 * when what follows is a line said word for word (read-back, safety advice,
 * goodbye), which the note carries.
 */
export function replyInstructions(state: IntakeSnapshot, said: CallerJustSaid): string | null {
  if (!NEEDS_REPLY.includes(said.kind)) return null;
  const then = nextThing(state);
  if (then !== 'ask the next thing') return null;
  const lines = [`The caller just said: "${said.text}"`, callerJustSaidRule(said, then, false)];
  if (said.kind !== 'unfinished') {
    lines.push(`The next thing: ${state.ask}`, 'Start your reply with your answer to what they said. Two short sentences at most.');
  }
  return lines.join('\n');
}

/** A line this long that the word lists could not place is someone talking; shorter, it is more often an answer they missed ("Bob.", "A Corolla"). */
const REMARK_MIN_WORDS = 5;

/**
 * Instructions for the one reply to a line the word lists could not place
 * (`unknown`) and that is long enough to be someone talking. On a real call
 * (8b6ae0a9) "Okay, so you can only help me with my vehicle issues." was met
 * with "Where are you right now?", and "I want to talk about life" with a
 * note saved about it: the note said to answer if it needed an answer, and
 * the model went on with the form. Instructions sent with the reply are
 * followed where the note is not (`replyInstructions`). Tools stay allowed:
 * the line may hold a detail the lists missed. Null for any other line.
 */
export function remarkInstructions(state: IntakeSnapshot, said: CallerJustSaid): string | null {
  if (said.kind !== 'unknown' || said.text.trim().split(/\s+/).length < REMARK_MIN_WORDS) return null;
  if (nextThing(state) !== 'ask the next thing') return null;
  return [
    `The caller just said: "${said.text}"`,
    `If that gives a detail of the job, save it with ${TOOL.UPDATE} and say nothing until the result. Never save a remark about the caller or the call.`,
    "If it gives none, they're talking to you: reply to what they said, like a person would, in one short sentence. Don't brush it off, and don't tell them what you're there for.",
    `Then: ${state.ask}`,
    'If it gave no detail, start your reply with your answer to what they said. Two short sentences at most.',
  ].join('\n');
}

/**
 * The last line or two: what to do about what the caller just said.
 * `followUp` is the line to ask once the required question is answered, on
 * the first note of a turn only: the note after a save asks from a state
 * that has the answer in it.
 */
function liveRule(options: ActionNoteOptions, then: string, followUp?: string): string[] {
  if (options.answered) {
    return [`If they also gave another detail, save it with ${TOOL.UPDATE} first; otherwise ${then} now.`];
  }
  if (options.callerJustSaid) {
    // The transcript is known: one directive about these words, in place of
    // the conditional rules the model had to apply to audio it heard.
    return [
      `THE CALLER JUST SAID: "${options.callerJustSaid.text}"`,
      callerJustSaidRule(options.callerJustSaid, then, Boolean(options.beforeSave), followUp),
    ];
  }
  if (options.beforeSave && followUp) {
    return [
      `This state does not include anything from what the caller just said. Not a detail? Answer it in one sentence FIRST, then ${ASK_REQUIRED}.`,
      // Saving stays the rule for every detail, in the words it has below.
      // Only the answer to the question asked is saved and followed up in
      // one reply; any other detail changes what comes next, and waits for
      // the result.
      `ANY detail (a yes or no counts): save it with ${TOOL.UPDATE} first and say nothing until the result.`,
      saveAndAsk(followUp, { but: true }),
    ];
  }
  if (options.beforeSave) {
    return [
      // Told only "do the required action", the model met "How are you
      // doing?" with "Could you tell me what kind of help you need?".
      `This state does not include anything from what the caller just said. Not a detail? Answer it in one sentence FIRST, then ${then}.`,
      // The save rule is last, because the last line wins. When the answer
      // rule was last, a live check met "I need a tow. My name is Mike and my
      // semi truck broke down on I-95." with "Sorry about that. Where are you
      // right now?" and saved nothing. A question is no longer left to this
      // line: once the caller's words are known the note is pinned again
      // quoting them. A yes or no is an answer: on a real call "Yes." was
      // heard three times, nothing was saved, and the question was asked again.
      `ANY detail (a yes or no counts): save it with ${TOOL.UPDATE} first and say nothing until the result.`,
    ];
  }
  // After a save the note before it, with the rule to answer the caller, is
  // gone. On a real call "So how's the weather over there?" was taken for a
  // detail, nothing new was saved, and the reply asked "Is it a tow, a flat
  // tire, or something else?" as if nothing had been said.
  return [`If what they just said needs a reply, answer it in one sentence FIRST, then ${then}.`];
}

/**
 * The saved values. The number they are calling from is not shown until it is
 * confirmed: shown, the model copied the caller ID into update_call_information
 * on a turn with no detail at all (the 12 Oct call, turn 1: "Can you help
 * me?", then "Nothing new was saved", a round trip and a filler). The
 * read-back carries the digits itself.
 */
function savedLines(state: IntakeSnapshot): string[] {
  const v = state.collected;
  const vehicle = [v.vehicleMake, v.vehicleModel, v.vehicleType].filter(Boolean).join(' ');
  const saved = [
    v.serviceType && `Service: ${v.serviceType}`,
    v.location && `Location: ${v.location}${state.locationStatus === 'partial' ? ' (too vague)' : ''}`,
    vehicle && `Vehicle: ${vehicle}`,
    v.vehicleCondition && `Problem: ${v.vehicleCondition}`,
    typeof v.vehicleMovable === 'boolean' && `Can move: ${v.vehicleMovable ? 'yes' : 'no'}`,
    v.customerName && `Name: ${v.customerName}`,
    v.customerPhone &&
      `Callback number: ${state.phoneConfirmed ? `${v.customerPhone} (confirmed)` : "the number they're calling from (not confirmed yet)"}`,
    v.destination && `Destination: ${v.destination}`,
  ].filter((line): line is string => Boolean(line));
  return saved.length > 0 ? saved.map((s) => `- ${s}`) : ['- nothing saved yet'];
}

/**
 * The state note pinned before each reply. Built from the backend's snapshot,
 * so the model never has to work out priorities itself.
 */
export function buildActionNote(state: IntakeSnapshot, options: ActionNoteOptions = {}): string {
  const then = nextThing(state);
  const lines = ['CALL STATE', ...savedLines(state)];
  // Once. After that the model has said it; repeated, it is filler.
  if (state.acknowledgeUrgency) lines.push('The caller is in an urgent situation: acknowledge it briefly, once.');
  if (options.overlap) {
    // Heard, so never "I didn't catch that": on a real call "The sun rises."
    // was met with "Sorry, I didn't catch that". What to do about the words
    // themselves is the last line's job.
    lines.push(
      `The caller said "${options.overlap}" while you were still speaking, then heard you finish: you heard it, so never say you didn't catch it, and don't repeat what you said.`,
    );
  }
  if (options.alreadySaid) {
    // A question asked in the same breath as the save came before the
    // backend's next step: it is not to be asked again, nor followed by another.
    lines.push(
      /\?\s*$/.test(options.alreadySaid.trim())
        ? `You ALREADY SAID: "${options.alreadySaid}". That question came before the details were saved: don't ask it again or anything else until they answer.`
        : `You ALREADY SAID: "${options.alreadySaid}". Carry on; don't say it again in other words.`,
    );
  }
  if (options.answered) {
    lines.push(`The caller said "${options.answered}", and that answer to your question is saved: don't ask it again.`);
  }

  lines.push('', `REQUIRED ACTION: ${state.nextAction}`, state.ask);
  if (state.readBack && state.readBackHeard !== undefined) {
    // The rest of a read-back the caller spoke over, word for word: handed
    // the whole list, the model starts again from the caller's name.
    lines.push(`To finish the read-back, say exactly: "${renderReadBackRest(state.readBack, state.readBackHeard)}"`);
  } else if (state.readBack) {
    // Word for word, as after a tool call. Given a list, the model phrased the
    // read-back itself on a real call and read the number as "+18174098408".
    lines.push(`To read the details back, say exactly: "${renderReadBack(state.readBack)}"`);
  }
  if (state.doNotAsk.length > 0) lines.push(`DO NOT ASK ABOUT: ${state.doNotAsk.map((t) => TOPIC_LABEL[t]).join(', ')}`);

  lines.push('');
  // An unanswered line from an earlier turn, unless it is the very line quoted last.
  const quoted = options.answered ? undefined : options.callerJustSaid?.text;
  if (state.callerSaid && state.callerSaid.text !== quoted) lines.push(CALLER_SAID[state.callerSaid.kind](state.callerSaid.text));
  // Named only where a question is what comes next, and only before the save.
  const followUp = options.beforeSave && then === 'ask the next thing' ? state.ifAnswered?.sample : undefined;
  lines.push(...liveRule(options, then, followUp));
  return lines.join('\n');
}

/** After a reply was stopped for asking about something that has to wait. */
export function redirectNote(asked: Topic, plan: NextActionPlan, heard = ''): string {
  // Told "the caller did not hear it" after they had heard most of it, the
  // model asked something new as if nothing had been said. A topic already
  // settled is not "to wait": the caller has answered it.
  const why = plan.settled.includes(asked)
    ? `${TOPIC_LABEL[asked]} is already settled, so do not ask about it again`
    : `${TOPIC_LABEL[asked]} has to wait`;
  const lines = [
    heard
      ? `The caller heard you begin "${heard}" before you were stopped: ${why}. Don't finish that question.`
      : `Your last question was stopped before the caller heard it: ${why}.`,
    `REQUIRED ACTION: ${plan.action}`,
    plan.ask,
  ];
  if (plan.action === 'CONFIRM_DETAILS' && plan.summary) lines.push(`To read the details back, say exactly: "${renderReadBack(plan.summary)}"`);
  return lines.join('\n');
}
