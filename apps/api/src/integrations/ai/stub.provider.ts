/**
 * A deterministic AI provider.
 *
 * This is what the test suite and offline development run against, and it is
 * the default when no API key is configured. It does keyword matching rather
 * than language understanding, which is nowhere near good enough for a real
 * call — but it makes the whole pipeline (telephony to lead to WhatsApp)
 * exercisable with no network, no key, and no cost, and it keeps the tests
 * honest by never varying.
 */

import {
  EMPTY_EXTRACTION,
  type ExtractionResult,
  type FaqTopic,
} from '@towai/shared';

import { renderTemplate } from '../../conversation/response-templates';
import type {
  AiProvider,
  GenerateInput,
  UnderstandInput,
} from './ai-provider.interface';

const VEHICLE_MAKES = [
  'toyota', 'honda', 'suzuki', 'nissan', 'mazda', 'kia', 'hyundai', 'ford',
  'chevrolet', 'bmw', 'mercedes', 'audi', 'volkswagen', 'mitsubishi', 'daihatsu',
];

const VEHICLE_MODELS = [
  'corolla', 'civic', 'city', 'mehran', 'alto', 'cultus', 'swift', 'vitz',
  'yaris', 'accord', 'sportage', 'tucson', 'sentra', 'prado', 'hilux', 'ravi',
];

const VEHICLE_TYPES = [
  'car', 'suv', 'van', 'pickup', 'truck', 'motorcycle', 'motorbike', 'bike',
  'bus', 'sedan', 'hatchback', 'jeep',
];

const SERVICE_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(tow|towing|towed|breakdown|broke down|broken down)\b/, 'Vehicle towing'],
  [/\b(jump ?start|battery|dead battery)\b/, 'Jump start'],
  [/\b(flat|puncture|tyre|tire)\b/, 'Tire change'],
  [/\b(locked out|lockout|keys? (?:locked|inside))\b/, 'Lockout'],
  [/\b(out of fuel|no fuel|no petrol|ran out of (?:gas|petrol|fuel))\b/, 'Fuel delivery'],
  [/\b(accident|crash|collision)\b/, 'Accident recovery'],
];

const FAQ_TOPIC_PATTERNS: Array<[RegExp, FaqTopic]> = [
  [/\b(open|closed|hours|timing)\b/, 'hours'],
  [/\b(area|cover|reach|come to|service area)\b/, 'service_area'],
  [/\b(do you (?:do|provide|offer|have)|flatbed|motorcycle|services)\b/, 'services_offered'],
  [/\b(cost|price|charge|how much|rate|fee)\b/, 'pricing'],
  [/\b(address|website|phone number|located|where are you)\b/, 'contact_details'],
  [/\b(how (?:soon|long|quick)|when will|eta|arrive)\b/, 'eta'],
];

const OUT_OF_SCOPE = /\b(send (?:a )?truck now|dispatch|refund|discount|cancel my|my account|bill(?:ing)?|invoice|complaint|speak to (?:a )?manager)\b/;

function titleWord(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export class StubAiProvider implements AiProvider {
  readonly name = 'stub';

  async understand(input: UnderstandInput): Promise<ExtractionResult> {
    const text = input.transcript.trim();
    const lower = text.toLowerCase();
    const result: ExtractionResult = {
      ...EMPTY_EXTRACTION,
      slots: { ...EMPTY_EXTRACTION.slots },
    };

    if (text.length === 0) return result;

    // --- Intent ------------------------------------------------------------
    if (OUT_OF_SCOPE.test(lower)) {
      return { ...result, intent: 'out_of_scope', outOfScopeRequest: text };
    }

    if (/\b(bye|goodbye|that's all|thats all|nothing else|hang up)\b/.test(lower)) {
      return { ...result, intent: 'end_call' };
    }

    const isQuestion = text.endsWith('?') || /^(do|are|can|what|when|where|how|is)\b/.test(lower);
    const faqTopic = FAQ_TOPIC_PATTERNS.find(([re]) => re.test(lower))?.[1] ?? null;
    if (isQuestion && faqTopic) {
      return { ...result, intent: 'faq', faqQuestion: text, faqTopic };
    }

    // --- Slots -------------------------------------------------------------
    const slots = result.slots;

    const service = SERVICE_KEYWORDS.find(([re]) => re.test(lower))?.[1];
    if (service) slots.serviceType = service;

    const locationMatch = lower.match(
      /\b(?:at|near|on|outside|by|in front of)\s+(?:the\s+)?([a-z0-9][a-z0-9\s'-]{2,40}?)(?:[,.]|\s+(?:and|my|the car|it)\b|$)/,
    );
    if (locationMatch?.[1]) {
      slots.location = locationMatch[1].trim().split(' ').map(titleWord).join(' ');
    }

    const make = VEHICLE_MAKES.find((m) => new RegExp(`\\b${m}\\b`).test(lower));
    if (make) slots.vehicleMake = titleWord(make);

    const model = VEHICLE_MODELS.find((m) => new RegExp(`\\b${m}\\b`).test(lower));
    if (model) slots.vehicleModel = titleWord(model);

    if (!make && !model) {
      const type = VEHICLE_TYPES.find((t) => new RegExp(`\\b${t}\\b`).test(lower));
      if (type) slots.vehicleType = titleWord(type);
    }

    // Callers type and speak without apostrophes ("it cant move"), so the
    // movability and condition phrases are matched with them stripped.
    const plain = lower.replace(/['’]/g, '');

    if (
      /\b(cant move|cannot move|can not move|wont move|doesnt move|not moving|wont start|doesnt start|dead|stuck|immobile|needs to be towed|has to be towed)\b/.test(
        plain,
      )
    ) {
      slots.vehicleMovable = false;
    } else if (
      /\b(can (?:still )?(?:move|drive|be driven)|it drives|drivable|driveable|it moves|still runs)\b/.test(
        plain,
      )
    ) {
      slots.vehicleMovable = true;
    } else if (input.pendingRequirement === 'vehicleMovable') {
      // A bare "no" means nothing on its own, but it is a clear answer to
      // "is the vehicle able to move?". A real model reads that from the
      // question it was given; the stub has to be told.
      if (/^(no|nope|nah|not really|it cant|cant|needs a tow|towed)\b/.test(plain)) {
        slots.vehicleMovable = false;
      } else if (/^(yes|yeah|yep|it can|can)\b/.test(plain)) {
        slots.vehicleMovable = true;
      }
    }

    const conditionMatch = plain.match(
      /\b(wont start|doesnt start|broke down|broken down|flat tyre|flat tire|overheated|accident damage|smoking|leaking)\b/,
    );
    if (conditionMatch?.[1]) slots.vehicleCondition = conditionMatch[1];

    // "It's a Honda" must not make the caller's name Honda, so only explicit
    // introductions count, and "I'm" only before a capitalised word
    // (otherwise "I'm stuck" would name the caller Stuck).
    const nameMatch =
      text.match(/\bmy name is\s+([A-Za-z][a-z'-]{1,20})\b/i) ??
      text.match(/\b(?:I'?m|I am|this is)\s+([A-Z][a-z'-]{1,20})\b/);
    if (nameMatch?.[1]) {
      slots.customerName = nameMatch[1];
    } else if (
      input.pendingRequirement === 'customerName' &&
      /^[A-Za-z][a-z'-]{1,20}(?:\s+[A-Za-z][a-z'-]{1,20})?[.!]?$/.test(text)
    ) {
      slots.customerName = text.replace(/[.!]$/, '');
    }

    const phoneMatch = text.match(/(\+?\d[\d\s-]{7,16}\d)/);
    if (phoneMatch?.[1] && input.pendingRequirement === 'customerPhone') {
      slots.customerPhone = phoneMatch[1];
    }

    const anySlot = Object.values(slots).some((v) => v !== null);

    // --- Confirmation ------------------------------------------------------
    if (!anySlot) {
      if (/^(yes|yeah|yep|yup|correct|thats right|right|sure|ok|okay)\b/.test(plain)) {
        return { ...result, intent: 'confirm' };
      }
      if (/^(no|nope|nah|wrong|thats wrong|incorrect)\b/.test(plain)) {
        return { ...result, intent: 'deny' };
      }
      return { ...result, intent: 'unclear' };
    }

    return { ...result, intent: 'provide_info', slots };
  }

  async generateResponse(input: GenerateInput): Promise<string> {
    // The stub speaks the deterministic template verbatim. Using the same
    // wording the fallback would produce keeps test expectations stable.
    return renderTemplate(input.directive, {
      businessName: input.facts.name,
      customerName: input.customerName,
      greeting: null,
    });
  }
}
