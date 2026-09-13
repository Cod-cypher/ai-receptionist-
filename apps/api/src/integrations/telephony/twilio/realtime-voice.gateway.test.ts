import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallEventType, type SlotValues } from '@towai/shared';

import { describeIntake } from '../../../conversation/intake';
import { determineNextAction } from '../../../conversation/next-action';
import { initialContext } from '../../../conversation/types';
import { RealtimeVoiceGateway, heardPortion } from './realtime-voice.gateway';
import type {
  RealtimeConversation,
  RealtimeConversationCallbacks,
  ResponseRequest,
} from '../../realtime/openai-realtime-conversation';
import { SAFE_FALLBACK_LINE } from '../../realtime/realtime-instructions';

/**
 * Drives the chatgpt pipeline the way Twilio and gpt-realtime do, with both
 * replaced by fakes: the model converses and calls tools, and the gateway must
 * pin the backend's required action before each reply, bind tools to the
 * right call and caller turn, track what was heard, and stop replies that
 * break the rules or the priority order.
 */

type Sent = { event: string; mark?: { name: string } };

class FakeTwilioSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Sent[] = [];
  closed = false;
  private echoed = 0;

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

  /** Twilio reporting that playback reached the next `n` marks (all by default). */
  play(n = Infinity): void {
    const marks = this.sent.filter((m) => m.event === 'mark').slice(this.echoed);
    for (const mark of marks.slice(0, n)) {
      this.echoed += 1;
      this.fromTwilio({ event: 'mark', streamSid: 'MZ1', mark: { name: mark.mark!.name } });
    }
  }
}

class FakeConversation implements RealtimeConversation {
  readonly appendAudio = vi.fn();
  readonly requestResponse = vi.fn<(request?: ResponseRequest) => void>();
  readonly submitToolResults = vi.fn();
  readonly addNote = vi.fn<(text: string) => void>();
  readonly cancelResponse = vi.fn();
  readonly truncate = vi.fn();
  readonly close = vi.fn();
  private responses = 0;

  constructor(
    readonly instructions: string,
    readonly callbacks: RealtimeConversationCallbacks,
  ) {}

  /** The model starts a response, says `text` as `chunks` × 0.2 s of audio, and optionally finishes. */
  say(itemId: string, text: string, options: { chunks?: number; finish?: boolean; requested?: boolean } = {}): string {
    const id = `resp-${++this.responses}`;
    this.callbacks.onResponseStarted(id, options.requested ?? true);
    this.callbacks.onSpokenText(itemId, text);
    for (let i = 0; i < (options.chunks ?? 1); i += 1) this.callbacks.onAudio(itemId, Buffer.alloc(1600, 0xff));
    if (options.finish !== false) this.callbacks.onResponseDone({ id, status: 'completed', toolCalls: [] });
    return id;
  }

  /** A response that only calls tools. */
  callTools(calls: Array<{ callId: string; name: string; arguments: unknown }>): void {
    const id = `resp-${++this.responses}`;
    this.callbacks.onResponseStarted(id, true);
    this.callbacks.onResponseDone({
      id,
      status: 'completed',
      toolCalls: calls.map((c) => ({ ...c, arguments: JSON.stringify(c.arguments) })),
    });
  }

  lastRequest(): ResponseRequest | undefined {
    return this.requestResponse.mock.calls.at(-1)?.[0];
  }

  lastNote(): string | undefined {
    return this.addNote.mock.calls.at(-1)?.[0];
  }
}

const settle = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** What the backend would return for a call holding `values`. */
function backend(values: SlotValues) {
  const ctx = initialContext({ customerPhone: '+18174098408', ...values });
  const plan = determineNextAction(ctx, { emergencyNumber: '911' });
  return { output: { state: describeIntake(ctx, plan) }, ended: false, outcome: null, plan };
}

const MIKE: SlotValues = { serviceType: 'vehicle towing', customerName: 'Mike', vehicleType: 'semi truck', location: 'I-95' };

let socket: FakeTwilioSocket;
let model: FakeConversation;
let order: string[];
let callSession: {
  applyIntakeOperation: ReturnType<typeof vi.fn>;
  appendAiTranscriptLine: ReturnType<typeof vi.fn>;
  logCallEvent: ReturnType<typeof vi.fn>;
  handleEvent: ReturnType<typeof vi.fn>;
};

const GREETING = 'Thanks for calling Liberty Towing. How can I help?';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  order = [];

  callSession = {
    applyIntakeOperation: vi.fn(async (_b: string, _c: string, op: { kind: string; text?: string }) => {
      if (op.kind === 'caller_speech') order.push(`caller: ${op.text}`);
      else if (op.kind !== 'state') order.push(op.kind);
      return { output: { ok: true }, ended: false, outcome: null, plan: null };
    }),
    appendAiTranscriptLine: vi.fn(async (_b: string, _c: string, text: string) => {
      order.push(`ai: ${text}`);
    }),
    logCallEvent: vi.fn().mockResolvedValue(undefined),
    handleEvent: vi.fn().mockResolvedValue({ reply: '', ended: true, state: 'ENDED', outcome: null }),
  };
  const businessConfig = {
    load: vi.fn().mockResolvedValue({
      flow: {
        facts: { name: 'Liberty Towing', tone: 'calm', serviceAreas: [], services: [], emergencyContact: null, businessInstructions: null },
      },
    }),
  };

  const gateway = new RealtimeVoiceGateway(callSession as never, businessConfig as never, ({ instructions, callbacks }) => {
    model = new FakeConversation(instructions, callbacks);
    return model;
  });
  socket = new FakeTwilioSocket();
  gateway.handleConnection(socket as never);
});

afterEach(() => {
  vi.useRealTimers();
});

async function startCall() {
  socket.fromTwilio({
    event: 'start',
    streamSid: 'MZ1',
    start: {
      callSid: 'CA1',
      customParameters: { businessId: 'biz-1', callId: 'call-1', greeting: GREETING, callerNumber: '+18174098408' },
    },
  });
  await settle();
}

/** Greeting spoken and fully heard. */
async function greeted() {
  await startCall();
  model.say('greet', GREETING);
  socket.play();
  await settle();
}

/** The caller finishes a turn, and the backend's state for it is `values`. */
async function callerTurn(itemId: string, values: SlotValues | null = null) {
  if (values) callSession.applyIntakeOperation.mockResolvedValueOnce(backend(values));
  model.callbacks.onCallerTurn(itemId);
  await settle();
}

describe('the realtime receptionist', () => {
  it('runs one conversation, and opens it with the stored greeting', async () => {
    await startCall();

    expect(model.instructions).toContain('telephone receptionist for Liberty Towing');
    expect(model.instructions).toContain('+18174098408');
    expect(model.lastRequest()?.instructions).toContain(`Say exactly this and nothing else: "${GREETING}"`);
    expect(model.lastRequest()?.toolChoice).toBe('none');

    socket.fromTwilio({ event: 'media', media: { payload: Buffer.alloc(160).toString('base64') } });
    expect(model.appendAudio).toHaveBeenCalledTimes(1);
  });

  it('does not record the greeting twice when it is spoken as stored', async () => {
    await greeted();
    await settle();
    expect(callSession.appendAiTranscriptLine).not.toHaveBeenCalled();
  });
});

describe('the backend decides what comes next', () => {
  it('pins the required action to the conversation before every reply', async () => {
    await greeted();
    model.requestResponse.mockClear();

    await callerTurn('c1', MIKE);

    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'state' }, { callerTurn: 1 });
    expect(model.lastNote()).toContain('REQUIRED ACTION: ASK_LOCATION_DETAIL');
    expect(model.lastNote()).toContain('DO NOT ASK ABOUT:');
    expect(model.lastNote()).toContain('the callback number');
    // The reply is requested only after the note is in place.
    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(model.addNote.mock.invocationCallOrder[0]!).toBeLessThan(model.requestResponse.mock.invocationCallOrder[0]!);
  });

  it('counts caller turns from the audio and hands them to the tools', async () => {
    await greeted();
    await callerTurn('c1');
    await callerTurn('c2');

    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { callerIdConfirmed: true, callId: 'someone-else' } }]);
    await settle();

    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      { kind: 'update', slots: {}, callerIdConfirmed: true },
      { callerTurn: 2 },
    );
    expect(model.submitToolResults).toHaveBeenCalledWith([{ callId: 'fc1', output: { ok: true } }], undefined);
  });

  it('sends the fresh required action back with tool results', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(MIKE));

    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { customerName: 'Mike' } }]);
    await settle();

    const [, note] = model.submitToolResults.mock.calls.at(-1)!;
    expect(note).toContain('REQUIRED ACTION: ASK_LOCATION_DETAIL');
  });

  it('lets a turn that ends while tools run be answered by the tool results\' reply', async () => {
    await greeted();
    const saving = deferred<unknown>();
    callSession.applyIntakeOperation.mockReturnValueOnce(saving.promise);
    model.requestResponse.mockClear();

    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { location: 'I-95' } }]);
    await settle();
    model.callbacks.onCallerTurn('c1');
    await settle();
    expect(model.requestResponse).not.toHaveBeenCalled();

    saving.resolve(backend(MIKE));
    await settle();
    expect(model.submitToolResults).toHaveBeenCalledTimes(1);
    expect(model.requestResponse).not.toHaveBeenCalled();
  });

  it('stops a reply that asks about something that must wait, and redirects once per turn', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.addNote.mockClear();

    model.say('a1', 'Got it, Mike. Can you confirm if this is the best number to reach you?', { finish: false });
    await settle();

    expect(model.cancelResponse).toHaveBeenCalled();
    expect(socket.count('clear')).toBe(1);
    expect(model.truncate).toHaveBeenCalledWith('a1', 0);
    expect(model.lastNote()).toContain('the callback number has to wait');
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.ACTION_DEVIATION,
      expect.objectContaining({ asked: 'callback_number', required: 'ASK_LOCATION_DETAIL', redirected: true }),
    );

    // A second deviation in the same turn is logged, not redirected again.
    model.say('a2', 'What is your name?', { finish: false });
    await settle();
    expect(model.addNote).toHaveBeenCalledTimes(1);
  });

  it('lets the right question through', async () => {
    await greeted();
    await callerTurn('c1', MIKE);

    model.say('a1', "I'm sorry you're dealing with that, Mike. Where exactly on I-95 are you?");
    await settle();
    expect(model.cancelResponse).not.toHaveBeenCalled();
  });
});

describe('tools', () => {
  it('hang up only after the goodbye that follows a completed request has played', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce({
      output: { callEnded: true, leadCreated: true },
      ended: true,
      outcome: 'lead_created',
      plan: null,
    });

    model.callTools([{ callId: 'fc1', name: 'complete_request', arguments: { callerConfirmed: true } }]);
    await settle();
    model.say('bye', 'Thanks Mike, the towing team will contact you. Goodbye.');
    await settle();
    expect(socket.closed).toBe(false);

    socket.play();
    await settle();
    expect(socket.closed).toBe(true);
    expect(model.close).toHaveBeenCalled();
    expect(callSession.handleEvent).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'HANGUP' }, { phrase: false });
  });
});

describe('barge-in', () => {
  it('stops the reply, clears Twilio, and truncates the model\'s memory to what was heard', async () => {
    await greeted();
    model.say('a1', 'Can you tell me the nearest exit', { chunks: 2, finish: false });
    socket.play(1); // the caller heard the first 0.2 s of 0.4 s

    model.callbacks.onSpeechStarted();
    await settle();

    expect(model.cancelResponse).toHaveBeenCalled();
    expect(socket.count('clear')).toBe(1);
    expect(model.truncate).toHaveBeenCalledWith('a1', 200);
    expect(callSession.appendAiTranscriptLine).toHaveBeenCalledWith('biz-1', 'call-1', 'Can you tell [interrupted]');
    expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.AI_INTERRUPTED, { heardMs: 200 });

    const media = socket.count('media');
    model.callbacks.onAudio('a1', Buffer.alloc(1600, 0xff));
    expect(socket.count('media')).toBe(media);
  });

  it('does nothing when the caller speaks while the receptionist is silent', async () => {
    await greeted();
    model.callbacks.onSpeechStarted();
    expect(socket.count('clear')).toBe(0);
    expect(model.cancelResponse).not.toHaveBeenCalled();
  });
});

describe('guardrails on live speech', () => {
  it('stop a reply that promises an arrival time, and have the model continue without it', async () => {
    await greeted();
    model.say('a1', 'No problem, a truck will be there in 20 minutes', { finish: false });
    await settle();

    expect(model.cancelResponse).toHaveBeenCalled();
    expect(socket.count('clear')).toBe(1);
    expect(model.truncate).toHaveBeenCalledWith('a1', 0);
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.GUARDRAIL_TRIPPED,
      expect.objectContaining({ violations: ['arrival_time_promise'], attempt: 1 }),
    );
    expect(model.lastNote()).toContain('Your last reply was stopped before the caller heard it');
  });

  it('fall back to a fixed line when the model breaks a rule twice', async () => {
    await greeted();
    model.say('a1', 'A tow is about $80', { finish: false });
    model.say('a2', 'We have a truck available near you', { finish: false });
    await settle();

    expect(model.lastRequest()).toEqual(
      expect.objectContaining({ toolChoice: 'none', instructions: expect.stringContaining(SAFE_FALLBACK_LINE) }),
    );
  });

  it('let the model repeat pricing the business configured, once it has looked it up', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce({
      output: { answered: true, fact: 'Pricing information: Local tows start at $75.' },
      ended: false,
      outcome: null,
      plan: null,
    });
    model.callTools([{ callId: 'fc1', name: 'get_business_information', arguments: { topic: 'pricing', question: 'How much?' } }]);
    await settle();

    model.say('a1', 'Local tows start at $75.');
    await settle();
    expect(model.cancelResponse).not.toHaveBeenCalled();
  });
});

describe('silence', () => {
  it('is counted by the backend after the reply has played, and phrased by the model', async () => {
    await startCall();
    model.say('greet', GREETING);
    await settle();

    vi.advanceTimersByTime(7_500); // still playing: no check-in yet
    await settle();
    expect(callSession.applyIntakeOperation).not.toHaveBeenCalled();

    socket.play();
    await settle();
    vi.advanceTimersByTime(7_100);
    await settle();

    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'silence' });
    expect(model.lastRequest()?.instructions).toContain('The caller has gone quiet');
  });

  it('ends the call with a goodbye when the backend says silence has gone on too long', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce({ output: {}, ended: true, outcome: 'callback_created', plan: null });

    vi.advanceTimersByTime(7_100);
    await settle();
    expect(model.lastRequest()?.instructions).toContain('the call is ending');

    model.say('bye', 'The towing team will contact you. Goodbye.');
    socket.play();
    await settle();
    expect(socket.closed).toBe(true);
  });
});

describe('transcript and usage', () => {
  it('writes lines in speaking order even when the caller\'s words are transcribed late', async () => {
    await greeted();

    await callerTurn('c1');
    model.say('a1', 'Sure, where is the vehicle?');
    socket.play();
    await settle();
    expect(order).toEqual([]); // the reply waits for the caller line before it

    model.callbacks.onCallerTranscript('c1', 'I need a tow');
    await settle();

    expect(order).toEqual(['caller: I need a tow', 'ai: Sure, where is the vehicle?']);
  });

  it('records what was said and the token usage, then finalises the call', async () => {
    await greeted();
    await callerTurn('c1');
    model.callbacks.onCallerTranscript('c1', 'My name is Mike');
    model.callbacks.onUsage?.({
      kind: 'response',
      usage: {
        input_token_details: { text_tokens: 900, audio_tokens: 40, cached_tokens_details: { text_tokens: 600, audio_tokens: 0 } },
        output_token_details: { text_tokens: 20, audio_tokens: 120 },
      },
    });
    await settle();

    socket.fromTwilio({ event: 'stop', streamSid: 'MZ1' });
    await settle();

    expect(order).toEqual(['caller: My name is Mike']);
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.AI_USAGE,
      expect.objectContaining({ textIn: 900, cachedTextIn: 600, audioOut: 120 }),
    );
    expect(callSession.handleEvent).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'HANGUP' }, { phrase: false });
  });
});

describe('heardPortion', () => {
  it('keeps the share of words matching the share of audio played', () => {
    expect(heardPortion('one two three four', 800, 1600)).toBe('one two');
    expect(heardPortion('one two three four', 0, 1600)).toBe('');
    expect(heardPortion('one two', 5000, 1600)).toBe('one two');
  });
});
