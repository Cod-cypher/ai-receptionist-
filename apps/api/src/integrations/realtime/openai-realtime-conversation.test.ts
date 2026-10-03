import { describe, expect, it } from 'vitest';

import { noteEvents, turnDetectionConfig, responseCreateEvent } from './openai-realtime-conversation';

describe('state notes', () => {
  it('adds the first note with an id of its own, so it can be removed later', () => {
    expect(noteEvents('CALL STATE\n- nothing saved yet', 'note_1', null)).toEqual([
      {
        type: 'conversation.item.create',
        item: { id: 'note_1', type: 'message', role: 'system', content: [{ type: 'input_text', text: 'CALL STATE\n- nothing saved yet' }] },
      },
    ]);
  });

  it('removes the note it replaces before adding the next, so a call carries one state and not thirty', () => {
    const events = noteEvents('CALL STATE\n- Name: Mike', 'note_2', 'note_1');
    expect(events.map((e) => e.type)).toEqual(['conversation.item.delete', 'conversation.item.create']);
    expect(events[0]).toMatchObject({ item_id: 'note_1', event_id: 'del-note_1' });
  });
});

describe('realtime turn detection', () => {
  it('never lets OpenAI start or cancel a reply on its own: the gateway decides both', () => {
    for (const mode of ['server_vad', 'semantic_vad'] as const) {
      const config = turnDetectionConfig({ silenceMs: 900, turnDetection: mode });
      expect(config).toMatchObject({ type: mode, create_response: false, interrupt_response: false });
    }
  });

  it('ends a turn after the configured silence with server VAD', () => {
    expect(turnDetectionConfig({ silenceMs: 700, turnDetection: 'server_vad' })).toMatchObject({
      silence_duration_ms: 700,
      prefix_padding_ms: 300,
    });
    // The default, when nothing is configured.
    expect(turnDetectionConfig({ silenceMs: 900 })).toMatchObject({ type: 'server_vad' });
  });

  it('lets semantic VAD judge the end of the turn from the words, at the configured eagerness', () => {
    const config = turnDetectionConfig({ silenceMs: 900, turnDetection: 'semantic_vad', eagerness: 'low' });
    expect(config).toEqual({ type: 'semantic_vad', eagerness: 'low', create_response: false, interrupt_response: false });
    expect(turnDetectionConfig({ silenceMs: 900, turnDetection: 'semantic_vad' })).toMatchObject({ eagerness: 'auto' });
  });
});

describe('response.create', () => {
  it('makes an out-of-band response, outside the conversation, only when asked', () => {
    const outOfBand = responseCreateEvent('req-1', { instructions: 'Say "Okay."', toolChoice: 'none', outOfBand: true }) as { response: Record<string, unknown> };
    expect(outOfBand.response).toEqual({ metadata: { request: 'req-1' }, instructions: 'Say "Okay."', tool_choice: 'none', conversation: 'none' });
    const ordinary = responseCreateEvent('req-2', { reason: 'caller-turn', tag: '7' }) as { response: Record<string, unknown> };
    // The reason and the tag are the gateway's own: never sent to OpenAI.
    expect(ordinary.response).toEqual({ metadata: { request: 'req-2' } });
  });
});
