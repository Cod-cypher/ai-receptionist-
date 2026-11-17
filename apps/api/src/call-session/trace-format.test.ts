import { describe, expect, it } from 'vitest';

import { clip, formatEvent, renderTimeline, type TraceEvent } from './trace-format';

const CALL = { id: 'call-1', fromNumber: '+18174098408', startedAt: '2026-10-02T10:00:00.000Z', durationSeconds: 95, outcome: 'lead_created', finalState: 'ENDED' };

let sequence = 0;
const event = (type: string, payload: Record<string, unknown>): TraceEvent => ({ sequence: sequence++, type, payload });

describe('formatEvent', () => {
  it('says what was decided and why, the deciding reason first', () => {
    const text = formatEvent('NEXT_ACTION', {
      after: 'update',
      action: 'ASK_LOCATION_DETAIL',
      because: ['location "I-95" not precise enough to drive to (road without a point on it); detail asked 0/2', 'saved: serviceType=tow'],
      doNotAsk: ['vehicle', 'name'],
    });
    expect(text.split('\n')).toEqual([
      '→ NEXT: ASK_LOCATION_DETAIL (after update) because location "I-95" not precise enough to drive to (road without a point on it); detail asked 0/2',
      '      · saved: serviceType=tow',
      '      · must wait: vehicle, name',
    ]);
  });

  it('shows a stopped reply with every word and how much was heard', () => {
    expect(
      formatEvent('AI_RESPONSE', { text: "Okay. What's my next move?", stopped: 'guardrail', heard: 'Okay.', heardMs: 300, audioMs: 1400, inReplyTo: 'tool-results' }),
    ).toBe(`Receptionist: "Okay. What's my next move?" [guardrail; heard ~"Okay.", 300ms of 1400ms] (reply to: tool-results)`);
    expect(formatEvent('AI_RESPONSE', { text: 'Mm-hm.', stopped: null, filler: true })).toBe('Receptionist (filler): "Mm-hm."');
  });

  it('shows what the judge found, or that the rules decided alone', () => {
    expect(formatEvent('JUDGMENT', { about: 'location', text: 'I-95', ms: 412, found: ['location partial (0.81)', 'danger 0.10 none'] })).toBe(
      'judge location "I-95" in 412ms: location partial (0.81); danger 0.10 none',
    );
    expect(formatEvent('JUDGMENT', { about: 'speech', text: 'Hello?', ms: 1500, found: [] })).toContain('nothing came back, the rules decided alone');
  });

  it('shows a note to the model by its first line, or in full', () => {
    const payload = { kind: 'state', pinned: true, action: 'ASK_VEHICLE', text: 'CALL STATE\n- Service: tow\n\nREQUIRED ACTION: ASK_VEHICLE' };
    expect(formatEvent('MODEL_NOTE', payload)).toContain('(4 lines; --notes for all)');
    expect(formatEvent('MODEL_NOTE', payload, { notes: true })).toContain('| REQUIRED ACTION: ASK_VEHICLE');
  });

  it('shows the caller\'s words a reply was asked for with, and what it replaced', () => {
    expect(formatEvent('REPLY_REQUESTED', { reason: 'caller-words', toolChoice: 'none', said: 'I asked you something else.', kind: 'complaint', turn: 5 })).toBe(
      'reply asked for: caller-words "I asked you something else." (complaint)',
    );
    expect(formatEvent('REPLY_REQUESTED', { reason: 'caller-words', said: 'Can you hear me?', kind: 'line_check', superseded: 'started' })).toBe(
      'reply asked for: caller-words "Can you hear me?" (line_check; replaces the reply under way, unheard)',
    );
    // Quoted in the first note: the reply was asked for once, with the words.
    expect(formatEvent('REPLY_REQUESTED', { reason: 'caller-turn', said: 'How long will it take?', kind: 'question' })).toBe(
      'reply asked for: caller-turn "How long will it take?" (question)',
    );
    expect(formatEvent('REPLY_REQUESTED', { reason: 'caller-turn' })).toBe('reply asked for: caller-turn');
  });

  it("shows what the caller waited, from their last sound", () => {
    expect(formatEvent('REPLY_REQUESTED', { reason: 'caller-turn', endpointMs: 640, waitedMs: 410 })).toBe(
      'reply asked for: caller-turn [turn ended 640ms after their last sound] [held 410ms for the words]',
    );
    expect(formatEvent('AI_RESPONSE', { text: 'Where are you right now?', inReplyTo: 'tool-results', afterTurnMs: 2050, afterLastSoundMs: 2690 })).toBe(
      'Receptionist: "Where are you right now?" (reply to: tool-results) [began 2690ms after their last sound]',
    );
    // The caller's last sound was not found: the wait is counted from the end of their turn.
    expect(formatEvent('AI_RESPONSE', { text: 'Where are you right now?', inReplyTo: 'caller-turn', afterTurnMs: 900 })).toBe(
      'Receptionist: "Where are you right now?" (reply to: caller-turn) [sent 900ms after their turn ended]',
    );
  });

  it('tells a pause for a brief sound from a reply that played through it', () => {
    const heard = { voicedMs: 200, via: 'gauge', loudestRms: 1069, minVoicedRms: 250 };
    expect(formatEvent('HOLD_RESUMED', { ...heard, holdMs: 605, resumedMs: 1200 })).toBe(
      'caller spoke briefly: paused 605ms and carried on (200ms voiced; decided by gauge; loudest 1069, voice from 250)',
    );
    // The gap the caller heard, not the whole time the sound was watched.
    expect(formatEvent('HOLD_RESUMED', { ...heard, voicedMs: 400, holdMs: 700, pausedMs: 400, resumedMs: 600 })).toContain('paused 400ms and carried on (400ms voiced');
    expect(formatEvent('HOLD_RESUMED', { ...heard, holdMs: 500, resumedMs: 0, playedThrough: true })).toBe(
      'caller made a brief sound: the reply played through it (200ms voiced; decided by gauge; loudest 1069, voice from 250)',
    );
  });

  it('says when a caller was left to finish thinking', () => {
    expect(formatEvent('OVERLAP_DECIDED', { said: 'Um', by: 'word lists', decision: 'no reply', hesitation: true })).toBe(
      'caller is still thinking: "Um" → no reply, waiting for them to go on',
    );
  });

  it('prints any other event as its fields, without the turn', () => {
    expect(formatEvent('SOMETHING_NEW', { a: 1, b: 'two', turn: 3 })).toBe('SOMETHING_NEW a=1 b=two');
    expect(clip('x'.repeat(10), 5)).toBe('xxxx…');
  });
});

describe('renderTimeline', () => {
  it('groups a traced call by caller turn, with a reply recorded late kept in its own turn', () => {
    sequence = 0;
    const events = [
      event('CALL_STARTED', { from: '+18174098408' }),
      event('AI_RESPONSE', { text: 'Thanks for calling.', stopped: null, greeting: true, turn: 0 }),
      event('CUSTOMER_SPEECH', { transcript: 'I need a tow on I-95.', turn: 1 }),
      event('NEXT_ACTION', { after: 'update', action: 'ASK_LOCATION_DETAIL', because: ['location "I-95" not precise enough'], doNotAsk: [], turn: 1 }),
      event('CUSTOMER_SPEECH', { transcript: 'Exit 42.', turn: 2 }),
      // Settled after the next turn began; still the reply to turn 1.
      event('AI_RESPONSE', { text: 'Where exactly on I-95?', stopped: null, inReplyTo: 'tool-results', turn: 1 }),
    ];

    const text = renderTimeline(CALL, [], events);
    const turn1 = text.indexOf('Turn 1');
    const turn2 = text.indexOf('Turn 2');

    expect(text).toContain('Before the caller spoke');
    expect(turn1).toBeGreaterThan(0);
    expect(text.indexOf('Where exactly on I-95?')).toBeGreaterThan(turn1);
    expect(text.indexOf('Where exactly on I-95?')).toBeLessThan(turn2);
    expect(text.slice(turn2)).toContain('Caller: "Exit 42."');
  });

  it('shows only the event types asked for', () => {
    sequence = 0;
    const events = [
      event('AI_RESPONSE', { text: 'Hi.', stopped: null, turn: 0 }),
      event('NEXT_ACTION', { after: 'state', action: 'ASK_SERVICE_TYPE', because: ['serviceType missing'], doNotAsk: [], turn: 1 }),
      event('REPLY_REQUESTED', { reason: 'caller-turn', turn: 1 }),
    ];
    const text = renderTimeline(CALL, [], events, { only: ['NEXT_ACTION'] });
    expect(text).toContain('→ NEXT: ASK_SERVICE_TYPE');
    expect(text).not.toContain('reply asked for');
  });

  it('interleaves the transcript of a call recorded before replies were traced', () => {
    const text = renderTimeline(
      CALL,
      [
        { turnIndex: 0, speaker: 'ai', text: 'Thanks for calling.', createdAt: '2026-10-02T10:00:01.000Z' },
        { turnIndex: 1, speaker: 'customer', text: 'I need a tow.', createdAt: '2026-10-02T10:00:05.000Z' },
      ],
      [{ sequence: 0, type: 'FIELD_EXTRACTED', payload: { field: 'serviceType', value: 'tow' }, createdAt: '2026-10-02T10:00:06.000Z' }],
    );
    const lines = text.split('\n').slice(4);
    expect(lines).toEqual(['  Receptionist: "Thanks for calling."', '  Caller: "I need a tow."', '  saved serviceType = tow']);
  });
});
