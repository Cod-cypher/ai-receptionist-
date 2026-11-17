import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SttProvider, SttSession, SttSessionCallbacks } from '../stt/stt-provider.interface';
import { LiveWords, createLiveWordsProvider } from './live-words';

/** A transcriber the test speaks for: it reports whatever the test says it heard. */
function fakeTranscriber(options: { fail?: string } = {}) {
  let callbacks!: SttSessionCallbacks;
  const session: SttSession & { written: Buffer[]; closed: boolean } = {
    written: [],
    closed: false,
    write(chunk) {
      this.written.push(chunk);
    },
    finish: async () => undefined,
    close() {
      this.closed = true;
    },
  };
  const provider: SttProvider = {
    name: 'fake',
    open: vi.fn(async (opened) => {
      callbacks = opened.callbacks;
      if (options.fail) throw new Error(options.fail);
      return session;
    }),
  };
  return { provider, session, hears: () => callbacks };
}

const opened = () => new Promise((resolve) => setImmediate(resolve));
const FRAME = Buffer.alloc(160, 0xff);

describe('the caller\'s words, as they are said', () => {
  afterEach(() => vi.restoreAllMocks());

  it('has the settled parts of a sentence and the part still being said', async () => {
    const stt = fakeTranscriber();
    const onWords = vi.fn();
    const live = new LiveWords(stt.provider, { label: 'call-1', onWords });
    await opened();

    stt.hears().onInterimTranscript?.("I'm on");
    expect(live.words(0)).toBe("I'm on");
    stt.hears().onSettledSegment?.("I'm on I-95,");
    stt.hears().onInterimTranscript?.('near exit');
    stt.hears().onInterimTranscript?.('near exit 42.');

    expect(live.words(0)).toBe("I'm on I-95, near exit 42.");
    expect(onWords).toHaveBeenCalledTimes(4);
  });

  it('does not count an utterance twice when the transcriber reports its parts and then the whole', async () => {
    const stt = fakeTranscriber();
    const live = new LiveWords(stt.provider, { label: 'call-1', onWords: vi.fn() });
    await opened();

    // Deepgram: each settled segment, then the last one again as the end of the utterance.
    stt.hears().onSettledSegment?.('A Honda');
    stt.hears().onSettledSegment?.('Civic.');
    stt.hears().onFinalTranscript('Civic.');

    expect(live.words(0)).toBe('A Honda Civic.');
  });

  it('takes whole utterances from a transcriber that reports nothing else', async () => {
    const stt = fakeTranscriber();
    const live = new LiveWords(stt.provider, { label: 'call-1', onWords: vi.fn() });
    await opened();

    stt.hears().onFinalTranscript('A Honda Civic.');
    expect(live.words(0)).toBe('A Honda Civic.');
  });

  it('leaves out what was said before the turn began, and starts from nothing once its words are used', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const stt = fakeTranscriber();
    const live = new LiveWords(stt.provider, { label: 'call-1', onWords: vi.fn() });
    await opened();

    // A noise the turn detector never made a turn of.
    stt.hears().onSettledSegment?.('Mm.');
    now = 20_000;
    stt.hears().onSettledSegment?.('Exit 12.');

    expect(live.words(15_000)).toBe('Exit 12.');
    live.clear();
    expect(live.words(0)).toBe('');
  });

  it('passes the caller\'s audio on, the frames from before the connection opened included', async () => {
    const stt = fakeTranscriber();
    const live = new LiveWords(stt.provider, { label: 'call-1', onWords: vi.fn() });
    live.write(FRAME);
    live.write(FRAME);
    expect(stt.session.written).toHaveLength(0);
    await opened();
    live.write(FRAME);

    expect(stt.session.written).toHaveLength(3);
    expect(stt.provider.open).toHaveBeenCalledWith(expect.objectContaining({ encoding: 'mulaw', sampleRate: 8000, language: 'en' }));
  });

  it('has no words, and costs the call nothing, when the transcriber cannot be reached', async () => {
    const stt = fakeTranscriber({ fail: 'getaddrinfo ENOTFOUND api.deepgram.com' });
    const live = new LiveWords(stt.provider, { label: 'call-1', onWords: vi.fn() });
    await opened();

    expect(() => live.write(FRAME)).not.toThrow();
    expect(live.words(0)).toBe('');
  });

  it('has no words once the transcriber fails mid-call', async () => {
    const stt = fakeTranscriber();
    const live = new LiveWords(stt.provider, { label: 'call-1', onWords: vi.fn() });
    await opened();
    stt.hears().onSettledSegment?.('Exit 12.');
    stt.hears().onError(new Error('socket hang up'));

    expect(live.words(0)).toBe('');
    live.write(FRAME);
    expect(stt.session.written).toHaveLength(0);
  });

  it('closes the transcriber with the call, even one still connecting', async () => {
    const stt = fakeTranscriber();
    const live = new LiveWords(stt.provider, { label: 'call-1', onWords: vi.fn() });
    live.close();
    await opened();
    expect(stt.session.closed).toBe(true);

    const connected = fakeTranscriber();
    const second = new LiveWords(connected.provider, { label: 'call-2', onWords: vi.fn() });
    await opened();
    second.close();
    expect(connected.session.closed).toBe(true);
  });
});

describe('the live transcriber chosen by AI_REALTIME_LIVE_WORDS', () => {
  it('is none unless one is named', () => {
    expect(createLiveWordsProvider({})).toBeNull();
    expect(createLiveWordsProvider({ setting: 'off', deepgramApiKey: 'dg-key' })).toBeNull();
  });

  it('is Deepgram when named and given a key', () => {
    expect(createLiveWordsProvider({ setting: 'deepgram', deepgramApiKey: 'dg-key', deepgramModel: 'nova-3' })?.name).toBe('deepgram');
  });

  it('is none, with the call left as it was, when Deepgram is named without a key', () => {
    expect(createLiveWordsProvider({ setting: 'deepgram' })).toBeNull();
  });
});
