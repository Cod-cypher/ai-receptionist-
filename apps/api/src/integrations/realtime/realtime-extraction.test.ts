import { describe, expect, it } from 'vitest';

import { REPORT_CALLER_TURN_TOOL, normaliseCallerTurn } from './realtime-extraction';

describe('normaliseCallerTurn', () => {
  it('accepts well-formed arguments', () => {
    const turn = normaliseCallerTurn(
      JSON.stringify({
        heard: 'My car broke down near Liberty Market.',
        intent: 'provide_info',
        slots: { serviceType: 'vehicle towing', location: 'Liberty Market', vehicleMovable: false },
        faqQuestion: null,
        faqTopic: null,
        outOfScopeRequest: null,
      }),
    );

    expect(turn.heard).toBe('My car broke down near Liberty Market.');
    expect(turn.extraction.intent).toBe('provide_info');
    expect(turn.extraction.slots.location).toBe('Liberty Market');
    expect(turn.extraction.slots.vehicleMovable).toBe(false);
    expect(turn.extraction.slots.customerName).toBeNull();
  });

  it('coerces the string booleans gpt-realtime-mini actually returned in testing', () => {
    const turn = normaliseCallerTurn(
      JSON.stringify({ heard: "it won't move", intent: 'provide_info', slots: { vehicleMovable: 'no' } }),
    );
    expect(turn.extraction.slots.vehicleMovable).toBe(false);
  });

  it('fills fields the model left out, rather than rejecting the turn', () => {
    const turn = normaliseCallerTurn(JSON.stringify({ heard: 'Ahmed', slots: { customerName: 'Ahmed' } }));
    expect(turn.extraction.intent).toBe('unclear');
    expect(turn.extraction.slots.customerName).toBe('Ahmed');
    expect(turn.extraction.faqTopic).toBeNull();
  });

  it('tolerates slots flattened onto the top level', () => {
    const turn = normaliseCallerTurn(
      JSON.stringify({ heard: 'Suzuki Mehran', intent: 'provide_info', vehicleMake: 'Suzuki', vehicleModel: 'Mehran' }),
    );
    expect(turn.extraction.slots.vehicleMake).toBe('Suzuki');
  });

  it('discards an invented intent or FAQ topic', () => {
    const turn = normaliseCallerTurn(
      JSON.stringify({ heard: 'send a truck', intent: 'dispatch_truck', faqTopic: 'discounts', slots: {} }),
    );
    expect(turn.extraction.intent).toBe('unclear');
    expect(turn.extraction.faqTopic).toBeNull();
  });

  it('returns an unclear turn for garbage instead of throwing', () => {
    for (const bad of ['', 'not json', '[1,2]', 'null', undefined]) {
      const turn = normaliseCallerTurn(bad);
      expect(turn.extraction.intent).toBe('unclear');
      expect(turn.heard).toBe('');
    }
  });
});

describe('the report_caller_turn tool', () => {
  it('asks for what was heard plus every extraction field', () => {
    const params = REPORT_CALLER_TURN_TOOL.parameters;
    expect(params.required).toContain('heard');
    expect(params.required).toContain('intent');
    expect(params.required).toContain('slots');
    expect(Object.keys(params.properties)).toContain('heard');
  });
});
