import { describe, expect, it, vi } from 'vitest';

import { RealtimeFillerBank } from './filler-bank';
import type { RealtimeConversationCallbacks, ResponseRequest } from './openai-realtime-conversation';

/** A session that speaks 0.2 s of audio for every line it is asked for, unless told to misbehave. */
function fakeFactory(options: { fail?: boolean; say?: (line: string) => { text: string; chunks: number } } = {}) {
  const requests: ResponseRequest[] = [];
  const closed = vi.fn();
  const factory = ({ callbacks }: { callbacks: RealtimeConversationCallbacks }) => ({
    appendAudio: vi.fn(),
    submitToolResults: vi.fn(),
    addNote: vi.fn(),
    cancelResponse: vi.fn(),
    truncate: vi.fn(),
    close: closed,
    requestResponse: (request: ResponseRequest = {}) => {
      requests.push(request);
      setImmediate(() => {
        if (options.fail) {
          callbacks.onError(new Error('HTTP 401'));
          return;
        }
        const line = /"(.*)"/.exec(request.instructions ?? '')?.[1] ?? '';
        const { text, chunks } = options.say?.(line) ?? { text: line, chunks: 2 };
        const id = `item-${requests.length}`;
        callbacks.onResponseStarted(`resp-${requests.length}`, true);
        callbacks.onSpokenText(id, text);
        for (let i = 0; i < chunks; i += 1) callbacks.onAudio(id, Buffer.alloc(800, 0xff));
        callbacks.onResponseDone({ id: `resp-${requests.length}`, status: 'completed', toolCalls: [] });
      });
    },
  });
  return { factory, requests, closed };
}

describe('the filler bank', () => {
  it('synthesises each line in the receptionist\'s voice, then closes its session', async () => {
    const { factory, requests, closed } = fakeFactory();
    const bank = new RealtimeFillerBank(factory as never);

    await bank.warmUp(['Mm-hm.', 'One moment.']);

    expect(requests.map((r) => r.instructions)).toEqual([
      'Say exactly this and nothing else: "Mm-hm."',
      'Say exactly this and nothing else: "One moment."',
    ]);
    expect(requests.every((r) => r.toolChoice === 'none')).toBe(true);
    expect(bank.size).toBe(2);
    expect(bank.next('turn')).toEqual({ text: 'Mm-hm.', audio: Buffer.alloc(1600, 0xff) });
    expect(bank.next('stall')?.text).toBe('One moment.');
    expect(closed).toHaveBeenCalled();
  });

  it('keeps a sound of listening for ordinary turns and "one moment" for a stalled reply, each rotating', async () => {
    const { factory } = fakeFactory();
    const bank = new RealtimeFillerBank(factory as never);

    await bank.warmUp();

    expect([bank.next('turn')?.text, bank.next('turn')?.text, bank.next('turn')?.text]).toEqual(['Mm-hm.', 'Okay.', 'Mm-hm.']);
    expect([bank.next('stall')?.text, bank.next('stall')?.text]).toEqual(['One moment.', 'Just a moment.']);
  });

  it('falls back to any line it has when none of the kind asked for is ready', async () => {
    const { factory } = fakeFactory();
    const bank = new RealtimeFillerBank(factory as never);

    await bank.warmUp(['One moment.']);

    expect(bank.next('turn')?.text).toBe('One moment.');
  });

  it('rejects a line the model padded with words of its own, or dragged out', async () => {
    const { factory } = fakeFactory({
      say: (line) =>
        line === 'Okay.'
          ? { text: 'Okay, how can I help you today?', chunks: 2 }
          : line === 'Mm-hm.'
            ? { text: 'Mm-hm.', chunks: 40 } // 4 s of audio for one syllable
            : { text: line, chunks: 2 },
    });
    const bank = new RealtimeFillerBank(factory as never);

    await bank.warmUp(['Okay.', 'Mm-hm.', 'One moment.']);

    expect(bank.size).toBe(1);
    expect(bank.next()?.text).toBe('One moment.');
  });

  it('asks again for a line the model padded, and keeps it once the model says just the line', async () => {
    // Live: "Mm-hm." came back as "Sure, please tell me what kind of issue
    // you're experiencing" on the first try and as "Mm-hm." on the second.
    let tries = 0;
    const { factory, requests } = fakeFactory({
      say: (line) => (line === 'Mm-hm.' && tries++ === 0 ? { text: 'Sure, how can I help?', chunks: 2 } : { text: line, chunks: 2 }),
    });
    const bank = new RealtimeFillerBank(factory as never);

    await bank.warmUp(['Mm-hm.', 'Okay.']);

    expect(requests.map((r) => /"(.*)"/.exec(r.instructions ?? '')?.[1])).toEqual(['Mm-hm.', 'Mm-hm.', 'Okay.']);
    expect(bank.size).toBe(2);
  });

  it('gives up quietly when synthesis fails, so calls still run', async () => {
    const { factory, closed } = fakeFactory({ fail: true });
    const bank = new RealtimeFillerBank(factory as never);

    await bank.warmUp(['Mm-hm.']);

    expect(bank.size).toBe(0);
    expect(bank.next()).toBeNull();
    expect(closed).toHaveBeenCalled();
  });
});
