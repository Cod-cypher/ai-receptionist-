/**
 * Post-generation checks on anything the receptionist is about to say.
 *
 * The state machine controls *what* the receptionist talks about; this controls
 * what it is allowed to claim. A model asked to sound helpful will happily
 * invent a price or promise a truck in twenty minutes, and on a phone call there
 * is no undo — the caller has already heard it and the operator inherits the
 * complaint. Anything that trips a rule here is replaced with a deterministic
 * template rather than spoken.
 */

export type ViolationCode =
  | 'ai_self_reference'
  | 'price_claim'
  | 'free_service_claim'
  | 'arrival_time_promise'
  | 'dispatch_promise'
  | 'guarantee'
  | 'too_long';

export interface Violation {
  code: ViolationCode;
  detail: string;
}

export type GuardrailResult =
  | { ok: true }
  | { ok: false; violations: Violation[] };

export interface GuardrailOptions {
  /**
   * True only when the engine is relaying a pricing fact that exists in the
   * business's configuration. Everything else is priced by a human.
   */
  allowPricing?: boolean;
  /** Voice replies should be a sentence or two; anything longer is a red flag. */
  maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 400;

interface Rule {
  code: ViolationCode;
  pattern: RegExp;
  detail: string;
  /** Skipped when the engine has explicitly allowed pricing talk. */
  pricingRelated?: boolean;
}

const RULES: Rule[] = [
  {
    code: 'ai_self_reference',
    pattern: /\b(?:as an?\s+(?:ai|artificial intelligence|language model|virtual assistant)|i(?:'m| am)\s+an?\s+(?:ai|artificial intelligence|automated|virtual)\b)/i,
    detail: 'refers to itself as an AI',
  },
  {
    code: 'price_claim',
    pattern:
      /(?:[$£€₹]|\b(?:pkr|usd|gbp|eur|inr|aed|sar|rs\.?)\s*)\s*[\d,]+(?:\.\d+)?|\b[\d,]+(?:\.\d+)?\s*(?:rupees?|dollars?|pounds?|euros?)\b/i,
    detail: 'states a price',
    pricingRelated: true,
  },
  {
    code: 'free_service_claim',
    pattern: /\b(?:free of charge|no charge|at no cost|it(?:'s| is) free|won(?:'t| not) cost)\b/i,
    detail: 'claims the service is free',
    pricingRelated: true,
  },
  {
    // Either order: "arrive within 20 minutes" or "in 20 minutes we'll be there".
    code: 'arrival_time_promise',
    pattern:
      /\b(?:arrive|arriving|be there|get there|reach you|on (?:the|his|her|their) way|on site|on-site)\b[^.?!]{0,50}\b(?:\d+\s*(?:min|mins|minutes?|hours?|hrs?)|shortly|soon|right away|straight away|immediately|within)\b|\b(?:\d+\s*(?:min|mins|minutes?|hours?|hrs?)|shortly|soon|right away|straight away|immediately)\b[^.?!]{0,50}\b(?:arrive|arriving|be there|get there|reach you|on (?:the|his|her|their) way)\b/i,
    detail: 'promises an arrival time',
  },
  {
    code: 'dispatch_promise',
    pattern:
      /\b(?:i(?:'ve| have)?\s*(?:just\s*)?(?:sent|dispatched|assigned|booked|scheduled)|i(?:'m| am)\s*(?:sending|dispatching|assigning|booking)|(?:a|the)\s+(?:truck|driver|tow truck)\s+(?:is|will be)\s+(?:on (?:the|its) way|dispatched|sent))/i,
    detail: 'claims a truck or driver has been dispatched',
  },
  {
    code: 'guarantee',
    pattern: /\b(?:i guarantee|we guarantee|guaranteed|i promise|we promise|definitely will)\b/i,
    detail: 'makes a guarantee the business has not authorised',
  },
];

export function checkReply(
  reply: string,
  options: GuardrailOptions = {},
): GuardrailResult {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const violations: Violation[] = [];

  for (const rule of RULES) {
    if (rule.pricingRelated && options.allowPricing) continue;
    if (rule.pattern.test(reply)) {
      violations.push({ code: rule.code, detail: rule.detail });
    }
  }

  if (reply.length > maxLength) {
    violations.push({
      code: 'too_long',
      detail: `reply is ${reply.length} characters; the limit is ${maxLength}`,
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
