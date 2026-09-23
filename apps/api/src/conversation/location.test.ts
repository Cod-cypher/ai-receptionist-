import { describe, expect, it } from 'vitest';

import { classifyLocation, refineLocation } from './location';

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
