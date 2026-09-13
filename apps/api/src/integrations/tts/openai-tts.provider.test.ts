import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAiTtsProvider } from './openai-tts.provider';

/** A fake /v1/audio/speech response: 24 kHz 16-bit PCM, delivered in pieces. */
function pcmResponse(samples = 2400) {
  const pcm = Buffer.alloc(samples * 2);
  const chunks = [pcm.subarray(0, 1001), pcm.subarray(1001)];
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(new Uint8Array(chunks[index++]!));
        else controller.close();
      },
    }),
    { status: 200 },
  );
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

let fetchMock: ReturnType<typeof vi.fn>;
const provider = () =>
  new OpenAiTtsProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini-tts', voice: 'marin' });

beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(async () => pcmResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI speech', () => {
  it('requests PCM from OpenAI and returns phone-rate μ-law', async () => {
    const audio = await collect(provider().stream({ text: 'Can I get your name?' }));

    // 2 400 samples at 24 kHz → 800 samples at 8 kHz, one byte each.
    expect(audio.length).toBe(800);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'gpt-4o-mini-tts',
      input: 'Can I get your name?',
      voice: 'marin',
      response_format: 'pcm',
    });
  });

  it('serves a repeated phrase from memory without calling OpenAI again', async () => {
    const tts = provider();
    const first = await collect(tts.stream({ text: "What's your current location?" }));
    const second = await collect(tts.stream({ text: "What's your current location?" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.equals(first)).toBe(true);
  });

  it('does not cache a phrase that was interrupted part-way through', async () => {
    const tts = provider();
    const controller = new AbortController();

    for await (const _chunk of tts.stream({ text: 'Let me read that back.', signal: controller.signal })) {
      controller.abort(); // the caller talked over it
      break;
    }
    await collect(tts.stream({ text: 'Let me read that back.' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the cache per voice', async () => {
    const tts = provider();
    await collect(tts.stream({ text: 'Can I get your name?' }));
    await collect(tts.stream({ text: 'Can I get your name?', voiceId: 'cedar' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces an OpenAI error instead of speaking silence', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"bad key"}', { status: 401 }));
    await expect(collect(provider().stream({ text: 'Hello' }))).rejects.toThrow(/401/);
  });
});
