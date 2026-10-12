/**
 * What a line the caller spoke is, by its words alone: a detail to save, a
 * question to answer, a complaint, a check of the line, small talk, a line
 * cut off mid-sentence, or only a sound of listening.
 *
 * Cheap heuristics, no judge: the gateway uses this the moment the transcript
 * arrives, about 400 ms before the model's first audio, to tell the model in
 * the note what the caller just said and what kind of thing it is. The
 * contract that makes `toolChoice: 'none'` safe on a reply: a line that
 * carries ANY detail is `detail`, even if it also asks something.
 */

export type CallerWordsKind =
  | 'question'
  | 'complaint'
  | 'line_check'
  | 'small_talk'
  | 'unfinished'
  | 'backchannel'
  | 'asking_for_time'
  | 'detail'
  | 'unknown';

/** Kinds whose line the receptionist must reply to before anything else; none of them carries a detail. */
export const NEEDS_REPLY: readonly CallerWordsKind[] = ['question', 'complaint', 'line_check', 'small_talk', 'unfinished'];

/**
 * Words a caller says to show they are listening, not to take the floor.
 * Said while the receptionist is speaking, they need no reply.
 */
const BACKCHANNEL =
  /^(?:(?:ok(?:ay)?|yes|yeah|yep|yup|yea|mm+|m+hm+|mm-?hmm?|uh-?huh|right|sure|alright|all right|got it|i see|go ahead|go on|fine|cool|great|perfect|thanks|thank you|okay then|please)[,.!?\s]*)+$/i;

/** True if `text` is only acknowledgement words. */
export function isBackchannel(text: string): boolean {
  return BACKCHANNEL.test(text.trim());
}

/**
 * "Hello?", "are you there?": the caller checking the line is still open.
 * Once they have heard the receptionist speak, the check is answered.
 */
const PRESENCE_CHECK =
  /^(?:(?:hello|hallo|hi|hey|hey there|you there|are you there|anyone there|is anyone there|still there|are you still there|can you hear me|do you hear me)[,.!?\s]*)+$/i;

export function isPresenceCheck(text: string): boolean {
  return PRESENCE_CHECK.test(text.trim());
}

/**
 * "Hold on, let me find the exit number": the caller asking for time. A
 * stranded caller walking to a sign is quiet for longer than seven seconds,
 * and was checked on and then hung up on while doing what they were asked.
 */
const ASKING_FOR_TIME =
  /\b(?:hold on|hang on|one (?:sec(?:ond)?|moment|minute)|(?:just|give me|gimme) (?:a|one) (?:sec(?:ond)?|moment|minute|min)|bear with me|let me (?:check|look|see|find|get|go|ask|have a look)|i(?:'ll| will) (?:check|look|find out|have a look|go and)|wait (?:a|one) (?:sec(?:ond)?|moment|minute)|please wait|stand by)\b/i;

export function isAskingForTime(text: string): boolean {
  return ASKING_FOR_TIME.test(text);
}

/**
 * The kind of line `text` is. Placeholder until the classifier lands: it
 * knows the three kinds the helpers above already recognise and a plain
 * question; everything else is `unknown`, which asks nothing of the gateway.
 */
export function classifyCallerWords(text: string): CallerWordsKind {
  const line = text.trim();
  if (!line) return 'unknown';
  if (isBackchannel(line)) return 'backchannel';
  if (isPresenceCheck(line)) return 'line_check';
  if (isAskingForTime(line)) return 'asking_for_time';
  if (line.endsWith('?')) return 'question';
  return 'unknown';
}
