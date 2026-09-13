import { describe, expect, it } from 'vitest';

import type { Lead } from '../domain/lead';
import { formatLeadNotification, leadNotificationVariables } from './lead-notification';

const lead: Lead = {
  id: '00000000-0000-0000-0000-000000000001',
  businessId: '00000000-0000-0000-0000-000000000002',
  callId: null,
  customerName: 'Michael',
  customerPhone: '+18174098408',
  service: 'vehicle towing',
  location: 'I-85, exit 12',
  destination: null,
  vehicleMake: 'Ford',
  vehicleModel: 'Mustang',
  vehicleType: null,
  vehicleCondition: 'blowout',
  vehicleMovable: false,
  additionalNotes: 'URGENT: caller needs help urgently.',
  priority: 'high',
  fieldSources: { vehicleMake: 'inferred' },
  source: 'ai_receptionist',
  status: 'new',
  createdAt: new Date('2026-09-13T22:32:15Z'),
  updatedAt: new Date('2026-09-13T22:32:15Z'),
};

describe('lead priority in the notification', () => {
  it('heads an urgent lead so it stands out on the operator\'s phone', () => {
    const body = formatLeadNotification(lead, { businessName: 'Liberty Towing', timezone: 'America/Chicago' });
    expect(body.split('\n')[0]).toBe('🚨 URGENT TOWING LEAD');
    expect(body).toContain('blowout');
  });

  it('keeps the normal heading otherwise', () => {
    const body = formatLeadNotification({ ...lead, priority: 'normal' }, { businessName: 'Liberty Towing', timezone: 'America/Chicago' });
    expect(body.split('\n')[0]).toBe('🚨 NEW TOWING LEAD');
  });

  it('carries the urgency in the approved-template notes variable, unchanged in shape', () => {
    const vars = leadNotificationVariables(lead, { businessName: 'Liberty Towing', timezone: 'America/Chicago' });
    expect(Object.keys(vars)).toHaveLength(9);
    expect(vars['8']).toContain('URGENT');
  });
});
