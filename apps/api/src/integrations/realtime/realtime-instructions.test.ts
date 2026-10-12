import { describe, expect, it } from 'vitest';

import { checkReply } from '../../conversation/guardrails';
import { ETA_ANSWER, PRICE_ANSWER } from '../../conversation/ready-answers';
import { buildReceptionistInstructions } from './realtime-instructions';

describe('the receptionist\'s instructions', () => {
  const FACTS = {
    name: 'Liberty Towing',
    phone: null,
    website: null,
    address: null,
    serviceAreas: ['Dallas'],
    services: ['Local towing'],
    businessHoursText: null,
    isOpenNow: true,
    pricingInfo: null,
    emergencyContact: null,
    faq: [],
    tone: 'friendly' as const,
    businessInstructions: null,
  };
  const instructions = buildReceptionistInstructions({ facts: FACTS, callerNumber: '+18174098408' });

  it('state the three rules for a caller\'s question, word for word', () => {
    expect(instructions).toContain('1. If the caller asks a question, answer that question before continuing the current intake or confirmation step.');
    expect(instructions).toContain('2. Never repeat an intake question or confirmation merely because the caller asked an unrelated question.');
    expect(instructions).toContain('3. After answering, resume the previous step from its current state.');
    expect(instructions.indexOf('WHEN THE CALLER ASKS SOMETHING')).toBeLessThan(instructions.indexOf('CAPTURE RULES'));
  });

  it('give a ready answer to "how soon" and "how much" that needs no lookup', () => {
    expect(instructions).toContain(`say "${ETA_ANSWER}"`);
    expect(instructions).toContain(`say "${PRICE_ANSWER}"`);
    expect(instructions).toContain('with NO tool call');
  });

  it('have a configured price looked up, since that is what allows a price to be spoken', () => {
    const priced = buildReceptionistInstructions({ facts: { ...FACTS, pricingInfo: 'Local tows start at $95.' }, callerNumber: null });
    expect(priced).not.toContain(PRICE_ANSWER);
    expect(priced).toContain('topic "pricing"');
    // The price itself is never in the prompt: it comes from the lookup.
    expect(priced).not.toContain('$95');
  });

  it('forbid making up what the receptionist cannot know', () => {
    expect(instructions).toContain('make up a live fact you cannot check, such as the weather');
    expect(instructions).toContain('Small talk and simple general questions you answer normally');
    expect(instructions).toContain('Say you did not catch something only when the audio was unclear');
    // The model copies sample phrases: this one came back as the reply to "The sun rises."
    expect(instructions).not.toContain("Sorry, I didn't catch that - is it a car");
  });

  it('show what to do with a yes to the number question', () => {
    expect(instructions).toContain('Caller: "Yes." (after you asked whether the number they are calling from is the best one to reach them)');
    expect(instructions).toContain('callerIdConfirmed true and nothing else');
  });

  it('tell the model the caller hears every word, so it never thinks aloud', () => {
    expect(instructions).toContain('think aloud about your instructions, your tools, the call state or what to do next');
  });

  it('promise nothing the guardrails would stop the receptionist from saying', () => {
    expect(checkReply(ETA_ANSWER)).toEqual({ ok: true });
    expect(checkReply(PRICE_ANSWER)).toEqual({ ok: true });
  });
});
