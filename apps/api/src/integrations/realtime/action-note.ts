/**
 * The per-turn note: what is saved, what the caller just said, and the one
 * thing to do next. Pinned before each reply, decided by the backend's
 * priority engine. The model phrases the required action; it does not choose
 * it.
 *
 * The model obeys the last thing it reads. The note is therefore short, and
 * the rule it must apply live comes last.
 */

import type { IntakeSnapshot } from '../../conversation/intake';
import type { NextActionPlan, Topic } from '../../conversation/next-action';
import type { CallerWordsKind } from './caller-words';
import { TOOL } from './realtime-tools';
import { renderReadBack, renderReadBackRest } from './spoken-lines';

export const TOPIC_LABEL: Record<Topic, string> = {
  safety: 'safety',
  service: 'what help they need',
  location: 'the location',
  vehicle: 'the vehicle',
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
 * With every instruction to answer. Told to answer "How is the weather?" in
 * one sentence, the model said "The weather is clear right now." Told only
 * not to make an answer up, it met "how are you?" three times with "I'm here
 * to help", and "what does a car need to run?" with "I can't check that".
 */
const NEVER_MAKE_UP =
  'Small talk gets a normal, friendly answer ("I\'m well, thanks."), and a simple general question a short, plain one. Only a live fact you cannot check, such as the weather or traffic, you say you can\'t check: never make one up.';

/**
 * Something the caller said that the receptionist's reply did not answer.
 * On a real call the caller asked "why do you keep cutting me off?" twice and
 * was asked "what kind of help do you need?" both times. Only sent when the
 * reply is known to have missed it: sent on a guess, it made the model answer
 * a question it had already answered.
 */
const CALLER_SAID: Record<NonNullable<IntakeSnapshot['callerSaid']>['kind'], (text: string) => string> = {
  complaint: (text) =>
    `YOU DID NOT ANSWER THIS. The caller complained: "${text}". Unless what they have just said makes it beside the point, begin this reply with a short apology and that you are listening. Do not explain or defend. Then do the required action.`,
  question: (text) =>
    `YOU DID NOT ANSWER THIS. The caller asked: "${text}". Unless what they have just said makes it beside the point, begin this reply by answering it in one short sentence. ${NEVER_MAKE_UP} Then do the required action.`,
  line_check: (text) =>
    `YOU DID NOT ANSWER THIS. The caller checked the line: "${text}". Begin this reply by telling them you can hear them. Then do the required action.`,
};

/** One directive per kind of line, said after the caller's quoted words. */
const CALLER_JUST_SAID: Record<CallerWordsKind, string> = {
  question: `That is a question: answer it in one short sentence, then do the REQUIRED ACTION below. ${NEVER_MAKE_UP}`,
  complaint: 'That is a complaint: a short apology and that you are listening, then do the REQUIRED ACTION below. Do not explain or defend.',
  line_check: 'They are checking the line: tell them you can hear them, then do the REQUIRED ACTION below.',
  small_talk: `That is small talk: answer it like a person, in a few words, then do the REQUIRED ACTION below. ${NEVER_MAKE_UP}`,
  unfinished: 'They were cut off mid-sentence: ask them to finish what they were saying. Ask nothing else.',
  backchannel: 'That is only an acknowledgement: do the REQUIRED ACTION below.',
  asking_for_time: 'They are asking for a moment: say that is fine, and wait. Ask nothing.',
  detail: `That is a detail: call ${TOOL.UPDATE} with it first, saying nothing until the result. If it also asked something, answer that after the save.`,
  unknown: `If it needs a reply, answer it in one short sentence, then do the REQUIRED ACTION below. ${NEVER_MAKE_UP}`,
};

/**
 * The state note pinned before each reply. Built from the backend's snapshot,
 * so the model never has to work out priorities itself.
 */
export function buildActionNote(state: IntakeSnapshot, options: ActionNoteOptions = {}): string {
  const v = state.collected;
  const vehicle = [v.vehicleMake, v.vehicleModel, v.vehicleType].filter(Boolean).join(' ');
  const saved = [
    v.serviceType && `Service: ${v.serviceType}`,
    v.location && `Location: ${v.location}${state.locationStatus === 'partial' ? ' (not precise enough yet)' : ''}`,
    vehicle && `Vehicle: ${vehicle}`,
    v.vehicleCondition && `Problem: ${v.vehicleCondition}`,
    typeof v.vehicleMovable === 'boolean' && `Can move: ${v.vehicleMovable ? 'yes' : 'no'}`,
    v.customerName && `Name: ${v.customerName}`,
    v.customerPhone && `Callback number: ${v.customerPhone} (${state.phoneConfirmed ? 'confirmed' : 'not confirmed yet'})`,
    v.destination && `Destination: ${v.destination}`,
  ].filter((line): line is string => Boolean(line));

  const lines = [
    'CALL STATE',
    ...(saved.length > 0 ? saved.map((s) => `- ${s}`) : ['- nothing saved yet']),
    // Once. After that the model has said it; repeated, it is filler.
    ...(state.acknowledgeUrgency ? ['The caller is in an urgent situation: acknowledge it briefly, once.'] : []),
  ];
  if (options.overlap) {
    lines.push(
      '',
      `The caller said "${options.overlap}" while you were still speaking, and then heard the rest of what you said. If it answered your question, act on it. If it was a question or a complaint, answer it first, in one short sentence. If it was only an acknowledgement, do not repeat what you said: just do the required action, briefly. If it was anything else, reply to it briefly, as a person would: you heard it, so do not say you did not catch it.`,
    );
  }
  if (options.alreadySaid) {
    // A question asked in the same breath as the save came before the
    // backend's next step: it is not to be asked again, nor followed by another.
    const asked = /\?\s*$/.test(options.alreadySaid.trim())
      ? ' That question came before the details were saved: do not ask it again, and if the caller has not answered it yet, wait for their answer before asking anything else.'
      : '';
    lines.push('', `You ALREADY SAID: "${options.alreadySaid}". Carry on from there. Do not say it again in other words.${asked}`);
  }
  if (options.answered) {
    lines.push(
      '',
      `The caller said "${options.answered}", and that answer to your question is saved in the state above. Do not ask that question again.`,
      `- If they also gave another detail: call ${TOOL.UPDATE} with it first. Otherwise do the REQUIRED ACTION below now.`,
    );
  } else if (options.callerJustSaid) {
    // The transcript is known: one directive about these words, in place of
    // the conditional rules the model had to apply to audio it heard.
    lines.push('', `THE CALLER JUST SAID: "${options.callerJustSaid.text}"`, CALLER_JUST_SAID[options.callerJustSaid.kind]);
  } else if (options.beforeSave) {
    lines.push(
      '',
      'This state does not include anything from what the caller just said.',
      `- If they gave ANY detail: call ${TOOL.UPDATE} with it now, saying nothing or at most a few words. Ask nothing yet; you will then get a fresh CALL STATE and reply to that.`,
      // This is the last thing the model reads before it speaks. When it said
      // only "do the required action", "How are you doing?" was answered with
      // "Could you tell me what kind of help you need?".
      `- If they asked or said something that is not a detail (a question, "how are you", "can you hear me", a complaint): ANSWER THAT FIRST, in one short sentence. ${NEVER_MAKE_UP} Then do the REQUIRED ACTION below, in the same reply.`,
      '- If they answered your last question with yes or no, that is an answer: act on it. Do not ask the same thing again.',
      '- Only if they said nothing that needs a reply: do the REQUIRED ACTION below.',
    );
  } else {
    // After a save the note before it, with the rule to answer the caller,
    // is gone. On a real call "So how's the weather over there?" was taken
    // for a detail, nothing new was saved, and the reply asked "Is it a tow,
    // a flat tire, or something else?" as if nothing had been said.
    lines.push(
      '',
      `If what the caller just said also needs a reply (a question, a complaint, small talk), answer that first, in one short sentence. ${NEVER_MAKE_UP} Then do the REQUIRED ACTION below.`,
    );
  }
  // An unanswered line from an earlier turn, unless it is the very line quoted above.
  if (state.callerSaid && state.callerSaid.text !== options.callerJustSaid?.text) {
    lines.push('', CALLER_SAID[state.callerSaid.kind](state.callerSaid.text));
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
  const stopped = heard
    ? `The caller heard you begin "${heard}" before you were stopped: ${why}. Do not finish that question.`
    : `Your last question was stopped before the caller heard it: ${why}.`;
  const readBack = plan.action === 'CONFIRM_DETAILS' && plan.summary ? ` To read the details back, say exactly: "${renderReadBack(plan.summary)}"` : '';
  return `${stopped} REQUIRED ACTION: ${plan.action}. ${plan.ask}${readBack}`;
}
