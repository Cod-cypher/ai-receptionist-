import { describe, expect, it, vi } from 'vitest';

import { GreetingBank, greetingFor, listGreetings, saysGreeting, type GreetingDirectory } from './greeting-bank';
import type { RealtimeConversationCallbacks, ResponseRequest } from './openai-realtime-conversation';

const GREETING = 'Thanks for calling Liberty Towing. How can I help?';

/**
 * A session that speaks 3 s of audio for every line it is asked for, unless
 * told to say something else. Each session it opens is counted.
 */
function fakeFactory(options: { say?: (line: string, take: number) => { text: string; chunks: number } } = {}) {
  const requests: ResponseRequest[] = [];
  const sessions: string[] = [];
  const closed = vi.fn();
  const factory = ({ callbacks, label }: { callbacks: RealtimeConversationCallbacks; label?: string }) => {
    sessions.push(label ?? '');
    return {
      appendAudio: vi.fn(),
      submitToolResults: vi.fn(),
      addNote: vi.fn(),
      cancelResponse: vi.fn(),
      truncate: vi.fn(),
      close: closed,
      requestResponse: (request: ResponseRequest = {}) => {
        requests.push(request);
        const take = requests.length;
        setImmediate(() => {
          const line = /"(.*)"/.exec(request.instructions ?? '')?.[1] ?? '';
          const { text, chunks } = options.say?.(line, take) ?? { text: line, chunks: 30 };
          const id = `item-${take}`;
          callbacks.onResponseStarted(`resp-${take}`, true);
          callbacks.onSpokenText(id, text);
          for (let i = 0; i < chunks; i += 1) callbacks.onAudio(id, Buffer.alloc(800, 0xff));
          callbacks.onResponseDone({ id: `resp-${take}`, status: 'completed', toolCalls: [] });
        });
      },
    };
  };
  return { factory, requests, sessions, closed };
}

const linesAsked = (requests: ResponseRequest[]) => requests.map((r) => /"(.*)"/.exec(r.instructions ?? '')?.[1]);

describe('the greeting bank', () => {
  it('records a greeting in the call voice, out of band, and plays it back by its text', async () => {
    const { factory, requests, closed } = fakeFactory();
    const bank = new GreetingBank(factory as never, 'marin');

    expect(bank.get(GREETING)).toBeNull();
    await bank.warmUp([GREETING]);

    expect(requests).toEqual([
      expect.objectContaining({ instructions: `Say exactly this and nothing else: "${GREETING}"`, toolChoice: 'none', outOfBand: true }),
    ]);
    expect(bank.get(GREETING)).toEqual({ text: GREETING, audio: Buffer.alloc(30 * 800, 0xff) });
    // The text as the call record has it, spacing aside.
    expect(bank.get(` ${GREETING}\n`)?.text).toBe(GREETING);
    expect(closed).toHaveBeenCalled();
  });

  it('records each greeting once, in one session', async () => {
    const { factory, requests, sessions } = fakeFactory();
    const bank = new GreetingBank(factory as never);

    await bank.warmUp([GREETING, 'Rapid Recovery, how can I help you?', GREETING]);

    expect(sessions).toHaveLength(1);
    expect(linesAsked(requests)).toEqual([GREETING, 'Rapid Recovery, how can I help you?']);
    expect(bank.size).toBe(2);
  });

  it('asks again when a take drifts from the greeting, and keeps the take that says it', async () => {
    const { factory, requests } = fakeFactory({
      say: (line, take) =>
        take === 1 ? { text: `${line} Are you somewhere safe right now?`, chunks: 50 } : { text: line, chunks: 30 },
    });
    const bank = new GreetingBank(factory as never);

    await bank.warmUp([GREETING]);

    expect(linesAsked(requests)).toEqual([GREETING, GREETING]);
    expect(bank.get(GREETING)?.audio.length).toBe(30 * 800);
  });

  it('keeps no take of a greeting that never comes out as the greeting, and the model says it on calls', async () => {
    const { factory, requests } = fakeFactory({ say: () => ({ text: 'Hello, how can I help you today?', chunks: 30 }) });
    const bank = new GreetingBank(factory as never);

    await bank.warmUp([GREETING]);

    expect(requests).toHaveLength(4);
    expect(bank.get(GREETING)).toBeNull();
  });

  it('rejects a take that runs far longer than the greeting could', async () => {
    const { factory } = fakeFactory({ say: (line) => ({ text: line, chunks: 100 }) }); // 10 s
    const bank = new GreetingBank(factory as never);

    await bank.warmUp([GREETING]);

    expect(bank.size).toBe(0);
  });

  it('gives a long greeting an operator wrote the time it needs', async () => {
    const long =
      'Thank you for calling Liberty Towing and Recovery, serving the whole of Springfield and Shelbyville ' +
      'day and night. If you are on a highway, please get somewhere safe first. How can we help you today?';
    const { factory } = fakeFactory({ say: (line) => ({ text: line, chunks: 110 }) }); // 11 s, 35 words
    const bank = new GreetingBank(factory as never);

    await bank.warmUp([long]);

    expect(bank.get(long)).not.toBeNull();
  });

  it('keeps a take that reads the phone number and the name its own way', async () => {
    const greeting = 'Thanks for calling A1 Towing, at 555-0123. How can I help?';
    const { factory, requests } = fakeFactory({
      say: () => ({ text: 'Thanks for calling A-1 Towing at five five five, oh one two three... how can I help?', chunks: 45 }),
    });
    const bank = new GreetingBank(factory as never);

    await bank.warmUp([greeting]);

    expect(requests).toHaveLength(1);
    expect(bank.get(greeting)).not.toBeNull();
  });

  describe('recording on demand', () => {
    it('records a greeting first seen on a call once, however many ask while it is made, then keeps it', async () => {
      const { factory, requests, sessions } = fakeFactory();
      const bank = new GreetingBank(factory as never);

      const first = bank.record(GREETING);
      const second = bank.record(GREETING);
      expect(second).toBe(first);

      const take = await first;
      expect(take?.text).toBe(GREETING);
      expect(bank.get(GREETING)).toBe(take);
      await expect(bank.record(GREETING)).resolves.toBe(take);
      expect(requests).toHaveLength(1);
      expect(sessions).toHaveLength(1);
    });

    it('shares a recording the warm-up is already making', async () => {
      const { factory, requests } = fakeFactory();
      const bank = new GreetingBank(factory as never);

      const warmUp = bank.warmUp([GREETING]);
      const asked = bank.record(GREETING);
      await warmUp;

      expect((await asked)?.text).toBe(GREETING);
      expect(requests).toHaveLength(1);
    });

    it('opens one recording session at a time', async () => {
      const { factory, sessions } = fakeFactory();
      let open = 0;
      let mostOpen = 0;
      const counting = (options: Parameters<typeof factory>[0]) => {
        open += 1;
        mostOpen = Math.max(mostOpen, open);
        const conversation = factory(options);
        return {
          ...conversation,
          close: () => {
            open -= 1;
            conversation.close();
          },
        };
      };
      const bank = new GreetingBank(counting as never);

      const takes = await Promise.all([
        bank.record(GREETING),
        bank.record('Rapid Recovery, how can I help you?'),
        bank.record('Speedy Tow, what can I do for you?'),
      ]);

      expect(takes.every((take) => take !== null)).toBe(true);
      expect(sessions).toHaveLength(3);
      expect(mostOpen).toBe(1);
    });

    it('does not try again straight away for a greeting it could not record', async () => {
      const { factory, requests } = fakeFactory({ say: () => ({ text: 'Hello?', chunks: 10 }) });
      const bank = new GreetingBank(factory as never);

      await expect(bank.record(GREETING)).resolves.toBeNull();
      await expect(bank.record(GREETING)).resolves.toBeNull();

      expect(requests).toHaveLength(4);
    });

    it('never rejects, even when the session cannot be opened', async () => {
      const bank = new GreetingBank((() => {
        throw new Error('no API key');
      }) as never);

      await expect(bank.record(GREETING)).resolves.toBeNull();
      await expect(bank.warmUp(['Rapid Recovery, how can I help you?'])).resolves.toBeUndefined();
    });
  });

  it('keeps 50 greetings, dropping the one no call has used for longest', async () => {
    const { factory } = fakeFactory();
    const bank = new GreetingBank(factory as never);
    const greetings = Array.from({ length: 50 }, (_, i) => `Thanks for calling Towing Company ${i + 1}. How can I help?`);

    await bank.warmUp(greetings);
    expect(bank.size).toBe(50);

    // The first was just used on a call; the second has not been since it was recorded.
    expect(bank.get(greetings[0]!)).not.toBeNull();
    await bank.record('Thanks for calling Towing Company 51. How can I help?');

    expect(bank.size).toBe(50);
    expect(bank.get(greetings[0]!)).not.toBeNull();
    expect(bank.get(greetings[1]!)).toBeNull();
    expect(bank.get('Thanks for calling Towing Company 51. How can I help?')).not.toBeNull();
  });
});

describe('a take of a greeting', () => {
  it.each([
    ['the greeting itself', GREETING, true],
    ['punctuation and case aside', 'thanks for calling liberty towing, how can i help', true],
    ['one word different in a short greeting', 'Thanks for calling Liberty Towing. How can I help you?', true],
    ['the end left off', 'Thanks for calling Liberty Towing.', false],
    ['a question of its own added', `${GREETING} Are you in a safe place?`, false],
    ['a different greeting', 'Hello, Liberty Towing, what do you need?', false],
    ['nothing', '', false],
  ])('%s', (_, said, kept) => {
    expect(saysGreeting(said, GREETING)).toBe(kept);
  });

  it('may differ by one word in ten of a long greeting, and no more', () => {
    const line = 'Thank you for calling Liberty Towing and Recovery in Springfield, open day and night. How can we help you today?';
    // 20 words: two may differ ("Thank you" said as "Thanks"), four may not.
    expect(saysGreeting('Thanks for calling Liberty Towing and Recovery in Springfield, open day and night. How can we help you today?', line)).toBe(
      true,
    );
    expect(saysGreeting('Thanks for calling Liberty Towing in Springfield, open day and night. How can we help you today?', line)).toBe(false);
  });
});

describe('the greetings to record at start-up', () => {
  function directory(businesses: Record<string, { status?: string; greeting?: string | null; name: string } | Error>): GreetingDirectory {
    return {
      routedBusinessIds: async () => Object.keys(businesses),
      load: async (id) => {
        const business = businesses[id]!;
        if (business instanceof Error) throw business;
        return {
          business: { status: business.status ?? 'active' },
          flow: { greeting: business.greeting ?? null, facts: { name: business.name } },
        };
      },
    };
  }

  it('is the greeting each call opens with: the one set, or the default made from the name', () => {
    expect(greetingFor({ greeting: 'Rapid Recovery, how can I help you?', facts: { name: 'Rapid Recovery' } })).toBe(
      'Rapid Recovery, how can I help you?',
    );
    expect(greetingFor({ greeting: null, facts: { name: 'Liberty Towing' } })).toBe(GREETING);
    expect(greetingFor({ greeting: '   ', facts: { name: 'Liberty Towing' } })).toBe(GREETING);
  });

  it('covers every active business a number reaches, each greeting once', async () => {
    const warn = vi.fn();
    const greetings = await listGreetings(
      directory({
        a: { name: 'Liberty Towing' },
        b: { name: 'Rapid Recovery', greeting: 'Rapid Recovery, how can I help you?' },
        c: { name: 'Gone Towing', status: 'suspended' },
        d: new Error('connection refused'),
        e: { name: 'Liberty Towing' },
      }),
      { warn },
    );

    expect(greetings).toEqual([GREETING, 'Rapid Recovery, how can I help you?']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('business d'));
  });
});
