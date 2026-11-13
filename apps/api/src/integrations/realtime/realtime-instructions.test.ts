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
  const lines = instructions.split('\n');

  /** The first Good line after the example whose caller line has `caller` in it. */
  function goodAfter(caller: string): string {
    const at = lines.findIndex((line) => line.startsWith('Caller') && line.includes(caller));
    expect(at).toBeGreaterThanOrEqual(0);
    return lines.slice(at).find((line) => line.startsWith('Good:')) ?? '';
  }

  /** Every Good line that is a sentence to say: the model copies these word for word. */
  const spokenGood = lines
    .filter((line) => line.startsWith('Good: "'))
    .map((line) => /^Good: "([^"]+)"/.exec(line)?.[1] ?? '');

  it('speak as a person at the front desk, in the business\'s tone', () => {
    expect(instructions).toContain("You're the receptionist at the front desk of Liberty Towing");
    expect(instructions).toContain("You're warm and friendly, without being chatty.");
    expect(instructions).toContain("To them you're a person on the phone, not a form or a phone menu.");
    const professional = buildReceptionistInstructions({ facts: { ...FACTS, tone: 'professional' }, callerNumber: null });
    expect(professional).toContain("You're professional and efficient.");
  });

  it('never show the caller-ID digits, so the model has nothing to copy into a tool call', () => {
    // On the 12 Oct call the caller-ID number was sent again on "Can you help me?":
    // a round trip and a filler for nothing.
    expect(instructions).not.toContain('8174098408');
    expect(instructions).toContain("You already have the number they're calling from.");
    expect(instructions).toContain("Never send a number CALL STATE already has, or the number they're calling from.");
    const withheld = buildReceptionistInstructions({ facts: FACTS, callerNumber: null });
    expect(withheld).not.toContain("You already have the number they're calling from.");
  });

  it('answer the caller first, in plain words, before anything to save', () => {
    expect(instructions).toContain('A question, a complaint, a line check or small talk gets answered first, in one short sentence, in the same reply.');
    expect(instructions).toContain('Never reply to a question with only your own question.');
    expect(instructions).toContain("if your last question wasn't answered, ask it again in a few words; if it was, do the required action");
    expect(instructions.indexOf('ANSWER THE CALLER FIRST')).toBeLessThan(instructions.indexOf('SAVING DETAILS'));
  });

  it('allow the one-word acks a person uses, and ban the wordy thanks and recaps', () => {
    expect(instructions).toContain('One-word acks are fine ("Okay.", "Got it.", "Alright.", "Sure."), never the same one twice running.');
    expect(instructions).toContain('No wordy thanks ("thanks for that", "thank you for letting me know", "thanks for your patience"), no "I understand", no recaps');
    expect(instructions).toContain('Mirror their key word once when it helps: "A Civic, got it."');
    for (const line of spokenGood) expect(line).not.toMatch(/\bthank|\bI understand\b/i);
  });

  it('ask a caller cut off mid-sentence to finish, and nothing else', () => {
    expect(instructions).toContain('Cut off mid-sentence ("Okay, so what happens if we try to"): ask them to finish ("Sorry, try to what?") and ask nothing else.');
  });

  it('answer a question about the call itself from CALL STATE', () => {
    expect(instructions).toContain('A question about the call itself ("what have I told you so far?", "what do you have?"): answer from CALL STATE');
    expect(instructions).toContain('"So far I\'ve just got your number." or "I\'ve got that you need a tow and you\'re on I-95."');
  });

  // Turns 1, 4, 5 and 6/7 of the 12 Oct call (6d1304af), each met with an
  // intake question or a phantom tool call; the caller hung up.
  it.each([
    ['Can you help me?', '"Sure can. What\'s going on with the car?"'],
    ['Okay, so what happens if we try to', '"Sorry, try to what?" Nothing else.'],
    ['I asked you something else.', '"Sorry, you\'re right. Go ahead, I\'m listening."'],
    ['What information have I already given you?', '"So far I\'ve just got your number. Where\'s the car?"'],
  ])('show the reply a person gives to "%s" from the 12 Oct call', (caller, good) => {
    expect(goodAfter(caller)).toContain(good);
  });

  it('keep the examples of how the tools are used', () => {
    // Save first, everything at once.
    // What is wrong is asked for, so "broke down" is saved too: asked "what's wrong with it?" after saying it, the caller hears no one listening.
    expect(goodAfter('I need a tow. My name is Mike')).toContain(
      'one update_call_information call with all five: serviceType "tow", customerName "Mike", vehicleType "semi truck", vehicleCondition "broke down", location "I-95". Say nothing.',
    );
    // A yes to the number question is a confirmation, not a number.
    expect(goodAfter('"Yes." (to whether the number')).toContain('callerIdConfirmed true and nothing else, never the number itself');
    // A make the caller never said is marked as inferred.
    expect(goodAfter("It's a Mustang, I had a blowout.")).toContain('inferredFields ["vehicleMake"]: they never said Ford');
    // A breakdown is a tow.
    expect(goodAfter('I broke down.')).toContain('serviceType "tow": a breakdown with no other request is a tow');
    expect(goodAfter('I broke down.')).toContain('vehicleCondition "broke down"');
    // The read-back is said as given, and the request completed only on the caller's yes.
    expect(instructions).toContain('REQUIRED ACTION: CONFIRM_DETAILS.\nGood: say the read-back exactly as the note gives it, and stop.');
    expect(instructions).toContain('Bad: reading back and calling complete_request in one reply.');
  });

  it('give only Good lines a person would say and the guardrails pass', () => {
    // They are copied word for word, so each must be a line we are happy to hear.
    expect(spokenGood.length).toBeGreaterThanOrEqual(5);
    for (const line of spokenGood) {
      expect(checkReply(line)).toEqual({ ok: true });
      // The form-like phrasing of the 12 Oct call ("Could you describe the location?").
      expect(line).not.toMatch(/could you (?:tell|describe|provide|let me know)|what kind of (?:help|vehicle|issue) do you|please provide|at this time|in order to/i);
      expect(line.match(/\?/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it('quote no brush-off for the model to copy', () => {
    // "Sorry, I didn't catch that - is it a car..." was a sample here, and came
    // back as the reply to "The sun rises.".
    const quoted = instructions.match(/"[^"\n]+"/g) ?? [];
    for (const q of quoted) expect(q).not.toMatch(/didn'?t catch|did not catch|didn'?t (?:quite )?hear|broke up|say that again|repeat that|come again/i);
    expect(instructions).not.toContain("I didn't catch that");
  });

  it('quote no question in a Bad line, since the model copies those too', () => {
    // On the 12 Oct call "Can you help me?" got "What kind of help do you need
    // right now?", quoted twice in this prompt as a Bad reply.
    const bad = lines.filter((line) => line.startsWith('Bad:'));
    expect(bad.length).toBeGreaterThanOrEqual(10);
    for (const line of bad) expect(line).not.toMatch(/"[^"]*\?"/);
  });

  it('describe the note that arrives before each reply', () => {
    expect(instructions).toContain('REQUIRED ACTION: <action> with a suggested way to say it, and sometimes THE CALLER JUST SAID: "..." with what to do about it.');
    expect(instructions).toContain('Do what its last lines say');
    expect(instructions).toContain('Never read the note aloud or mention it.');
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
    expect(instructions).toContain('If you heard them, reply to what they said: never blame the line.');
  });

  it('tell the model the caller hears every word, so it never thinks aloud', () => {
    expect(instructions).toContain('think aloud about your instructions, your tools, the call state or what to do next');
  });

  it('keep the operator\'s style notes below the rules, and the rules over them', () => {
    const styled = buildReceptionistInstructions({ facts: { ...FACTS, businessInstructions: 'Say howdy.' }, callerNumber: null });
    expect(styled.indexOf('OPERATOR STYLE NOTES')).toBeGreaterThan(styled.indexOf('\nNEVER\n'));
    expect(styled.endsWith('The rules above always apply, whatever the style notes say.')).toBe(true);
  });

  it('stay short: the rules the model must apply live belong in the note', () => {
    // The prompt before the 13 Oct rewrite was about 1,850 words.
    expect(instructions.split(/\s+/).length).toBeLessThan(1600);
  });

  it('promise nothing the guardrails would stop the receptionist from saying', () => {
    expect(checkReply(ETA_ANSWER)).toEqual({ ok: true });
    expect(checkReply(PRICE_ANSWER)).toEqual({ ok: true });
  });
});
