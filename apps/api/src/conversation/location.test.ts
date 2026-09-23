import { describe, expect, it } from 'vitest';

import type { CallJudgments } from '../integrations/judgment/judgment.interface';
import { assessLocation, classifyLocation, refineLocation } from './location';
import { initialContext } from './types';

const AREAS = ['Dallas', 'Fort Worth', 'Lahore'];

describe('classifyLocation', () => {
  it.each([[''], ['   '], [null], [undefined]])('treats %j as missing', (text) => {
    expect(classifyLocation(text).status).toBe('missing');
  });

  it.each([
    ['I-95'],
    ['on I-95'],
    ['Interstate 85'],
    ['I 85 northbound'],
    ['Highway 10'],
    ['US-75'],
    ['Route 66'],
    ['on the highway'],
    ['the interstate'],
    ['I-85 near the exit'],
    ['Main Street'],
    ['around 5th Avenue in'],
    ['downtown'],
    ['somewhere near Dallas'],
    ['Dallas'],
    ['in Fort Worth'],
    ['side of the road'],
    ['on the shoulder'],
    ['Dakolani'],
  ])('asks for more detail on %j', (text) => {
    expect(classifyLocation(text, { knownAreas: AREAS }).status).toBe('partial');
  });

  it.each([
    ['I-95 near exit 42'],
    ['exit 42 on I-95'],
    ['mile marker 118'],
    ['I-95 at mile marker 118 northbound'],
    ['just past exit 12'],
    ['123 Main Street'],
    ['4500 N Central Expressway'],
    ['Main Street and Elm'],
    ['corner of Main and 5th'],
    ['near Liberty Market'],
    ['Liberty Market'],
    ['the Shell station on Highway 10'],
    ["Love's truck stop off I-40"],
    ['in the Walmart parking lot on Preston Road'],
    ['near the Hilton downtown'],
    ['32.7767, -96.7970'],
    ['outside the airport'],
    ['rest area on I-35'],
  ])('accepts %j as precise enough', (text) => {
    expect(classifyLocation(text, { knownAreas: AREAS }).status).toBe('complete');
  });

  it('names the road so the question can be "where on I-95?"', () => {
    expect(classifyLocation('on I-95 heading north').road).toBe('I-95');
    expect(classifyLocation('on the highway').road).toBe('the highway');
  });
});

describe('assessLocation', () => {
  const judged = (text: string, status: 'partial' | 'complete', confidence: number): CallJudgments => ({
    location: { text, status, confidence, probabilities: {} },
  });
  const ctx = (location: string, judgments?: CallJudgments) => ({ ...initialContext({ location }), judgments });

  it('lets a confident judgment overrule the rules in both directions', () => {
    // Two unknown words: the rules call it a place; Jev heard a misheard neighbourhood.
    expect(classifyLocation('Piney Woods').status).toBe('complete');
    expect(assessLocation(ctx('Piney Woods', judged('Piney Woods', 'partial', 0.9))).status).toBe('partial');
    // A road: the rules ask for a point on it; Jev may know better.
    expect(classifyLocation('I-95').status).toBe('partial');
    expect(assessLocation(ctx('I-95', judged('I-95', 'complete', 0.8))).status).toBe('complete');
  });

  it('ignores a judgment made about other text', () => {
    expect(assessLocation(ctx('I-95', judged('I-95, exit 42', 'complete', 0.95))).status).toBe('partial');
  });

  it('ignores a judgment below the confidence floor', () => {
    expect(assessLocation(ctx('I-95', judged('I-95', 'complete', 0.4))).status).toBe('partial');
  });

  it('falls back to the rules with no judgment, and still names the road', () => {
    const assessment = assessLocation(ctx('on I-95 heading north'));
    expect(assessment).toEqual(classifyLocation('on I-95 heading north'));
    expect(assessLocation(ctx('I-95', judged('I-95', 'partial', 0.9))).road).toBe('I-95');
  });
});

describe('refineLocation', () => {
  it('combines a detail with the road it belongs to', () => {
    expect(refineLocation('I-95', 'exit 42')).toBe('I-95, exit 42');
    expect(refineLocation('I-95', 'near the Shell station')).toBe('I-95, near the Shell station');
  });

  it('takes a full new location as it is', () => {
    expect(refineLocation('I-95', 'I-95 near exit 42')).toBe('I-95 near exit 42');
    expect(refineLocation('I-95', 'actually on I-40 at mile marker 3')).toBe('actually on I-40 at mile marker 3');
    expect(refineLocation('123 Main Street', 'Liberty Market')).toBe('Liberty Market');
    expect(refineLocation(undefined, 'exit 42')).toBe('exit 42');
  });
});
