/**
 * Instructions for the two kinds of gpt-realtime-mini response.
 *
 * Extraction reuses the exact prompt every other provider gets, so switching
 * VOICE_PIPELINE changes who listens, not what they are asked to report.
 */

import type { ReceptionistTone } from '@towai/shared';

import {
  buildExtractionSystemPrompt,
  type ExtractionPromptInput,
} from '../../conversation/prompt-builder';
import { REPORT_TOOL_NAME } from './realtime-extraction';

/**
 * `previousHeard` is what the model reported last turn. Tested on a live call,
 * a turn with no intelligible speech was reported as a verbatim repeat of the
 * caller's previous words, so the model is told exactly what not to repeat.
 */
export function buildRealtimeExtractionInstructions(
  input: ExtractionPromptInput,
  previousHeard: string | null = null,
): string {
  const repeat = previousHeard
    ? `
You already reported the caller saying: "${previousHeard}". Do not report those words again. Report only what the caller said after them. If there is nothing new, report intent "unclear" with an empty "heard".`
    : '';

  return `${buildExtractionSystemPrompt(input)}

Call ${REPORT_TOOL_NAME} exactly once, covering only the caller's most recent audio. Do not reply to the caller in words. If you did not hear anything intelligible, report intent "unclear" with an empty "heard". Never fill "heard" with earlier words.${repeat}`;
}

const TONE: Record<ReceptionistTone, string> = {
  professional: 'professional and efficient',
  friendly: 'warm and friendly, without being chatty',
  calm: 'calm and reassuring',
};

/**
 * `exact` is the fallback used after a guardrail trips: no smoothing at all.
 */
export function buildSpeakInstructions(tone: ReceptionistTone, exact = false): string {
  const wording = exact
    ? 'Say the line word for word. Change nothing.'
    : 'You may smooth the wording slightly so it sounds natural spoken aloud, but keep every fact exactly as given.';

  return `You are the voice of a telephone receptionist for a towing company: ${TONE[tone]}. Callers are often stranded and stressed.

You will be given one line. Speak that line and nothing else. ${wording}
Add nothing. Answer nothing. Ask nothing that is not in the line. Never mention prices, arrival times, or a truck being sent unless the line itself says so. Never say you are an AI.`;
}
