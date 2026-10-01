/**
 * Which operations get a judgment, and about what.
 *
 * What the model is about to save is judged as the text that will be saved
 * (after the same validation and refinement `applyIntake` performs), so
 * "exit 42" after "I-95" is judged as "I-95, exit 42". A location is judged
 * for precision; a problem saved as the help needed ("won't start") is judged
 * for which help that is. A line the caller spoke is judged for danger,
 * urgency and what the caller is doing with it, and, where it applies, for
 * whether it answers the pending question and what help it asks for. Nothing
 * else is judged: a state request, a silence tick or a completion carries
 * nothing new to read.
 *
 * Never throws and never blocks longer than the judge's own timeout: with no
 * judgment, `applyIntake` decides by its rules.
 */

import type { CallJudge, CallJudgments, JudgmentAsked, PendingQuestion } from '../integrations/judgment/judgment.interface';
import { NoopJudge } from '../integrations/judgment/noop.judge';
import { summariseJudgments } from '../integrations/judgment/judgment-summary';
import { previewLocation, previewProblemAsService, type IntakeOperation } from './intake';
import { readBack } from './next-action';
import type { ConversationContext } from './types';

export interface JudgeForOptions {
  knownAreas?: readonly string[];
  defaultRegionPrefix?: string;
}

/** The question the caller is being asked right now, if any, as they heard it. */
export function pendingQuestion(ctx: ConversationContext): PendingQuestion | undefined {
  const pending = ctx.pendingConfirmation;
  if (!pending) return undefined;
  if (pending.kind === 'details') {
    if (pending.fieldVersion !== (ctx.fieldVersion ?? 0)) return undefined;
    return { kind: 'details', question: 'Are these details correct?', readBack: readBack(ctx) };
  }
  if (!ctx.values.customerPhone) return undefined;
  return { kind: 'callback_number', question: `Is ${ctx.values.customerPhone}, the number you are calling from, the best number to reach you?` };
}

export async function judgeFor(
  judge: CallJudge,
  ctx: ConversationContext,
  op: IntakeOperation,
  options: JudgeForOptions = {},
): Promise<CallJudgments> {
  return (await judgeForTraced(judge, ctx, op, options)).judgments;
}

/**
 * `judgeFor`, and each question it put to the judge: what about, how long
 * it took and what came back, for the call's event trail. Nothing is
 * listed when the judge is the rules-only one.
 */
export async function judgeForTraced(
  judge: CallJudge,
  ctx: ConversationContext,
  op: IntakeOperation,
  options: JudgeForOptions = {},
): Promise<{ judgments: CallJudgments; asked: JudgmentAsked[] }> {
  const asked: JudgmentAsked[] = [];
  const traced = !(judge instanceof NoopJudge);
  const ask = async (about: JudgmentAsked['about'], text: string, call: () => Promise<CallJudgments | null>) => {
    const started = Date.now();
    let result: CallJudgments | null = null;
    try {
      result = await call();
    } finally {
      if (traced) asked.push({ about, text, ms: Date.now() - started, found: result ? summariseJudgments(result) : [] });
    }
    return result;
  };

  try {
    if (op.kind === 'update') {
      const location = previewLocation(ctx, op, options.defaultRegionPrefix);
      const problem = previewProblemAsService(op);
      // Two requests side by side: the wait is the longer of the two, not their sum.
      const [aboutLocation, aboutService] = await Promise.all([
        location ? ask('location', location, () => judge.judgeLocation(location, options.knownAreas ?? [])) : null,
        problem
          ? ask('service', problem, () => judge.judgeService(problem, { problem: ctx.values.vehicleCondition, location: location ?? ctx.values.location }))
          : null,
      ]);
      return { judgments: { ...(aboutLocation ?? {}), ...(aboutService ?? {}) }, asked };
    }
    if (op.kind === 'caller_speech') {
      const spoken = op.text.trim();
      if (!spoken) return { judgments: {}, asked };
      const pending = pendingQuestion(ctx);
      const judged = await ask('speech', spoken, () =>
        judge.judgeSpeech(spoken, {
          ...(ctx.values.location ? { location: ctx.values.location } : {}),
          ...(ctx.values.vehicleCondition ? { problem: ctx.values.vehicleCondition } : {}),
          ...(pending ? { pending } : {}),
          ...(ctx.values.serviceType ? {} : { serviceMissing: true }),
        }),
      );
      return { judgments: judged ?? {}, asked };
    }
    return { judgments: {}, asked };
  } catch {
    return { judgments: {}, asked };
  }
}
