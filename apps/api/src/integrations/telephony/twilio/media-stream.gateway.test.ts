import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaStreamGateway } from './media-stream.gateway';
import { buildVocabularyHint } from '../../stt/vocabulary-hint';
import type { SttSessionCallbacks, SttSessionOptions } from '../../stt/stt-provider.interface';

/**
 * Drives the gateway the way Twilio does — start, media, mark, stop — with fake
 * recognition and synthesis, to pin down the timing behaviour a real call
 * depends on and that a text simulator cannot exercise.
 */

type Sent = { event: string; streamSid?: string; mark?: { name: string } };

class FakeTwilioSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Sent[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  fromTwilio(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  count(event: string): number {
    return this.sent.filter((m) => m.event === event).length;
  }

  lastMark(): string | undefined {
    return [...this.sent].reverse().find((m) => m.event === 'mark')?.mark?.name;
  }

  /** Twilio reporting that playback reached the most recent mark. */
  played(): void {
    const name = this.lastMark();
    if (name) this.fromTwilio({ event: 'mark', streamSid: 'MZ1', mark: { name } });
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let socket: FakeTwilioSocket;
let recognition: SttSessionCallbacks;
let callSession: { handleUtterance: ReturnType<typeof vi.fn>; handleEvent: ReturnType<typeof vi.fn> };

function createGateway() {
  callSession = {
    handleUtterance: vi.fn(),
    handleEvent: vi.fn().mockResolvedValue({ reply: '', ended: true, state: 'ENDED', outcome: null }),
  };
  const businessConfig = {
    load: vi.fn().mockResolvedValue({
      settings: null,
      flow: { facts: { name: 'Liberty Towing', serviceAreas: ['Lahore', 'Gulberg'] } },
    }),
  };
  const stt = {
    name: 'fake-stt',
    open: vi.fn(async (options: SttSessionOptions) => {
      recognition = options.callbacks;
      return { write: vi.fn(), finish: vi.fn(), close: vi.fn() };
    }),
  };
  const tts = {
    name: 'fake-tts',
    // 0.4 seconds of audio, delivered at once — far faster than it plays.
    async *stream() {
      yield Buffer.alloc(3200, 0xff);
    },
  };

  const gateway = new MediaStreamGateway(
    callSession as never,
    businessConfig as never,
    {} as never,
    stt as never,
    tts as never,
  );
  socket = new FakeTwilioSocket();
  gateway.handleConnection(socket as never);
  return { stt };
}

async function startCall() {
  socket.fromTwilio({
    event: 'start',
    streamSid: 'MZ1',
    start: {
      callSid: 'CA1',
      customParameters: { businessId: 'biz-1', callId: 'call-1', greeting: 'Thanks for calling.' },
    },
  });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  createGateway();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('media stream playback tracking', () => {
  it('speaks the greeting, then waits for Twilio to finish playing it', async () => {
    await startCall();

    expect(socket.count('media')).toBe(20); // 3200 bytes in 160-byte frames
    expect(socket.lastMark()).toBe('reply-1');
  });

  it('does not start the silence timer until the greeting has actually played', async () => {
    // The old gateway started it when audio was *sent*, so a long reply could be
    // interrupted by its own "are you still there?".
    await startCall();

    vi.advanceTimersByTime(7_500);
    await settle();
    expect(callSession.handleEvent).not.toHaveBeenCalled();

    socket.played();
    await settle();
    vi.advanceTimersByTime(7_100);
    await settle();
    expect(callSession.handleEvent).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'SILENCE' });
  });
});

describe('barge-in', () => {
  it('clears Twilio\'s buffer when the caller talks over audio that is sent but still playing', async () => {
    // The old gateway considered itself silent once the audio was sent, and so
    // ignored interruptions for most of every sentence.
    await startCall();
    expect(socket.count('clear')).toBe(0);

    recognition.onSpeechStarted?.();

    expect(socket.count('clear')).toBe(1);
  });

  it('does nothing when the caller speaks while the receptionist is silent', async () => {
    await startCall();
    socket.played();
    await settle();

    recognition.onSpeechStarted?.();

    expect(socket.count('clear')).toBe(0);
  });
});

describe('turns', () => {
  it('queues words spoken while a reply is being prepared, instead of dropping them', async () => {
    await startCall();
    socket.played();
    await settle();

    const first = deferred<unknown>();
    callSession.handleUtterance
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ reply: 'Can I get your name?', ended: false, state: 'COLLECT_NAME', outcome: null });

    recognition.onFinalTranscript('my car broke down near Liberty Market');
    await settle();
    recognition.onFinalTranscript('it is a Toyota Corolla');
    await settle();

    expect(callSession.handleUtterance).toHaveBeenCalledTimes(1);

    first.resolve({ reply: 'What vehicle is it?', ended: false, state: 'COLLECT_VEHICLE', outcome: null });
    await settle();
    socket.played();
    await settle();

    expect(callSession.handleUtterance).toHaveBeenCalledTimes(2);
    expect(callSession.handleUtterance.mock.calls[1]![2]).toBe('it is a Toyota Corolla');
  });

  it('hangs up only after the goodbye has finished playing', async () => {
    await startCall();
    socket.played();
    await settle();

    callSession.handleUtterance.mockResolvedValueOnce({
      reply: 'Thanks, the towing team will contact you shortly.',
      ended: true,
      state: 'ENDED',
      outcome: 'lead_created',
    });

    recognition.onFinalTranscript("yes that's right");
    await settle();
    expect(socket.closed).toBe(false);

    socket.played();
    await settle();
    expect(socket.closed).toBe(true);
  });

  it('finalises the call when Twilio stops the stream', async () => {
    await startCall();
    socket.fromTwilio({ event: 'stop', streamSid: 'MZ1' });
    await settle();

    expect(callSession.handleEvent).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'HANGUP' });
  });
});

describe('recognition vocabulary', () => {
  it('includes the business, its areas, and towing terms', () => {
    const hint = buildVocabularyHint({
      name: 'Liberty Towing',
      serviceAreas: ['Gulberg', 'DHA'],
    } as never);

    expect(hint).toContain('Liberty Towing');
    expect(hint).toContain('Gulberg, DHA');
    expect(hint).toContain('towed');
  });
});
