/**
 * Turns an FAQ topic into a fact drawn from the business's stored configuration.
 *
 * This is the mechanism behind "the AI must only provide information that exists
 * in the company's configured data". The model classifies the question into a
 * closed topic set; this resolver decides whether anything is configured for
 * that topic and hands back the exact text. When nothing is configured the
 * caller gets a callback instead of an invented answer.
 *
 * ETA is deliberately unanswerable regardless of configuration: arrival time is
 * a dispatch decision, and a receptionist that guesses it costs the operator a
 * complaint.
 */

import type { BusinessFacts, FaqTopic } from '@towai/shared';

export type FaqResolution =
  | { resolved: true; fact: string }
  | { resolved: false; reason: string };

/** Words worth matching an "other" question against the configured FAQ list. */
function keywordOverlap(question: string, candidate: string): number {
  const stop = new Set([
    'the', 'a', 'an', 'is', 'are', 'do', 'does', 'you', 'your', 'i', 'me', 'my',
    'we', 'can', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'it', 'that',
    'this', 'have', 'has', 'with', 'what', 'how', 'when', 'where', 'any',
  ]);
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stop.has(w)),
    );

  const q = tokens(question);
  const c = tokens(candidate);
  if (q.size === 0 || c.size === 0) return 0;

  let hits = 0;
  for (const w of q) if (c.has(w)) hits += 1;
  return hits / q.size;
}

/** Minimum overlap before a configured FAQ entry is considered a match. */
const FAQ_MATCH_THRESHOLD = 0.34;

export function resolveFaq(
  topic: FaqTopic | null,
  question: string,
  facts: BusinessFacts,
): FaqResolution {
  // A configured FAQ entry is the most specific answer available and outranks
  // the structured fields, whatever the topic classification said.
  const best = facts.faq
    .map((entry) => ({ entry, score: keywordOverlap(question, entry.question) }))
    .sort((a, b) => b.score - a.score)[0];

  if (best && best.score >= FAQ_MATCH_THRESHOLD) {
    return { resolved: true, fact: best.entry.answer };
  }

  switch (topic) {
    case 'hours': {
      if (facts.businessHoursText === null) {
        return { resolved: false, reason: 'business hours are not configured' };
      }
      const openness =
        facts.isOpenNow === null
          ? ''
          : facts.isOpenNow
            ? ' The business is open right now.'
            : ' The business is closed right now.';
      return {
        resolved: true,
        fact: `Opening hours: ${facts.businessHoursText}.${openness}`,
      };
    }

    case 'service_area': {
      if (facts.serviceAreas.length === 0) {
        return { resolved: false, reason: 'service areas are not configured' };
      }
      return {
        resolved: true,
        fact: `Areas covered: ${facts.serviceAreas.join(', ')}.`,
      };
    }

    case 'services_offered': {
      if (facts.services.length === 0) {
        return { resolved: false, reason: 'no services are configured' };
      }
      return {
        resolved: true,
        fact: `Services offered: ${facts.services.join(', ')}.`,
      };
    }

    case 'pricing': {
      if (!facts.pricingInfo) {
        return { resolved: false, reason: 'pricing information is not configured' };
      }
      return { resolved: true, fact: `Pricing information: ${facts.pricingInfo}` };
    }

    case 'contact_details': {
      const bits: string[] = [];
      if (facts.phone) bits.push(`phone ${facts.phone}`);
      if (facts.website) bits.push(`website ${facts.website}`);
      if (facts.address) bits.push(`address ${facts.address}`);
      if (bits.length === 0) {
        return { resolved: false, reason: 'contact details are not configured' };
      }
      return { resolved: true, fact: `Contact details: ${bits.join(', ')}.` };
    }

    case 'eta':
      // Never answerable. Arrival time depends on truck availability, which the
      // receptionist has no visibility into and must not guess at.
      return {
        resolved: false,
        reason: 'arrival times are a dispatch decision the receptionist cannot make',
      };

    case 'other':
    case null:
    default:
      return { resolved: false, reason: 'no configured information covers this question' };
  }
}
