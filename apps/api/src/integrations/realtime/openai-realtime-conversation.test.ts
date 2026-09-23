import { describe, expect, it } from 'vitest';

import { turnDetectionConfig } from './openai-realtime-conversation';

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
