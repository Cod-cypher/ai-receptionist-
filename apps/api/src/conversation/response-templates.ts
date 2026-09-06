/**
 * Deterministic phrasing for every directive.
 *
 * Two jobs, both important:
 *
 * 1. The fallback whenever generation fails, times out, or trips a guardrail.
 *    A call must never go silent because a model was slow, so every directive
 *    has a sentence here that is safe to say without any model at all.
 * 2. The behaviour of the stub provider, which is what the test suite and
 *    offline development run against.
 *
 * The wording follows the product's voice rules: short, plain, no technical
 * language, no promises about price, time, or dispatch.
 */

import type { Directive, SummaryLine } from './types';

export interface TemplateContext {
  businessName: string;
  /** Used to personalise once the name is known. */
  customerName?: string;
  greeting?: string | null;
}

function summaryToSentence(summary: SummaryLine[]): string {
  if (summary.length === 0) return 'the details you have given me';
  return summary.map((line) => `${line.label.toLowerCase()} ${line.value}`).join(', ');
}

/** The line spoken after an FAQ answer or an apology, to resume the intake. */
function continuationSentence(directive: Directive): string {
  if (directive.kind !== 'ANSWER_FAQ' && directive.kind !== 'CANNOT_ANSWER') return '';
  const then = directive.then;

  if (then.kind === 'ask') return ` ${then.requirement.fallbackPhrasing}`;
  if (then.kind === 'summary') {
    return ` Let me read your details back: ${summaryToSentence(then.summary)}. Is that all correct?`;
  }
  return '';
}

export function renderTemplate(directive: Directive, ctx: TemplateContext): string {
  const name = ctx.customerName ? `, ${ctx.customerName}` : '';

  switch (directive.kind) {
    case 'GREET':
      return (
        ctx.greeting?.trim() ||
        `Thanks for calling ${ctx.businessName}. How can I help?`
      );

    case 'ASK':
      return directive.requirement.fallbackPhrasing;

    case 'REASK':
      // Re-asking verbatim sounds robotic, so the second attempt is framed as a
      // clarification rather than a repetition.
      return `Sorry, I didn't catch that. ${directive.requirement.fallbackPhrasing}`;

    case 'ASK_ALTERNATE_PHONE':
      return 'No problem. What number is best to reach you on?';

    case 'DID_NOT_UNDERSTAND':
      return directive.requirement
        ? `Sorry, I didn't quite get that. ${directive.requirement.fallbackPhrasing}`
        : "Sorry, I didn't quite get that. Could you say that again?";

    case 'PROMPT_AFTER_SILENCE':
      return directive.requirement
        ? `Are you still there? ${directive.requirement.fallbackPhrasing}`
        : 'Are you still there?';

    case 'ANSWER_FAQ':
      return `${directive.fact}${continuationSentence(directive)}`;

    case 'CANNOT_ANSWER':
      return (
        "I'm not able to confirm that, but I can have someone from the towing team " +
        `call you back about it.${continuationSentence(directive)}`
      );

    case 'CONFIRM_SUMMARY':
      return `Let me read that back${name}: ${summaryToSentence(directive.summary)}. Is that all correct?`;

    case 'ACKNOWLEDGE_CORRECTION':
      return directive.requirement
        ? `Sorry about that. ${directive.requirement.fallbackPhrasing}`
        : 'Sorry about that. What should I change?';

    case 'ESCALATE':
      return (
        "I'm not able to help with that myself, but I've made a note and someone " +
        'from the towing team will contact you shortly.'
      );

    case 'CLOSE':
      switch (directive.outcome) {
        case 'lead_created':
          return `Thanks${name}. I've recorded the details and the towing team will contact you shortly.`;
        case 'callback_created':
          return `Thanks${name}. Someone from the towing team will contact you shortly.`;
        default:
          return `Thanks for calling ${ctx.businessName}. Goodbye.`;
      }

    case 'SILENT_END':
      return '';

    default: {
      const exhaustive: never = directive;
      throw new Error(`No template for directive: ${JSON.stringify(exhaustive)}`);
    }
  }
}
