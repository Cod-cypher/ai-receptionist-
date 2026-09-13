import { describe, expect, it, vi } from 'vitest';

import { REALTIME_TOOLS, TOOL, createToolExecutor, toIntakeOperation } from './realtime-tools';

describe('realtime tools', () => {
  it('never let the model choose a business, tenant or call', () => {
    const schemas = JSON.stringify(REALTIME_TOOLS.map((t) => t.parameters)).toLowerCase();
    expect(schemas).not.toMatch(/businessid|tenant|callid/);
  });

  it('bind every operation to the session\'s own call and caller turn, whatever the arguments say', async () => {
    const applyIntakeOperation = vi.fn().mockResolvedValue({ output: {}, ended: false, outcome: null, plan: null });
    const execute = createToolExecutor({
      callSession: { applyIntakeOperation },
      businessId: 'biz-1',
      callId: 'call-1',
      callerTurn: () => 3,
    });

    await execute(TOOL.UPDATE, JSON.stringify({ businessId: 'biz-2', callId: 'call-9', customerName: 'Mike' }));

    expect(applyIntakeOperation).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      { kind: 'update', slots: { customerName: 'Mike' }, callerIdConfirmed: null },
      { callerTurn: 3 },
    );
  });

  it('keep only provided fields, so null never overwrites a saved value', () => {
    expect(
      toIntakeOperation(TOOL.UPDATE, JSON.stringify({ customerName: null, location: '  ', vehicleType: 'semi', vehicleMovable: 'no' })),
    ).toEqual({ kind: 'update', slots: { vehicleType: 'semi', vehicleMovable: false }, callerIdConfirmed: null });
  });

  it('pass on which fields were inferred or unsure, keeping only real field names', () => {
    expect(
      toIntakeOperation(
        TOOL.UPDATE,
        JSON.stringify({ vehicleMake: 'Ford', vehicleModel: 'Mustang', inferredFields: ['vehicleMake', 'nonsense'], unsureFields: ['vehicleMovable'] }),
      ),
    ).toEqual({
      kind: 'update',
      slots: { vehicleMake: 'Ford', vehicleModel: 'Mustang' },
      callerIdConfirmed: null,
      inferred: ['vehicleMake'],
      unsure: ['vehicleMovable'],
    });
  });

  it('ask for the caller\'s exact wording of the problem, in US spelling', () => {
    const update = REALTIME_TOOLS.find((t) => t.name === TOOL.UPDATE)!;
    const condition = (update.parameters.properties as unknown as Record<string, { description: string }>).vehicleCondition!.description;
    expect(condition).toContain('blowout');
    expect(condition).not.toMatch(/tyre/);
  });

  it('accept fields nested under "slots" as well as flat', () => {
    expect(toIntakeOperation(TOOL.UPDATE, JSON.stringify({ slots: { location: 'I-95' } }))).toMatchObject({
      slots: { location: 'I-95' },
    });
  });

  it('treat anything but an explicit true as an unconfirmed completion', () => {
    expect(toIntakeOperation(TOOL.COMPLETE, '{"callerConfirmed":"maybe"}')).toEqual({ kind: 'complete', callerConfirmed: false });
    expect(toIntakeOperation(TOOL.COMPLETE, '{"callerConfirmed":"yes"}')).toEqual({ kind: 'complete', callerConfirmed: true });
  });

  it('return an error result, not an exception, for bad JSON or an unknown tool', async () => {
    const applyIntakeOperation = vi.fn();
    const execute = createToolExecutor({ callSession: { applyIntakeOperation }, businessId: 'b', callId: 'c' });

    expect((await execute(TOOL.UPDATE, '{not json')).output.error).toBeDefined();
    expect((await execute('dispatch_truck', '{}')).output.error).toBeDefined();
    expect((await execute(TOOL.BUSINESS, '{}')).output.error).toBeDefined();
    expect(applyIntakeOperation).not.toHaveBeenCalled();
  });
});
