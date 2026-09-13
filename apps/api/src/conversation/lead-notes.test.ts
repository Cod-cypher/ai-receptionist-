import { describe, expect, it } from 'vitest';

import { buildLeadNotes } from './lead-notes';
import { initialContext } from './types';

describe('buildLeadNotes', () => {
  it('tells the operator what the last real call left out', () => {
    const notes = buildLeadNotes({
      ...initialContext({
        customerPhone: '+18174098408',
        location: 'I-85 near the exit',
        vehicleMake: 'Ford',
        vehicleModel: 'Mustang',
        vehicleCondition: 'blowout',
      }),
      urgency: { level: 'high', reasons: ['caller needs help urgently', 'broken down on a high-speed road'] },
      safety: { hazard: 'being stopped on a high-speed road', issuedAtTurn: 1 },
      fieldSources: { vehicleMake: 'inferred', vehicleModel: 'stated' },
      locationDetailAttempts: 2,
    });

    expect(notes).toContain('URGENT: caller needs help urgently; broken down on a high-speed road.');
    expect(notes).toContain('emergency advice was given');
    expect(notes).toContain('Vehicle make "Ford" was inferred, not said by the caller.');
    expect(notes).toContain('Location is approximate');
  });

  it('leaves other pipelines\' leads as they were', () => {
    expect(buildLeadNotes(initialContext({ location: 'Main Street' }))).toBeNull();
    expect(buildLeadNotes(initialContext({ additionalNotes: 'Gate code 1234' }))).toBe('Gate code 1234');
  });
});
