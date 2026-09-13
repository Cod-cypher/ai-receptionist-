import { describe, expect, it } from 'vitest';
import type { SlotValues } from '@towai/shared';

import { assessRisk } from './risk';
import { regionForNumber } from './region';
import { initialContext, type ConversationContext } from './types';

const ctx = (values: SlotValues, extra: Partial<ConversationContext> = {}) => ({
  ...initialContext({ customerPhone: '+18174098408', ...values }),
  ...extra,
});

describe('assessRisk', () => {
  it('flags the last real call: a highway blowout and "I need it immediately"', () => {
    const risk = assessRisk(
      ctx({ location: 'I-85 near the exit', vehicleCondition: 'blowout', vehicleMovable: false }),
      "Yeah, it's on I-85 near the exit, and I need it immediately.",
    );
    expect(risk.urgency?.level).toBe('high');
    expect(risk.urgency?.reasons).toEqual(
      expect.arrayContaining(['caller needs help urgently', 'broken down on a high-speed road']),
    );
    expect(risk.safety).toEqual({ hazard: 'being stopped on a high-speed road', issuedAtTurn: null });
  });

  it('treats an accident or injury as a hazard wherever it is', () => {
    expect(assessRisk(ctx({ location: '123 Main Street' }), 'I was in an accident and my friend is hurt').safety?.hazard).toBe('an accident');
  });

  it('leaves a driveway jump start as normal', () => {
    const risk = assessRisk(ctx({ location: '123 Main Street', serviceType: 'jump start' }), 'My battery is dead in my driveway.');
    expect(risk.urgency?.level).toBe('normal');
    expect(risk.safety).toBeUndefined();
  });

  it('keeps reasons and a handled hazard once found', () => {
    const before = ctx({}, { urgency: { level: 'high', reasons: ['caller feels unsafe'] }, safety: { hazard: 'an accident', issuedAtTurn: 2 } });
    const risk = assessRisk(before, 'okay');
    expect(risk.urgency?.reasons).toContain('caller feels unsafe');
    expect(risk.safety).toEqual({ hazard: 'an accident', issuedAtTurn: 2 });
  });
});

describe('regionForNumber', () => {
  it('reads the caller\'s country from their number', () => {
    expect(regionForNumber('+18174098408')).toEqual({ prefix: '+1', emergencyNumber: '911' });
    expect(regionForNumber('+447700900123')?.emergencyNumber).toBe('999');
    expect(regionForNumber('+923001234567')?.prefix).toBe('+92');
    expect(regionForNumber('anonymous')).toBeNull();
  });
});
