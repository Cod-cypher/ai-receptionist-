import { describe, expect, it } from 'vitest';
import { checkReply } from './guardrails';

/** Assert a reply is blocked, and blocked for the expected reason. */
function expectBlocked(reply: string, code: string, options = {}) {
  const result = checkReply(reply, options);
  expect(result.ok, `expected "${reply}" to be blocked`).toBe(false);
  if (result.ok) return;
  expect(result.violations.map((v) => v.code)).toContain(code);
}

function expectAllowed(reply: string, options = {}) {
  const result = checkReply(reply, options);
  if (!result.ok) {
    throw new Error(
      `expected "${reply}" to pass, blocked for: ${result.violations
        .map((v) => v.code)
        .join(', ')}`,
    );
  }
}

describe('guardrails', () => {
  it('allows the ordinary replies the receptionist actually makes', () => {
    expectAllowed("Sure, I can help with that. What's your current location?");
    expectAllowed('Got it. What type of vehicle are you driving?');
    expectAllowed('Is the vehicle able to move, or does it need to be towed?');
    expectAllowed(
      "Thanks, Ahmed. I've recorded the details and the towing team will contact you shortly.",
    );
    expectAllowed(
      "I'm not able to confirm that, but I can have someone from the towing team call you back.",
    );
    expectAllowed('We cover Lahore, Gulberg, DHA and Model Town.');
  });

  it('blocks invented prices', () => {
    expectBlocked('That will be about PKR 3,500 for the tow.', 'price_claim');
    expectBlocked('It usually costs around $80.', 'price_claim');
    expectBlocked('The charge is 2000 rupees.', 'price_claim');
  });

  it('allows a price only when relaying a configured pricing fact', () => {
    expectAllowed('Local tows start at PKR 3,500 according to our rates.', {
      allowPricing: true,
    });
    // The same sentence is blocked when the engine did not supply a price.
    expectBlocked('Local tows start at PKR 3,500.', 'price_claim');
  });

  it('blocks arrival-time promises in either word order', () => {
    expectBlocked('The driver will arrive in about 20 minutes.', 'arrival_time_promise');
    expectBlocked('We can be there shortly.', 'arrival_time_promise');
    expectBlocked('Someone will reach you within the hour.', 'arrival_time_promise');
    expectBlocked('In 30 minutes the truck will be there.', 'arrival_time_promise');
  });

  it('does not mistake a callback promise for an arrival promise', () => {
    // "contact you shortly" is about a phone call, not a truck. This is the
    // exact phrasing the product's own closing line uses, so a false positive
    // here would silence every successful call.
    expectAllowed('The towing team will contact you shortly.');
    expectAllowed('Someone will call you back about that.');
  });

  it('blocks claims that a truck has been dispatched', () => {
    expectBlocked("I've dispatched a truck to your location.", 'dispatch_promise');
    expectBlocked("I'm sending a driver now.", 'dispatch_promise');
    expectBlocked('A tow truck is on its way.', 'dispatch_promise');
    expectBlocked("I've booked that in for you.", 'dispatch_promise');
  });

  it('blocks AI self-reference', () => {
    expectBlocked(
      'As an AI receptionist, I will now collect your details.',
      'ai_self_reference',
    );
    expectBlocked("I'm an automated assistant for the towing company.", 'ai_self_reference');
  });

  it('blocks guarantees and free-service claims', () => {
    expectBlocked('I guarantee we can take this job.', 'guarantee');
    expectBlocked('The callout is free of charge.', 'free_service_claim');
  });

  it('blocks replies too long to be spoken naturally', () => {
    expectBlocked(`${'This is a very long reply. '.repeat(30)}`, 'too_long');
  });

  it('reports every rule a reply breaks, not just the first', () => {
    const result = checkReply(
      "As an AI, I've dispatched a truck that will arrive in 10 minutes for PKR 3000.",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('blocks claims that a truck or driver is available', () => {
    for (const reply of [
      'Good news, we have a truck available near you.',
      'One of our drivers is nearby.',
      'Trucks are available in your area right now.',
      'Yes, we can definitely take the job.',
    ]) {
      const result = checkReply(reply);
      expect(result.ok, reply).toBe(false);
    }
    // Asking about the caller's vehicle is not a claim about ours.
    expect(checkReply('Is the truck able to move, or does it need to be towed?').ok).toBe(true);
  });

  it('blocks the receptionist thinking aloud about its instructions or tools', () => {
    expectBlocked("What's my next move?", 'self_talk');
    expectBlocked('Let me check the call state.', 'self_talk');
    expectBlocked('The required action is to ask your name.', 'self_talk');
    expectBlocked("I'll call update_call_information.", 'self_talk');
    expectBlocked('Let me get call state first.', 'self_talk');
    expectBlocked('According to my instructions, I should ask where you are.', 'self_talk');
  });

  it('lets ordinary talk about next steps, notes and moving through', () => {
    expectAllowed('The next step is to get your name.');
    expectAllowed("I'll note that for the driver.");
    expectAllowed('Can you move the car off the road?');
    expectAllowed("I can request a callback from the team if you'd like.");
    expectAllowed('Before we end the call, is there anything else?');
  });
});
