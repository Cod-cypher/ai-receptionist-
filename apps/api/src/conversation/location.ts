/**
 * Is a location precise enough for a tow driver to find the vehicle?
 *
 * Decided in code rather than by the model, because gpt-realtime-mini was seen
 * to accept "I-95" and move on. The rules are ordered: anything that pins a
 * spot down (a numbered exit, an address, an intersection, a landmark) wins
 * over anything vague that appears alongside it, so "I-95 near exit 42" is
 * complete while "I-95 near the exit" is not.
 *
 * Unrecognised text counts as complete. A named place the rules do not know
 * ("Liberty Market") is usually a real landmark, and nagging a stranded caller
 * about a place they have already named is worse than an occasional follow-up
 * call from the driver.
 *
 * With TypeSafe Jev configured, `assessLocation` lets its judgment overrule
 * these rules; they remain the fallback and the eval's oracle.
 */

import { LOCATION_CONFIDENCE_FLOOR } from '../integrations/judgment/typesafe-questions';
import type { ConversationContext } from './types';

export type LocationStatus = 'missing' | 'partial' | 'complete';

export interface LocationAssessment {
  status: LocationStatus;
  /** Which rule decided, for logs and tests. */
  reason: string;
  /** The road or street mentioned, to ask "where on I-95?". */
  road: string | null;
}

export interface LocationOptions {
  /** Areas the business serves. A bare area name is too vague to dispatch to. */
  knownAreas?: readonly string[];
}

const SUFFIX =
  'street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|parkway|pkwy|highway|hwy|expressway|freeway|circle|cir|terrace|trail|trl|pike|square|sq';

/** Numbered roads: I-95, Interstate 85, US-75, Highway 10, Route 66, M25. */
const NUMBERED_ROAD =
  /\b(?:interstate|i|us|u\.s\.|sr|state route|route|rte|hwy|highway|freeway|motorway|expressway|turnpike|fm|county road|cr)[- ]?\d{1,4}[a-z]?\b|\b[man]\d{1,4}\b/i;
const GENERIC_ROAD = /\b(?:highway|interstate|freeway|motorway|expressway|turnpike|beltway|toll ?road|main road)\b/i;
const NUMBERED_REFERENCE =
  /\b(?:exit|junction|jct|mile ?marker|mm|marker|milepost|mile|km|kilometer|kilometre)\s*(?:number|no\.?|#)?\s*\d+[a-z]?\b|\b\d+[a-z]?\s*(?:mile ?marker|milepost)\b/i;
const ADDRESS = new RegExp(`\\b\\d{1,6}[a-z]?\\s+(?:[a-z0-9.'-]+\\s+){0,4}(?:${SUFFIX})\\b`, 'i');
const STREET = new RegExp(`\\b(?:[a-z0-9.'-]+\\s+){1,3}(?:${SUFFIX})\\b`, 'i');
const COORDINATES = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/;
const INTERSECTION_WORDS = /\b(?:corner of|intersection of|junction of|crossing of)\b/i;
const LANDMARK =
  /\b(?:gas station|petrol station|service station|truck stop|rest (?:area|stop)|travel (?:center|centre|plaza)|walmart|target|costco|home depot|lowe'?s|mcdonald'?s|starbucks|shell|exxon|chevron|texaco|love'?s|pilot|flying j|buc-?ee'?s|qt|quiktrip|7-eleven|mall|market|plaza|shopping cent(?:er|re)|hotel|motel|church|mosque|temple|school|university|college|hospital|clinic|stadium|airport|station|park|bridge|tunnel|toll (?:booth|plaza)|parking (?:lot|garage)|garage|restaurant|diner|store|shop|bank|office|warehouse|depot|terminal|dealership)\b/i;
const LANDMARK_PREPOSITION =
  /\b(?:near|next to|in front of|outside(?: of)?|behind|opposite|across (?:the street )?from|beside|close to|just (?:past|before|after)|by)\s+(?:the\s+|a\s+|an\s+)?([a-z0-9'&.-]+)/i;
/** Words that make a landmark phrase meaningless: "near the exit". */
const VAGUE_TARGET =
  /^(?:exit|exits|highway|interstate|freeway|road|street|city|town|shoulder|ramp|area|place|middle|side|intersection|light|lights|traffic|here|there|downtown)$/i;
const VAGUE =
  /\b(?:somewhere|downtown|in town|the city|middle of nowhere|out here|around here|not sure|no idea|don'?t know|side of the road|shoulder|off ?ramp|on ?ramp|on the road)\b/i;
const HEDGE = /\b(?:somewhere|not sure|no idea|don'?t know|i think|roughly)\b/i;

function roadIn(text: string): string | null {
  return (
    text.match(NUMBERED_ROAD)?.[0] ??
    (GENERIC_ROAD.test(text) ? `the ${text.match(GENERIC_ROAD)![0].toLowerCase()}` : null) ??
    text.match(STREET)?.[0]?.trim() ??
    null
  );
}

function isKnownArea(text: string, areas: readonly string[]): boolean {
  const bare = text
    .toLowerCase()
    .replace(/\b(?:in|near|around|outside(?: of)?|by|close to|the|somewhere)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return areas.some((area) => area.toLowerCase().trim() === bare);
}

interface Rule {
  name: string;
  status: Exclude<LocationStatus, 'missing'>;
  test: (text: string, options: LocationOptions) => boolean;
}

/** Ordered: the first matching rule decides. Add rules here to extend. */
export const LOCATION_RULES: Rule[] = [
  { name: 'coordinates', status: 'complete', test: (t) => COORDINATES.test(t) },
  { name: 'numbered exit or marker', status: 'complete', test: (t) => NUMBERED_REFERENCE.test(t) },
  { name: 'street address', status: 'complete', test: (t) => ADDRESS.test(t) },
  {
    name: 'intersection',
    status: 'complete',
    test: (t) => {
      if (INTERSECTION_WORDS.test(t)) return true;
      const parts = t.split(/\s+(?:and|&|at)\s+/i).filter((p) => p.trim().length > 0);
      return parts.length >= 2 && parts.some((p) => STREET.test(p) || NUMBERED_ROAD.test(p)) && parts.every((p) => !VAGUE.test(p));
    },
  },
  { name: 'named landmark', status: 'complete', test: (t) => LANDMARK.test(t) },
  {
    name: 'near a specific place',
    status: 'complete',
    test: (t, o) => {
      if (HEDGE.test(t)) return false;
      const target = t.match(LANDMARK_PREPOSITION)?.[1];
      if (!target || VAGUE_TARGET.test(target) || NUMBERED_ROAD.test(target)) return false;
      return !isKnownArea(target, o.knownAreas ?? []);
    },
  },
  { name: 'road without a point on it', status: 'partial', test: (t) => NUMBERED_ROAD.test(t) || GENERIC_ROAD.test(t) },
  { name: 'street without a number or cross street', status: 'partial', test: (t) => STREET.test(t) },
  { name: 'vague area', status: 'partial', test: (t, o) => VAGUE.test(t) || isKnownArea(t, o.knownAreas ?? []) },
  // "Dakolani": one word, no digits, nothing the rules recognise. On a real call
  // it was a misheard neighbourhood name, saved and never questioned.
  { name: 'single unrecognised word', status: 'partial', test: (t) => /^[a-z'-]+$/i.test(t.trim()) },
];

export function classifyLocation(
  location: string | null | undefined,
  options: LocationOptions = {},
): LocationAssessment {
  const text = (location ?? '').trim();
  if (!text) return { status: 'missing', reason: 'no location', road: null };

  for (const rule of LOCATION_RULES) {
    if (rule.test(text, options)) return { status: rule.status, reason: rule.name, road: roadIn(text) };
  }
  return { status: 'complete', reason: 'treated as a specific place', road: roadIn(text) };
}

/**
 * The call's saved location: Jev's judgment when it was made about exactly
 * this text and the model was sure enough, otherwise the rules above. Jev
 * can overrule the rules both ways: "Dakolani" is judged too vague, and a
 * landmark the rules do not know is judged precise.
 */
export function assessLocation(ctx: ConversationContext, options: LocationOptions = {}): LocationAssessment {
  const text = (ctx.values.location ?? '').trim();
  const judged = ctx.judgments?.location;
  if (text && judged && judged.text === ctx.values.location && judged.confidence >= LOCATION_CONFIDENCE_FLOOR) {
    return {
      status: judged.status,
      reason: `judged ${judged.status} (confidence ${judged.confidence.toFixed(2)})`,
      road: roadIn(text),
    };
  }
  return classifyLocation(ctx.values.location, options);
}

/**
 * A later detail that only makes sense on the road already given ("exit 42"
 * after "I-95") is combined with it, so the lead says "I-95, exit 42".
 */
export function refineLocation(previous: string | undefined, next: string): string {
  if (!previous) return next;
  const before = classifyLocation(previous);
  if (before.status !== 'partial' || !before.road) return next;
  if (roadIn(next) || next.toLowerCase().includes(previous.toLowerCase())) return next;
  return `${previous}, ${next}`;
}
