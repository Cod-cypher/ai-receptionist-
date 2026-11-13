import { describe, expect, it, vi } from 'vitest';

import { ALL_FILLER_LINES, FILLER_LINES, RealtimeFillerBank, recordLines } from './filler-bank';
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

    expect(Array.from({ length: 5 }, () => bank.next('turn')?.text)).toEqual(['Mm-hm.', 'Okay.', 'Right.', 'Uh-huh.', 'Mm-hm.']);
    expect(Array.from({ length: 3 }, () => bank.next('stall')?.text)).toEqual(['One moment.', 'Just a moment.', 'Bear with me.']);
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

  it('does not keep a clip whose words it cannot check', async () => {
    // Kept unchecked, a clip that said anything up to 2.5 s long was played to
    // callers and written to the transcript as "Mm-hm.". Live, the warm-up
    // model drifts into "I'm not sure what to do next" and worse.
    let tries = 0;
    const { factory, requests } = fakeFactory({
      say: (line) => (line === 'Mm-hm.' && tries++ < 4 ? { text: '', chunks: 6 } : { text: line, chunks: 2 }),
    });
    const bank = new RealtimeFillerBank(factory as never);

    await bank.warmUp(['Mm-hm.', 'Okay.']);

    // Four tries at "Mm-hm.", then "Okay.".
    expect(requests).toHaveLength(5);
    expect(bank.size).toBe(1);
    expect(bank.next('turn')?.text).toBe('Okay.');
  });

  it('records each take out of band, so a bad one is never the context of the next', async () => {
    const { factory, requests } = fakeFactory();
    await new RealtimeFillerBank(factory as never).warmUp(['Mm-hm.', 'Okay.']);
    expect(requests.every((r) => r.outOfBand === true)).toBe(true);
  });

  it('hears "Mm-hmm." as the line "Mm-hm."', async () => {
    const { factory } = fakeFactory({ say: (line) => ({ text: line === 'Mm-hm.' ? 'Mm-hmm.' : line, chunks: 2 }) });
    const bank = new RealtimeFillerBank(factory as never);
    await bank.warmUp(['Mm-hm.']);
    expect(bank.size).toBe(1);
  });

  it('gives up quietly when synthesis fails, so calls still run', async () => {
    const { factory, closed } = fakeFactory({ fail: true });
    const bank = new RealtimeFillerBank(factory as never);

    await bank.warmUp(['Mm-hm.']);

    expect(bank.size).toBe(0);
    expect(bank.next()).toBeNull();
    expect(closed).toHaveBeenCalled();
  });

  it('gives up quietly when the session cannot even be opened', async () => {
    const bank = new RealtimeFillerBank((() => {
      throw new Error('no API key');
    }) as never);

    await bank.warmUp(['Mm-hm.']);

    expect(bank.size).toBe(0);
  });

  it('records every kind by default, each line once: "Okay." is a turn and a detail line', async () => {
    const { factory, requests } = fakeFactory();
    const bank = new RealtimeFillerBank(factory as never);

    await bank.warmUp();

    const asked = requests.map((r) => /"(.*)"/.exec(r.instructions ?? '')?.[1]);
    expect(asked.filter((line) => line === 'Okay.')).toHaveLength(1);
    expect(new Set(asked)).toEqual(new Set(Object.values(FILLER_LINES).flat()));
    expect(asked).toEqual([...ALL_FILLER_LINES]);
    expect(bank.size).toBe(12);
    expect(Array.from({ length: 3 }, () => bank.next('question')?.text)).toEqual(['Let me see.', 'Hmm.', 'Good question.']);
    expect(Array.from({ length: 3 }, () => bank.next('detail')?.text)).toEqual(['Okay.', 'Got it.', 'Alright.']);
  });

  it('records a line it already has only once, however often warm-up runs', async () => {
    const { factory, requests } = fakeFactory();
    const bank = new RealtimeFillerBank(factory as never);

    await bank.warmUp(['Mm-hm.', 'Mm-hm.']);
    await bank.warmUp(['Mm-hm.', 'Okay.']);

    expect(requests).toHaveLength(2);
    expect(bank.size).toBe(2);
  });

  describe('a picker per call', () => {
    it('rotates on its own, and does not start where the call before it started', async () => {
      const { factory } = fakeFactory();
      const bank = new RealtimeFillerBank(factory as never);
      await bank.warmUp();

      const first = bank.forCall();
      const second = bank.forCall();

      expect(first.next('turn')?.text).toBe('Mm-hm.');
      expect(second.next('turn')?.text).toBe('Okay.');
      // Each call's cursor moved only for its own fillers.
      expect(first.next('turn')?.text).toBe('Okay.');
      expect(first.next('turn')?.text).toBe('Right.');
      expect(second.next('turn')?.text).toBe('Right.');
      // Nor does the bank's own rotation move theirs.
      expect(bank.next('turn')?.text).toBe('Mm-hm.');
      expect(first.next('turn')?.text).toBe('Uh-huh.');
    });

    it('never plays the same filler twice running, even across kinds', async () => {
      const { factory } = fakeFactory();
      const bank = new RealtimeFillerBank(factory as never);
      await bank.warmUp();
      const picker = bank.forCall();

      // "Okay." is the second turn line and the first detail line.
      expect(picker.next('turn')?.text).toBe('Mm-hm.');
      expect(picker.next('turn')?.text).toBe('Okay.');
      expect(picker.next('detail')?.text).toBe('Got it.');
    });

    it('falls back to any line it has when none of the kind asked for is ready', async () => {
      const { factory } = fakeFactory();
      const bank = new RealtimeFillerBank(factory as never);
      await bank.warmUp(['One moment.']);

      expect(bank.forCall().next('question')?.text).toBe('One moment.');
    });

    it('finds nothing before warm-up, and lines recorded later as they arrive', async () => {
      const { factory } = fakeFactory();
      const bank = new RealtimeFillerBank(factory as never);
      const picker = bank.forCall();

      expect(picker.next('turn')).toBeNull();
      await bank.warmUp(['Mm-hm.']);
      expect(picker.next('turn')?.text).toBe('Mm-hm.');
    });
  });

  describe('recordLines', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };

    it('hands each take over as soon as it is kept, and all of them at the end', async () => {
      const { factory, closed } = fakeFactory();
      const seen: string[] = [];

      const takes = await recordLines(factory as never, ['Hello there.', 'Bye now.'], {
        label: 'test',
        instructions: 'Record.',
        logger,
        maxMs: 5_000,
        onLine: (take) => seen.push(take.text),
      });

      expect(seen).toEqual(['Hello there.', 'Bye now.']);
      expect([...takes.keys()]).toEqual(['Hello there.', 'Bye now.']);
      expect(closed).toHaveBeenCalled();
    });

    it('uses the length limit and the check it is given', async () => {
      const { factory, requests } = fakeFactory({ say: (line) => ({ text: `${line} Indeed.`, chunks: 30 }) });

      const takes = await recordLines(factory as never, ['Hello there.'], {
        label: 'test',
        instructions: 'Record.',
        logger,
        maxMs: 5_000,
        maxTakeMs: () => 4_000,
        isLine: (said, line) => said.startsWith(line),
      });

      expect(requests).toHaveLength(1);
      expect(takes.get('Hello there.')?.audio.length).toBe(30 * 800);
    });

    it('gives up at the time limit, and keeps nothing that lands after it', async () => {
      vi.useFakeTimers();
      try {
        const requested: string[] = [];
        const late: { take?: () => void } = {};
        const factory = ({ callbacks }: { callbacks: RealtimeConversationCallbacks }) => ({
          close: vi.fn(),
          requestResponse: (request: ResponseRequest = {}) => {
            requested.push(request.instructions ?? '');
            late.take = () => {
              callbacks.onSpokenText('late', 'Hello there.');
              callbacks.onAudio('late', Buffer.alloc(800, 0xff));
              callbacks.onResponseDone({ id: 'late', status: 'completed', toolCalls: [] });
            };
          },
        });
        const kept = vi.fn();

        const pending = recordLines(factory as never, ['Hello there.'], {
          label: 'test',
          instructions: 'Record.',
          logger,
          maxMs: 1_000,
          onLine: kept,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        const takes = await pending;
        expect(late.take).toBeDefined();
        late.take?.();

        expect(takes.size).toBe(0);
        expect(kept).not.toHaveBeenCalled();
        expect(requested).toHaveLength(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('took longer than 1s'));
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
