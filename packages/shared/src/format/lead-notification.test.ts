import { describe, expect, it } from 'vitest';
import { formatCallbackNotification, formatLeadNotification } from './lead-notification';
import { LeadSource, LeadStatus, type Lead } from '../domain/lead';

const BASE: Lead = {
  id: '11111111-1111-4111-8111-111111111111',
  businessId: '22222222-2222-4222-8222-222222222222',
  callId: '33333333-3333-4333-8333-333333333333',
  customerName: 'Ahmed',
  customerPhone: '+923001234567',
  service: 'Vehicle towing',
  location: 'Liberty Market',
  destination: null,
  vehicleMake: 'Toyota',
  vehicleModel: 'Corolla',
  vehicleType: null,
  vehicleCondition: null,
  vehicleMovable: false,
  additionalNotes: null,
  source: LeadSource.AI_RECEPTIONIST,
  status: LeadStatus.NEW,
  createdAt: new Date('2026-03-14T21:17:00.000Z'),
  updatedAt: new Date('2026-03-14T21:17:00.000Z'),
};

const CTX = { businessName: 'Liberty Towing', timezone: 'Asia/Karachi' };

describe('the WhatsApp lead notification', () => {
  it('renders the operator-facing message', () => {
    expect(formatLeadNotification(BASE, CTX)).toMatchInlineSnapshot(`
      "🚨 NEW TOWING LEAD

      Customer: Ahmed
      Phone: +92 300 1234567

      Service: Vehicle towing

      Vehicle:
      Toyota Corolla

      Vehicle movable:
      No

      Location:
      Liberty Market

      Destination:
      Not provided

      Additional notes:
      None

      📞 Customer requested towing assistance.

      Call received:
      Mar 15, 2:17 AM"
    `);
  });

  it('says "Not provided" rather than omitting absent optional fields', () => {
    const message = formatLeadNotification(BASE, CTX);
    // A 2am operator reads by position; sections must not move about.
    expect(message).toContain('Destination:\nNot provided');
    expect(message).toContain('Additional notes:\nNone');
  });

  it('includes the condition only when one was collected', () => {
    expect(formatLeadNotification(BASE, CTX)).not.toContain('Condition:');
    expect(
      formatLeadNotification({ ...BASE, vehicleCondition: "won't start" }, CTX),
    ).toContain("Condition:\nwon't start");
  });

  it('falls back to the vehicle type when make and model are unknown', () => {
    const message = formatLeadNotification(
      { ...BASE, vehicleMake: null, vehicleModel: null, vehicleType: 'Motorcycle' },
      CTX,
    );
    expect(message).toContain('Vehicle:\nMotorcycle');
  });

  it('distinguishes "cannot move" from "not known"', () => {
    expect(formatLeadNotification(BASE, CTX)).toContain('Vehicle movable:\nNo');
    expect(formatLeadNotification({ ...BASE, vehicleMovable: true }, CTX)).toContain(
      'Vehicle movable:\nYes',
    );
    expect(formatLeadNotification({ ...BASE, vehicleMovable: null }, CTX)).toContain(
      'Vehicle movable:\nNot provided',
    );
  });

  it('renders the call time in the operator timezone, not UTC', () => {
    // 21:17 UTC is 02:17 the next day in Karachi.
    expect(formatLeadNotification(BASE, CTX)).toContain('2:17 AM');
    expect(formatLeadNotification(BASE, { ...CTX, timezone: 'UTC' })).toContain('9:17 PM');
  });

  it('still notifies when the tenant timezone is invalid', () => {
    // A bad config value must not cost the operator the lead.
    const message = formatLeadNotification(BASE, { ...CTX, timezone: 'Not/AZone' });
    expect(message).toContain('NEW TOWING LEAD');
    expect(message).toContain('2026-03-14T21:17:00.000Z');
  });

  it('carries only persisted lead data, never free text from the call', () => {
    // Every line is traceable to a validated column; there is no path from a
    // transcript or model output into this message.
    const message = formatLeadNotification(BASE, CTX);
    for (const line of message.split('\n').filter(Boolean)) {
      const isLabelOrFixed = /^(🚨|📞|Customer:|Phone:|Service:|Vehicle:|Vehicle movable:|Location:|Destination:|Condition:|Additional notes:|Call received:)/.test(line);
      const isKnownValue = [
        'Toyota Corolla',
        'No',
        'Liberty Market',
        'Not provided',
        'None',
        'Mar 15, 2:17 AM',
      ].includes(line);
      expect(isLabelOrFixed || isKnownValue, `unexpected line: ${line}`).toBe(true);
    }
  });
});

describe('the callback notification', () => {
  it('tells the operator what could not be answered', () => {
    const message = formatCallbackNotification(
      {
        customerName: 'Ahmed',
        customerPhone: '+923001234567',
        reason: 'Asked how much a 200km tow costs',
        createdAt: new Date('2026-03-14T21:17:00.000Z'),
      },
      CTX,
    );

    expect(message).toContain('CALLBACK REQUEST');
    expect(message).toContain('Asked how much a 200km tow costs');
    expect(message).toContain('+92 300 1234567');
  });

  it('handles a caller who never gave a name', () => {
    const message = formatCallbackNotification(
      {
        customerName: null,
        customerPhone: '+923001234567',
        reason: 'Asked about insurance paperwork',
        createdAt: new Date('2026-03-14T21:17:00.000Z'),
      },
      CTX,
    );
    expect(message).toContain('Customer: Not provided');
  });

  it('tells the operator everything the caller said before the call ended, and what is still needed', () => {
    // A real caller gave the service, an exact address, the vehicle and that it
    // could not move, but never a name; the operator got a name and a number.
    const message = formatCallbackNotification(
      {
        customerName: null,
        customerPhone: '+18174098408',
        reason: 'Call ended before all details were collected.',
        createdAt: new Date('2026-03-14T21:17:00.000Z'),
        details: {
          service: 'tow',
          location: '123 Main Street',
          vehicle: 'Pickup Truck',
          vehicleMovable: false,
          vehicleCondition: "won't start",
          notes: 'NOT CONFIRMED: the call ended before these details were read back to the caller. Check them when you call.',
        },
        stillNeeded: ['name'],
      },
      { businessName: 'Liberty Towing', timezone: 'America/Chicago' },
    );

    expect(message).toMatchInlineSnapshot(`
      "📞 CALLBACK REQUEST

      Customer: Not provided
      Phone: +1 817 4098408

      Reason:
      Call ended before all details were collected.

      What the caller told us:
      Service: tow
      Location: 123 Main Street
      Vehicle: Pickup Truck
      Vehicle movable: No
      Condition: won't start

      Still needed: name

      Notes:
      NOT CONFIRMED: the call ended before these details were read back to the caller. Check them when you call.

      Call received:
      Mar 14, 4:17 PM"
    `);
  });

  it('says nothing about details when none were collected', () => {
    const message = formatCallbackNotification(
      { customerName: null, customerPhone: '+18174098408', reason: 'Caller went silent before intake finished.', createdAt: new Date(), details: {} },
      CTX,
    );
    expect(message).not.toContain('What the caller told us');
    expect(message).not.toContain('Still needed');
    expect(message).not.toContain('Notes:');
  });
});
