/**
 * Which operations get a judgment, and about what.
 *
 * A location the model is about to save is judged as the text that will be
 * saved (after the same validation and refinement `applyIntake` performs),
 * so "exit 42" after "I-95" is judged as "I-95, exit 42". A line the caller
 * spoke is judged for danger and urgency. Nothing else is judged: a state
 * request, a silence tick or a completion carries nothing new to read.
 *
 * Never throws and never blocks longer than the judge's own timeout: with no
 * judgment, `applyIntake` decides by its rules.
 */

import type { CallJudge, CallJudgments } from '../integrations/judgment/judgment.interface';
import { previewLocation, type IntakeOperation } from './intake';
import type { ConversationContext } from './types';

export interface JudgeForOptions {
  knownAreas?: readonly string[];
  defaultRegionPrefix?: string;
}

export async function judgeFor(
  judge: CallJudge,
  ctx: ConversationContext,
  op: IntakeOperation,
  options: JudgeForOptions = {},
): Promise<CallJudgments> {
  try {
    if (op.kind === 'update') {
      const text = previewLocation(ctx, op, options.defaultRegionPrefix);
      if (!text) return {};
      return (await judge.judgeLocation(text, options.knownAreas ?? [])) ?? {};
    }
    if (op.kind === 'caller_speech') {
      const spoken = op.text.trim();
      if (!spoken) return {};
      return (await judge.judgeSpeech(spoken, ctx.values.location)) ?? {};
    }
    return {};
  } catch {
    return {};
  }
}
