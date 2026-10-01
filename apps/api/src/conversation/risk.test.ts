import { describe, expect, it } from 'vitest';
import type { SlotValues } from '@towai/shared';

import type { RiskJudgment } from '../integrations/judgment/judgment.interface';
import { assessRisk, hazardEvidence } from './risk';
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

  it('does not read a place name as a fire, or a denial as a hazard', () => {
    // Each of these gave a caller the 911 speech, and the lead a hazard.
    expect(assessRisk(ctx({ location: 'next to the fire station on Main Street' })).safety).toBeUndefined();
    expect(assessRisk(ctx({ location: 'Fire Lake Road and 5th' })).safety).toBeUndefined();
    expect(assessRisk(ctx({ location: '123 Main Street' }), 'No accident, it just will not start.').safety).toBeUndefined();
    expect(assessRisk(ctx({ location: '123 Main Street' }), 'Nobody is hurt, we are fine.').safety).toBeUndefined();
    expect(assessRisk(ctx({ location: '123 Main Street' }), 'It would not hurt to have it looked at.').safety).toBeUndefined();
    // The real thing still counts, said or saved.
    expect(assessRisk(ctx({ location: '123 Main Street' }), "There's smoke coming from under the hood.").safety?.hazard).toBe('fire or fuel risk');
    expect(assessRisk(ctx({ location: '123 Main Street', vehicleCondition: 'caught fire' })).safety?.hazard).toBe('fire or fuel risk');
    expect(assessRisk(ctx({ location: 'the middle of the highway' })).safety?.hazard).toBe('being in live traffic');
  });

  it('counts children as a reason for urgency only when they are there', () => {
    expect(assessRisk(ctx({ location: '123 Main Street' }), 'Sorry, one second, my kid is talking to me.').urgency?.level).toBe('normal');
    expect(assessRisk(ctx({ location: '123 Main Street' }), 'I have my kids with me and it is getting dark.').urgency?.reasons).toContain(
      'vulnerable people with the vehicle',
    );
    expect(assessRisk(ctx({ location: '123 Main Street' }), "There's a baby in the car.").urgency?.level).toBe('high');
    expect(assessRisk(ctx({ location: '123 Main Street' }), 'I am pregnant and stuck here.').urgency?.level).toBe('high');
  });

  it('keeps reasons and a handled hazard once found', () => {
    const before = ctx({}, { urgency: { level: 'high', reasons: ['caller feels unsafe'] }, safety: { hazard: 'an accident', issuedAtTurn: 2 } });
    const risk = assessRisk(before, 'okay');
    expect(risk.urgency?.reasons).toContain('caller feels unsafe');
    expect(risk.safety).toEqual({ hazard: 'an accident', issuedAtTurn: 2 });
  });

  describe('with a judgment from Jev', () => {
    const SPOKEN = 'my car rolled into the ditch and my leg is stuck';
    const judged = (hazard: RiskJudgment['hazard'], danger: number, urgent: number | null = null, text = SPOKEN) => ({
      judgments: { risk: { text, danger, hazard, hazardProbability: danger, urgent } },
    });

    it('takes a hazard the rules missed, in the words the lead notes use', () => {
      const risk = assessRisk(ctx({ location: '123 Main Street' }, judged('injury', 0.9)), SPOKEN);
      expect(risk.safety).toEqual({ hazard: 'a possible injury', issuedAtTurn: null });
    });

    it('ignores danger Jev is not sure of', () => {
      expect(assessRisk(ctx({ location: '123 Main Street' }, judged('injury', 0.5)), SPOKEN).safety).toBeUndefined();
    });

    it('counts urgency Jev is sure of', () => {
      const risk = assessRisk(ctx({ location: '123 Main Street' }, judged('none', 0.9, 0.85)), SPOKEN);
      expect(risk.urgency).toEqual({ level: 'high', reasons: ['caller needs help urgently'] });
      expect(assessRisk(ctx({ location: '123 Main Street' }, judged('none', 0.9, 0.3)), SPOKEN).urgency?.level).toBe('normal');
    });

    it('ignores a judgment made about other words', () => {
      const risk = assessRisk(ctx({ location: '123 Main Street' }, judged('injury', 0.95, 0.95, 'something said earlier')), SPOKEN);
      expect(risk.safety).toBeUndefined();
      expect(risk.urgency?.level).toBe('normal');
    });

    it('judges the saved location when nothing was spoken, ahead of the high-speed-road fallback', () => {
      const location = 'middle lane of I-95';
      const risk = assessRisk(ctx({ location }, judged('live_traffic', 0.9, null, location)));
      expect(risk.safety?.hazard).toBe('being in live traffic');
    });

    it('keeps the rules ahead of the judge when both see a hazard', () => {
      const risk = assessRisk(ctx({ location: '123 Main Street' }, judged('injury', 0.9)), 'we crashed and my leg is stuck');
      expect(risk.safety?.hazard).toBe('an accident');
    });
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

describe('hazardEvidence', () => {
  const assessed = (values: SlotValues, spoken?: string, extra: Partial<ConversationContext> = {}) => {
    const ctx = { ...initialContext(values), ...extra };
    return { ...ctx, ...assessRisk(ctx, spoken) };
  };

  it('names the word list, the judge with its score, or the road', () => {
    expect(hazardEvidence(assessed({}, 'there was a crash'), 'there was a crash')).toBe('word list, in "there was a crash"');
    const risk: RiskJudgment = { text: 'smells funny', danger: 0.85, hazard: 'fire_or_fuel', hazardProbability: 0.8, urgent: null };
    expect(hazardEvidence(assessed({}, 'smells funny', { judgments: { risk } }), 'smells funny')).toBe('judge, danger 0.85 in "smells funny"');
    expect(hazardEvidence(assessed({ location: 'I-35 near exit 200' }))).toBe('high-speed road in "I-35 near exit 200"');
    expect(hazardEvidence(assessed({ location: '123 Main Street' }))).toBeNull();
  });
});
