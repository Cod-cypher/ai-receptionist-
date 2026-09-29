import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallEventType, type SlotValues } from '@towai/shared';

import { describeIntake } from '../../../conversation/intake';
import { determineNextAction } from '../../../conversation/next-action';
import { initialContext } from '../../../conversation/types';
import {
  BARGE_IN_VOICED_MS,
  HOLD_RESUME_SILENCE_MS,
  REPLY_STALL_LIMIT,
  REPLY_STALL_MS,
  RealtimeVoiceGateway,
  heardPortion,
} from './realtime-voice.gateway';
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
    readonly transcriptionPrompt?: string,
  ) {}

  /** The reason given with the latest request for a reply, as OpenAI would hand it back. */
  private lastReason(): string | undefined {
    const asked = this.requestResponse.mock.calls.map(([request], i) => ({
      order: this.requestResponse.mock.invocationCallOrder[i]!,
      reason: request?.reason,
    }));
    const afterTools = this.submitToolResults.mock.calls.map(([, , request], i) => ({
      order: this.submitToolResults.mock.invocationCallOrder[i]!,
      reason: (request as ResponseRequest | undefined)?.reason ?? 'tool-results',
    }));
    return [...asked, ...afterTools].sort((a, b) => a.order - b.order).at(-1)?.reason;
  }

  /**
   * The model starts a response, says `text` as `chunks` × 0.2 s of audio, and
   * optionally finishes. It answers the latest request unless `reason` names
   * an earlier one.
   */
  say(
    itemId: string,
    text: string,
    options: { chunks?: number; finish?: boolean; requested?: boolean; reason?: string } = {},
  ): string {
    const id = `resp-${++this.responses}`;
    this.callbacks.onResponseStarted(id, options.requested ?? true, options.reason ?? this.lastReason());
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
function backend(values: SlotValues, options: { phoneConfirmed?: boolean } = {}) {
  const ctx = { ...initialContext({ customerPhone: '+18174098408', ...values }), phoneConfirmed: options.phoneConfirmed ?? false };
  const plan = determineNextAction(ctx, { emergencyNumber: '911' });
  return { output: { state: describeIntake(ctx, plan) }, ended: false, outcome: null, plan };
}

const MIKE: SlotValues = { serviceType: 'vehicle towing', customerName: 'Mike', vehicleType: 'semi truck', location: 'I-95' };

/** From now on every state request returns the backend's view of `values`; other operations behave as before. */
function stateIs(values: SlotValues) {
  const previous = callSession.applyIntakeOperation.getMockImplementation()!;
  callSession.applyIntakeOperation.mockImplementation(async (b: string, c: string, op: { kind: string }, meta?: unknown) =>
    op.kind === 'state' ? backend(values) : previous(b, c, op, meta),
  );
}

let socket: FakeTwilioSocket;
let model: FakeConversation;
let order: string[];
/** Judges words said over the receptionist. Says nothing by default, so the word lists decide. */
let judge: { judgeOverlap: ReturnType<typeof vi.fn> };
let callSession: {
  applyIntakeOperation: ReturnType<typeof vi.fn>;
  judgeCallerLine: ReturnType<typeof vi.fn>;
  judgeReply: ReturnType<typeof vi.fn>;
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
    judgeCallerLine: vi.fn(async () => null),
    judgeReply: vi.fn(async () => null),
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

  judge = { judgeOverlap: vi.fn(async () => null) };
  const gateway = new RealtimeVoiceGateway(
    callSession as never,
    businessConfig as never,
    ({ instructions, callbacks, transcriptionPrompt }) => {
      model = new FakeConversation(instructions, callbacks, transcriptionPrompt);
      return model;
    },
    { next: () => ({ text: 'One moment.', audio: Buffer.alloc(1600, 0xff) }) },
    judge,
  );
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

/** μ-law frames from the caller: full-scale (speech) or digital silence. */
const LOUD = Buffer.alloc(160, 0x00);
const QUIET = Buffer.alloc(160, 0xff);
function callerAudio(frame: Buffer, ms: number) {
  for (let i = 0; i < ms / 20; i += 1) {
    socket.fromTwilio({ event: 'media', streamSid: 'MZ1', media: { payload: frame.toString('base64') } });
  }
}

/** The caller says a short word over the receptionist, then goes quiet: the reply resumes. */
function briefOverlap() {
  model.callbacks.onSpeechStarted();
  callerAudio(LOUD, 200);
  callerAudio(QUIET, HOLD_RESUME_SILENCE_MS);
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

  it('opens one session per call, even if the stream start repeats', async () => {
    await startCall();
    const first = model;
    await startCall();

    expect(model).toBe(first);
    expect(first.requestResponse).toHaveBeenCalledTimes(1);
  });

  it('opens no session for a call that hung up while it was starting', async () => {
    model = null as unknown as FakeConversation;
    socket.fromTwilio({
      event: 'start',
      streamSid: 'MZ1',
      start: { callSid: 'CA1', customParameters: { businessId: 'biz-1', callId: 'call-1', greeting: GREETING } },
    });
    socket.fromTwilio({ event: 'stop' });
    await settle();

    expect(model).toBeNull();
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
    // The state predates the caller's latest words: save them first.
    expect(model.lastNote()).toContain('does not include anything from what the caller just said');
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
    expect(model.submitToolResults).toHaveBeenCalledWith([{ callId: 'fc1', output: { ok: true } }], undefined, undefined);
  });

  it('sends the fresh required action back with tool results', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(MIKE));

    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { customerName: 'Mike' } }]);
    await settle();

    const [, note] = model.submitToolResults.mock.calls.at(-1)!;
    expect(note).toContain('REQUIRED ACTION: ASK_LOCATION_DETAIL');
  });

  it('sends the state once, in the note that is replaced each turn, not again in every tool result', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce({ ...backend(MIKE), output: { saved: { customerName: 'Mike' }, rejected: [], ...backend(MIKE).output } });

    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { customerName: 'Mike' } }]);
    await settle();

    const [results, note] = model.submitToolResults.mock.calls.at(-1)!;
    expect(results).toEqual([{ callId: 'fc1', output: { saved: { customerName: 'Mike' }, rejected: [] } }]);
    expect(note).toContain('CALL STATE');
  });

  it('still answers a request for the state with the state', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(MIKE));

    model.callTools([{ callId: 'fc1', name: 'get_call_state', arguments: {} }]);
    await settle();

    const [results] = model.submitToolResults.mock.calls.at(-1)!;
    expect(results[0].output.state).toEqual(expect.objectContaining({ nextAction: 'ASK_LOCATION_DETAIL' }));
  });

  it('pins the state note, so the conversation holds one state at a time', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    expect(model.addNote).toHaveBeenLastCalledWith(expect.stringContaining('CALL STATE'), { pinned: true });
  });

  it('reads the details back word for word from the backend, the number digit by digit', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce(
      backend({ ...MIKE, location: 'I-95, exit 42', vehicleMovable: false }, { phoneConfirmed: true }),
    );

    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { vehicleMovable: false } }]);
    await settle();

    const [, note, request] = model.submitToolResults.mock.calls.at(-1)!;
    expect(note).toContain('REQUIRED ACTION: CONFIRM_DETAILS');
    expect(request).toEqual(expect.objectContaining({ toolChoice: 'none' }));
    expect(request.instructions).toContain(
      'Say exactly this and nothing else: "Let me read that back. Your name is Mike, you need a vehicle towing, the vehicle is at I-95, exit 42, it is a semi truck, it can\'t move, the callback number is 8 1 7, 4 0 9, 8 4 0 8. Is that all correct?"',
    );
  });

  it('tells the model what it already said alongside a tool call, so the reply carries on from it', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(MIKE));

    const id = model.say('a1', 'Got it, Mike.', { finish: false });
    model.callbacks.onResponseDone({
      id,
      status: 'completed',
      toolCalls: [{ callId: 'fc1', name: 'update_call_information', arguments: '{"customerName":"Mike"}' }],
    });
    await settle();

    const [, note] = model.submitToolResults.mock.calls.at(-1)!;
    expect(note).toContain('You ALREADY SAID: "Got it, Mike."');
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
    socket.play(2); // the caller heard the first 0.2 s of 0.4 s

    model.callbacks.onSpeechStarted();
    // Playback stops at once, but the reply is only given up once the caller
    // has clearly taken the floor.
    expect(socket.count('clear')).toBe(1);
    expect(model.cancelResponse).not.toHaveBeenCalled();
    callerAudio(LOUD, BARGE_IN_VOICED_MS);
    await settle();

    expect(model.cancelResponse).toHaveBeenCalled();
    expect(model.truncate).toHaveBeenCalledWith('a1', 200);
    expect(callSession.appendAiTranscriptLine).toHaveBeenCalledWith('biz-1', 'call-1', 'Can you tell [interrupted]');
    expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.AI_INTERRUPTED, { heardMs: 200 });

    const media = socket.count('media');
    model.callbacks.onAudio('a1', Buffer.alloc(1600, 0xff));
    expect(socket.count('media')).toBe(media);

    // The interruption is a normal caller turn: the backend is asked what comes next.
    model.requestResponse.mockClear();
    await callerTurn('c1', MIKE);
    expect(model.requestResponse).toHaveBeenCalledWith(expect.objectContaining({ reason: 'caller-turn' }));
  });

  it('tells the backend how much of the read-back the caller heard when they speak over it', async () => {
    // The real call: "How long will it take?" came 8 s into the read-back.
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce(
      backend({ ...MIKE, location: 'I-95, exit 42', vehicleMovable: false }, { phoneConfirmed: true }),
    );
    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { vehicleMovable: false } }]);
    await settle();

    model.say('rb', 'Let me read that back. Your name is Mike, you need a tow. Is that all correct?', { chunks: 4, finish: false });
    socket.play(2); // a quarter of it heard
    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, BARGE_IN_VOICED_MS);
    await settle();

    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', {
      kind: 'read_back_cut',
      heard: 'Let me read that',
    });
  });

  it('says nothing to the backend about any other reply that is cut short', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.say('a1', 'Where exactly on I-95 are you, the nearest exit or a mile marker?', { chunks: 4, finish: false });
    socket.play(2);
    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, BARGE_IN_VOICED_MS);
    await settle();

    expect(callSession.applyIntakeOperation).not.toHaveBeenCalledWith('biz-1', 'call-1', expect.objectContaining({ kind: 'read_back_cut' }));
  });

  it('pauses for a word of acknowledgement and carries on from where the caller stopped hearing', async () => {
    await greeted();
    const text = 'So that is a Honda Civic at exit 12 on I-95, and the best number is the one you are calling from.';
    model.say('a1', text, { chunks: 4 }); // 0.8 s of audio, 40 frames
    socket.play(2); // 0.2 s heard
    const sentBefore = socket.count('media');

    briefOverlap();
    await settle();

    expect(socket.count('clear')).toBe(1);
    expect(model.cancelResponse).not.toHaveBeenCalled();
    expect(model.truncate).not.toHaveBeenCalled();
    // The unheard 0.6 s (30 frames) is sent again.
    expect(socket.count('media')).toBe(sentBefore + 30);

    // The caller's "okay" is a turn, but not one that needs a reply.
    model.requestResponse.mockClear();
    model.callbacks.onCallerTurn('c1');
    socket.play();
    model.callbacks.onCallerTranscript('c1', 'Okay.');
    await settle();

    expect(model.requestResponse).not.toHaveBeenCalled();
    expect(callSession.applyIntakeOperation).not.toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'state' }, expect.anything());
    expect(order).toEqual([`ai: ${text}`, 'caller: Okay.']);

    // Instead the receptionist waits for the caller, as after any finished reply.
    vi.advanceTimersByTime(7_100);
    await settle();
    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'silence' });
  });

  it('answers a brief overlap that responds to its question, once the caller has heard the rest', async () => {
    await greeted();
    model.say('a1', 'Is that all correct?', { chunks: 2 });
    socket.play(1);

    briefOverlap();
    model.callbacks.onCallerTurn('c1');
    await settle();
    expect(model.requestResponse).toHaveBeenCalledTimes(1); // still only the greeting

    socket.play();
    stateIs(MIKE);
    model.callbacks.onCallerTranscript('c1', 'Yes.');
    await settle();

    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'state' }, { callerTurn: 1 });
    expect(model.lastNote()).toContain('The caller said "Yes." while you were still speaking');
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-turn' }));
  });

  it('answers an overlap the judge reads as an answer, whatever the word lists say', async () => {
    await greeted();
    const text = 'So that is a Honda Civic at exit 12 on I-95.';
    model.say('a1', text, { chunks: 2 });
    socket.play(1);

    briefOverlap();
    model.callbacks.onCallerTurn('c1');
    socket.play();
    // "Right" alone is a backchannel to the word lists; the judge hears a correction.
    judge.judgeOverlap.mockResolvedValueOnce({ overlap: { text: 'Right, exit 14.', answers: 0.92 } });
    stateIs(MIKE);
    model.callbacks.onCallerTranscript('c1', 'Right, exit 14.');
    await settle();

    expect(judge.judgeOverlap).toHaveBeenCalledWith('Right, exit 14.', text);
    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'state' }, { callerTurn: 1 });
    expect(model.lastNote()).toContain('The caller said "Right, exit 14." while you were still speaking');
  });

  it('leaves an overlap the judge reads as an acknowledgement, in words the lists do not know', async () => {
    await greeted();
    model.say('a1', 'So that is a Honda Civic at exit 12 on I-95.', { chunks: 2 });
    socket.play(1);

    briefOverlap();
    model.callbacks.onCallerTurn('c1');
    socket.play();
    model.requestResponse.mockClear();
    judge.judgeOverlap.mockResolvedValueOnce({ overlap: { text: 'Got it, cheers.', answers: 0.06 } });
    model.callbacks.onCallerTranscript('c1', 'Got it, cheers.');
    await settle();

    expect(model.requestResponse).not.toHaveBeenCalled();
    expect(callSession.applyIntakeOperation).not.toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'state' }, expect.anything());
  });

  it('falls back to the word lists when the judge is unsure', async () => {
    await greeted();
    model.say('a1', 'Is that all correct?', { chunks: 2 });
    socket.play(1);

    briefOverlap();
    model.callbacks.onCallerTurn('c1');
    socket.play();
    judge.judgeOverlap.mockResolvedValueOnce({ overlap: { text: 'Yes.', answers: 0.5 } });
    stateIs(MIKE);
    model.callbacks.onCallerTranscript('c1', 'Yes.');
    await settle();

    // "Yes." after a question is answered, as before the judge existed.
    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'state' }, { callerTurn: 1 });
  });

  it('passes each caller line to the backend with the turn it was spoken on', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.callbacks.onCallerTranscript('c1', 'It is on I-95.');
    await callerTurn('c2', MIKE);
    model.callbacks.onCallerTranscript('c2', 'Yes.');
    await settle();

    // Applied at once, by the rules: the line is judged beside the call.
    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      { kind: 'caller_speech', text: 'It is on I-95.' },
      { callerTurn: 1, judge: false },
    );
    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'caller_speech', text: 'Yes.' }, { callerTurn: 2, judge: false });
  });

  it('has everything it said in reply to a turn judged against that turn, once the caller has heard it', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.callbacks.onCallerTranscript('c1', 'How much will it cost me?');

    model.say('a1', "I don't have the current price on this line.");
    socket.play();
    await settle();
    expect(callSession.judgeReply).toHaveBeenLastCalledWith('biz-1', 'call-1', "I don't have the current price on this line.", 1);

    const judgment = { kind: 'judgment', text: 'How much will it cost me?', judgments: { reply: { answered: 0.97 } } };
    callSession.judgeReply.mockResolvedValueOnce(judgment);
    model.say('a2', "Where's the vehicle?");
    socket.play();
    await settle();

    expect(callSession.judgeReply).toHaveBeenLastCalledWith(
      'biz-1',
      'call-1',
      "I don't have the current price on this line. Where's the vehicle?",
      1,
    );
    expect(callSession.applyIntakeOperation).toHaveBeenLastCalledWith('biz-1', 'call-1', judgment, { callerTurn: 1 });
  });

  it('does not have the greeting or a filler judged as a reply', async () => {
    await greeted();
    expect(callSession.judgeReply).not.toHaveBeenCalled();

    await callerTurn('c1');
    vi.advanceTimersByTime(1_100); // "One moment."
    socket.play();
    model.callbacks.onCallerTranscript('c1', 'I need a tow');
    await settle();
    expect(callSession.judgeReply).not.toHaveBeenCalled();
  });

  it('never makes the next reply wait for the judge: a line is judged beside the call and folded in when ready', async () => {
    await greeted();
    const judging = deferred<unknown>();
    callSession.judgeCallerLine.mockReturnValueOnce(judging.promise);

    await callerTurn('c1', MIKE);
    model.callbacks.onCallerTranscript('c1', 'Why do you keep cutting me off?');
    await settle();
    expect(callSession.judgeCallerLine).toHaveBeenCalledWith('biz-1', 'call-1', 'Why do you keep cutting me off?');

    // The judge is still thinking, and the caller's next turn is answered all the same.
    model.say('a1', 'Sorry about that. What has happened?');
    socket.play();
    model.requestResponse.mockClear();
    await callerTurn('c2', MIKE);
    expect(model.requestResponse).toHaveBeenCalledWith({ reason: 'caller-turn' });

    const judgment = { kind: 'judgment', text: 'Why do you keep cutting me off?', judgments: { move: { move: 'complaint' } } };
    judging.resolve(judgment);
    await settle();
    expect(callSession.applyIntakeOperation).toHaveBeenLastCalledWith('biz-1', 'call-1', judgment, { callerTurn: 1 });
  });

  it('lets a burst of noise pass, and gives up the reply if the caller then keeps talking', async () => {
    await greeted();
    model.say('a1', 'Where exactly on I-95 are you?', { chunks: 3, finish: false });
    const sentBefore = socket.count('media');

    model.callbacks.onSpeechStarted();
    callerAudio(QUIET, HOLD_RESUME_SILENCE_MS); // nothing voiced: resumed within a third of a second
    expect(model.cancelResponse).not.toHaveBeenCalled();
    expect(socket.count('media')).toBe(sentBefore + 30); // all 30 unheard frames sent again

    callerAudio(LOUD, BARGE_IN_VOICED_MS); // the caller was only drawing breath
    await settle();
    expect(model.cancelResponse).toHaveBeenCalled();
    expect(model.truncate).toHaveBeenCalledWith('a1', 0);
    expect(socket.count('clear')).toBe(2);
  });

  it('answers a brief overlap after a moment even if its words have not arrived', async () => {
    await greeted();
    model.say('a1', 'What kind of vehicle is it?', { chunks: 2 });
    socket.play(1);

    briefOverlap();
    model.callbacks.onCallerTurn('c1');
    socket.play();
    await settle();
    expect(callSession.applyIntakeOperation).not.toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'state' }, expect.anything());

    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(MIKE));
    vi.advanceTimersByTime(1_600);
    await settle();
    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'state' }, { callerTurn: 1 });
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-turn' }));
  });

  it('keeps a reply the caller has not heard yet, however long they talk over its silence', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.callbacks.onResponseStarted('r1', true); // generating; nothing sent yet
    const sentBefore = socket.count('media');

    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, BARGE_IN_VOICED_MS + 200);
    model.callbacks.onSpokenText('a1', 'Where exactly on I-95 are you?');
    model.callbacks.onAudio('a1', Buffer.alloc(1600, 0xff));
    expect(model.cancelResponse).not.toHaveBeenCalled();
    expect(socket.count('media')).toBe(sentBefore); // held until the caller stops

    model.callbacks.onCallerTurn('c2');
    model.callbacks.onResponseDone({ id: 'r1', status: 'completed', toolCalls: [] });
    await settle();
    expect(socket.count('media')).toBe(sentBefore + 10); // now played in full
    expect(model.truncate).not.toHaveBeenCalled();

    // "Hello?" was the caller reacting to the silence; the reply answered it.
    model.requestResponse.mockClear();
    socket.play();
    model.callbacks.onCallerTranscript('c2', 'Hello? Hello?');
    await settle();
    expect(model.requestResponse).not.toHaveBeenCalled();
  });

  it('does not add up separate short bursts after a resume into an interruption', async () => {
    await greeted();
    model.say('a1', 'So that is a Honda Civic at exit 12, and the number is the one you are calling from.', { chunks: 6, finish: false });
    socket.play(1);

    briefOverlap(); // resumed
    callerAudio(LOUD, 400);
    callerAudio(QUIET, HOLD_RESUME_SILENCE_MS);
    callerAudio(LOUD, 400);
    expect(model.cancelResponse).not.toHaveBeenCalled();

    callerAudio(LOUD, BARGE_IN_VOICED_MS); // one long burst: a real interruption
    await settle();
    expect(model.cancelResponse).toHaveBeenCalled();
  });

  it('takes OpenAI\'s word for how long the caller spoke when their turn ends first', async () => {
    await greeted();
    model.say('a1', 'Where exactly on I-95 are you?', { finish: false });

    model.callbacks.onSpeechStarted();
    model.callbacks.onSpeechStopped?.(1_500);
    await settle();
    expect(model.cancelResponse).toHaveBeenCalled();
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

describe('a slow reply', () => {
  it('is covered by a filler line in the receptionist\'s voice, which is not needed once the reply has begun', async () => {
    await greeted();
    await callerTurn('c1');
    const before = socket.count('media');

    vi.advanceTimersByTime(1_100);
    socket.play();
    await settle();
    expect(socket.count('media')).toBe(before + 10);

    model.say('a1', 'Where is the vehicle?');
    socket.play();
    model.callbacks.onCallerTranscript('c1', 'I need a tow');
    await settle();
    expect(order).toEqual(['caller: I need a tow', 'ai: One moment.', 'ai: Where is the vehicle?']);

    // The next reply arrives quickly: no filler.
    await callerTurn('c2');
    model.say('a2', 'What kind of vehicle is it?');
    const sent = socket.count('media');
    vi.advanceTimersByTime(1_100);
    await settle();
    expect(socket.count('media')).toBe(sent);
  });

  it('does not play a filler over the model\'s reply, and does not truncate a filler in the model\'s memory', async () => {
    await greeted();
    await callerTurn('c1');
    vi.advanceTimersByTime(1_100);
    socket.play(1);

    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, BARGE_IN_VOICED_MS);
    await settle();
    expect(model.truncate).not.toHaveBeenCalled();
    expect(callSession.appendAiTranscriptLine).not.toHaveBeenCalledWith('biz-1', 'call-1', expect.stringContaining('One moment'));
  });
});

describe('a reply that is owed', () => {
  const silences = () => callSession.applyIntakeOperation.mock.calls.filter(([, , op]) => op.kind === 'silence').length;

  it('is never counted as the caller going silent, however long it takes to start', async () => {
    // The real call: the caller gave their name and waited 22 s for the next
    // question. They were counted silent twice and the call was closed.
    await greeted();
    await callerTurn('c1', MIKE);

    vi.advanceTimersByTime(7_100);
    await settle();
    vi.advanceTimersByTime(7_100);
    await settle();
    expect(silences()).toBe(0);
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.PROVIDER_ERROR,
      expect.objectContaining({ stage: 'reply_stalled' }),
    );

    // Once the reply has been said and heard, quiet is the caller's again.
    model.say('a1', 'Where exactly on I-95 are you?');
    socket.play();
    await settle();
    vi.advanceTimersByTime(7_100);
    await settle();
    expect(silences()).toBe(1);
  });

  it('is covered by a filler each time it stalls, and given up on only after a long time', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    vi.advanceTimersByTime(1_100); // the usual filler for a slow reply
    socket.play();
    const afterFirst = socket.count('media');

    vi.advanceTimersByTime(REPLY_STALL_MS);
    socket.play();
    expect(socket.count('media')).toBe(afterFirst + 10);

    for (let i = 0; i < REPLY_STALL_LIMIT; i += 1) {
      vi.advanceTimersByTime(REPLY_STALL_MS);
      socket.play();
    }
    await settle();
    // Nothing came. The line is idle again and silence is handled as usual.
    vi.advanceTimersByTime(7_100);
    await settle();
    expect(silences()).toBe(1);
  });

  it('is asked for again when OpenAI fails it', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.requestResponse.mockClear();

    model.callbacks.onResponseStarted('r1', true, 'caller-turn');
    model.callbacks.onResponseDone({ id: 'r1', status: 'failed', toolCalls: [], failure: 'rate_limit_exceeded: slow down' });
    vi.advanceTimersByTime(7_100); // owed again: still not the caller's silence
    await settle();

    expect(model.requestResponse).toHaveBeenCalledWith({ reason: 'retry' });
    expect(silences()).toBe(0);
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.PROVIDER_ERROR,
      expect.objectContaining({ stage: 'response_failed', message: 'rate_limit_exceeded: slow down' }),
    );
  });

  it('is dropped unheard if it only arrives once the call is ending, and the goodbye is what closes the line', async () => {
    await greeted();
    await callerTurn('c1', MIKE); // the reply to this is asked for, and stalls
    callSession.applyIntakeOperation.mockImplementationOnce(async (_b: string, _c: string, op: { text?: string }) => {
      order.push(`caller: ${op.text}`);
      return { output: {}, ended: true, outcome: 'lead_created', plan: null };
    });
    model.callbacks.onCallerTranscript('c1', 'My name is Ali'); // the backend ends the call on this line
    await settle();
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'turn-limit-goodbye' }));
    const sent = socket.count('media');

    // The stalled reply starts at last: a question, to a caller about to be hung up on.
    model.say('late', 'Is this the best number to reach you?', { reason: 'caller-turn' });
    socket.play();
    await settle();
    expect(model.cancelResponse).toHaveBeenCalledWith({ keepQueued: true });
    expect(socket.count('media')).toBe(sent);
    expect(socket.closed).toBe(false);

    model.say('bye', 'The towing team will contact you. Goodbye.');
    socket.play();
    await settle();
    expect(socket.closed).toBe(true);
    expect(order).toEqual(['caller: My name is Ali', 'ai: The towing team will contact you. Goodbye.']);
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
    expect(model.lastRequest()?.instructions).toContain('Say exactly this and nothing else: "Are you still there?"');
    expect(model.lastRequest()?.toolChoice).toBe('none');
  });

  it('does not check in on a caller who spoke up while the silence was being counted', async () => {
    await greeted();
    const counting = deferred<unknown>();
    callSession.applyIntakeOperation.mockReturnValueOnce(counting.promise);

    vi.advanceTimersByTime(7_100);
    await settle();
    model.callbacks.onCallerTurn('c1');
    counting.resolve({ output: { silenceStreak: 1 }, ended: false, outcome: null, plan: null });
    await settle();

    const requests = model.requestResponse.mock.calls.map(([r]) => r?.instructions ?? '');
    expect(requests.some((i) => i.includes('gone quiet'))).toBe(false);
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-turn' }));
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
  it('ignores the receptionist\'s own words heard back as caller speech', async () => {
    await greeted();
    model.say('a1', 'Where exactly on I-95 are you?');
    socket.play();

    await callerTurn('c1');
    model.callbacks.onCallerTranscript('c1', 'Thanks for calling Liberty Towing, how can I help?');
    await callerTurn('c2');
    model.callbacks.onCallerTranscript('c2', 'exactly on I-95 are you');
    await callerTurn('c3');
    model.callbacks.onCallerTranscript('c3', 'Exit 12');
    await settle();

    expect(order).toEqual(['ai: Where exactly on I-95 are you?', 'caller: Exit 12']);
  });

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
    model.say('a1', 'Thanks Mike. Where is the vehicle?');
    socket.play();
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

    expect(order).toEqual(['caller: My name is Mike', 'ai: Thanks Mike. Where is the vehicle?']);
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.AI_USAGE,
      expect.objectContaining({
        textIn: 900,
        cachedTextIn: 600,
        audioOut: 120,
        // How long the caller waited for that reply is recorded with the usage.
        replyLatencyMs: expect.objectContaining({ count: 1 }),
      }),
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
