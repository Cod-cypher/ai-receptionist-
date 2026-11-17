import { afterEach, describe, expect, it, vi } from 'vitest';

import { BusinessConfigService, CALL_CONFIG_TTL_MS } from './business-config.service';

/**
 * A database that answers the three reads of a configuration (the business,
 * its settings, its services) and counts how often it is asked.
 */
function fakeDatabase() {
  let name = 'Liberty Towing';
  let failNext = false;
  const withTenant = vi.fn(async (businessId: string, work: (tx: unknown) => Promise<unknown>) => {
    if (failNext) {
      failNext = false;
      throw new Error('connection refused');
    }
    const results: unknown[][] = [
      [{ id: businessId, name, timezone: 'America/Chicago', businessHours: [], serviceAreas: ['Dallas'], whatsappNumber: '+15550100', defaultRegionPrefix: '+1' }],
      [{ tone: 'calm', faq: [], greeting: null, fallbackBehavior: 'callback', businessInstructions: null, maxCallSeconds: 240 }],
      [{ name: 'Local towing' }],
    ];
    // Each query is a chain of builder calls that is awaited for its rows.
    const select = () => {
      const rows = results.shift() ?? [];
      const query: Record<string, unknown> = {};
      for (const method of ['from', 'where', 'limit', 'orderBy']) query[method] = () => query;
      query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
      return query;
    };
    return work({ select });
  });
  return {
    database: { withTenant },
    reads: () => withTenant.mock.calls.length,
    rename: (to: string) => (name = to),
    failOnce: () => (failNext = true),
  };
}

describe('the configuration read for a call in progress', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is read once for the operations of a call, not once for each', async () => {
    const db = fakeDatabase();
    const service = new BusinessConfigService(db.database as never);

    const atStart = await service.load('biz-1');
    const first = await service.loadForCall('biz-1');
    const second = await service.loadForCall('biz-1');

    expect(db.reads()).toBe(1);
    expect(first).toBe(atStart);
    expect(second).toBe(atStart);
    expect(first.flow.facts).toEqual(expect.objectContaining({ name: 'Liberty Towing', tone: 'calm', services: ['Local towing'] }));
    expect(first.maxCallSeconds).toBe(240);
  });

  it('is read again once it is older than the limit, so a saved change reaches a call in progress', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const db = fakeDatabase();
    const service = new BusinessConfigService(db.database as never);

    await service.loadForCall('biz-1');
    now += CALL_CONFIG_TTL_MS - 1;
    db.rename('Liberty Towing & Recovery');
    expect((await service.loadForCall('biz-1')).flow.facts.name).toBe('Liberty Towing');
    expect(db.reads()).toBe(1);

    now += 1;
    expect((await service.loadForCall('biz-1')).flow.facts.name).toBe('Liberty Towing & Recovery');
    expect(db.reads()).toBe(2);
  });

  it('is always read afresh at the start of a call', async () => {
    const db = fakeDatabase();
    const service = new BusinessConfigService(db.database as never);

    await service.load('biz-1');
    db.rename('Rapid Recovery');
    const next = await service.load('biz-1');

    expect(db.reads()).toBe(2);
    expect(next.flow.facts.name).toBe('Rapid Recovery');
    // The operations that follow on that call see what its start saw.
    expect(await service.loadForCall('biz-1')).toBe(next);
    expect(db.reads()).toBe(2);
  });

  it('is kept for each business apart', async () => {
    const db = fakeDatabase();
    const service = new BusinessConfigService(db.database as never);

    const one = await service.loadForCall('biz-1');
    const two = await service.loadForCall('biz-2');

    expect(db.reads()).toBe(2);
    expect(one.business.id).toBe('biz-1');
    expect(two.business.id).toBe('biz-2');
  });

  it('does not keep a read that failed', async () => {
    const db = fakeDatabase();
    const service = new BusinessConfigService(db.database as never);

    db.failOnce();
    await expect(service.loadForCall('biz-1')).rejects.toThrow('connection refused');
    expect((await service.loadForCall('biz-1')).flow.facts.name).toBe('Liberty Towing');
    expect(db.reads()).toBe(2);
  });
});
