import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallEventType, type SlotValues } from '@towai/shared';

import { linearToMulaw } from '../../audio/g711';
import { checkReply } from '../../../conversation/guardrails';
import { describeIntake, type IntakeSnapshot } from '../../../conversation/intake';
import { determineNextAction } from '../../../conversation/next-action';
import { initialContext } from '../../../conversation/types';
import { classifyCallerWords } from '../../realtime/caller-words';
import type { Filler } from '../../realtime/filler-bank';
import { alreadySaidNote } from '../../realtime/openai-realtime-conversation';
import {
  BARGE_IN_VOICED_MS,
  HOLD_RESUME_SILENCE_MS,
  PATIENT_NO_INPUT_MS,
  PLAY_THROUGH_VOICED_MS,
  REPLY_STALL_LIMIT,
  REPLY_STALL_MS,
  RealtimeVoiceGateway,
  WORDS_WAIT_MS,
  heardPortion,
  questionWithSave,
  readWordsWait,
  transcriptLine,
} from './realtime-voice.gateway';
import type {
  RealtimeConversation,
  RealtimeConversationCallbacks,
  ResponseRequest,
} from '../../realtime/openai-realtime-conversation';
import {
  ENDING_NOTE,
  SAFE_FALLBACK_LINE,
  SELF_TALK_RECOVERY_INSTRUCTIONS,
  SILENCE_CHECK_LINE,
  SILENCE_GOODBYE_INSTRUCTIONS,
  UNCONFIRMED_GOODBYE_INSTRUCTIONS,
  buildActionNote,
  buildReceptionistInstructions,
  confirmedGoodbyeLine,
  exactLineInstructions,
  greetingInstructions,
  guardrailRecoveryInstructions,
  redirectNote,
  remarkInstructions,
  renderReadBack,
} from '../../realtime/realtime-instructions';

// The real classifier, watched: a test can hold it to its contract ("a line
// that carries any detail is a detail") whatever version of it is in place.
vi.mock('../../realtime/caller-words', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../realtime/caller-words')>();
  return { ...actual, classifyCallerWords: vi.fn(actual.classifyCallerWords) };
});

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
  readonly addAssistantMessage = vi.fn<(text: string) => void>();
  readonly cancelResponse = vi.fn();
  readonly truncate = vi.fn();
  readonly close = vi.fn();
  private responses = 0;

  constructor(
    readonly instructions: string,
    readonly callbacks: RealtimeConversationCallbacks,
    readonly transcriptionPrompt?: string,
  ) {}

  /** The latest request for a reply, as OpenAI would hand its reason and number back. */
  private lastAsked(): { reason?: string; tag?: string } | undefined {
    const asked = this.requestResponse.mock.calls.map(([request], i) => ({
      order: this.requestResponse.mock.invocationCallOrder[i]!,
      reason: request?.reason,
      tag: request?.tag,
    }));
    // Tool results returned with `null` asked for no reply.
    const afterTools = this.submitToolResults.mock.calls.flatMap(([, , request], i) => {
      if (request === null) return [];
      const asked = request as ResponseRequest | undefined;
      return [{ order: this.submitToolResults.mock.invocationCallOrder[i]!, reason: asked?.reason ?? 'tool-results', tag: asked?.tag }];
    });
    return [...asked, ...afterTools].sort((a, b) => a.order - b.order).at(-1);
  }

  /**
   * The model starts a response, says `text` as `chunks` × 0.2 s of audio, and
   * optionally finishes. It answers the latest request unless `reason` names
   * an earlier one.
   */
  say(
    itemId: string,
    text: string,
    options: { chunks?: number; finish?: boolean; requested?: boolean; reason?: string; tag?: string } = {},
  ): string {
    const id = `resp-${++this.responses}`;
    // A reason named here is an earlier request's: its number is not known, so none is handed back.
    const asked = this.lastAsked();
    this.callbacks.onResponseStarted(id, options.requested ?? true, options.reason ?? asked?.reason, options.tag ?? (options.reason ? undefined : asked?.tag));
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

const MIKE: SlotValues = { serviceType: 'vehicle towing', customerName: 'Mike', vehicleType: 'semi truck', vehicleCondition: 'broke down', location: 'I-95' };

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
/** Filler lines in the receptionist's voice; records which kind of line was asked for. */
let fillers: { next: ReturnType<typeof vi.fn>; forCall: ReturnType<typeof vi.fn> };
let businessConfig: { load: ReturnType<typeof vi.fn> };
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
const FACTS = { name: 'Liberty Towing', tone: 'calm', serviceAreas: [], services: [], emergencyContact: null, businessInstructions: null };

/** The receptionist's instructions for a call from `callerNumber`, in whatever words they are written. */
const promptFor = (callerNumber: string) => buildReceptionistInstructions({ facts: FACTS as never, callerNumber });

/** The backend's state for a call holding `values`. */
const stateOf = (values: SlotValues, options: { phoneConfirmed?: boolean } = {}) => backend(values, options).output.state;

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
  businessConfig = {
    load: vi.fn().mockResolvedValue({ flow: { facts: FACTS } }),
  };

  judge = { judgeOverlap: vi.fn(async () => null) };
  fillers = { next: vi.fn(() => ({ text: 'One moment.', audio: Buffer.alloc(1600, 0xff) })), forCall: vi.fn(() => fillers) };
  connect();
});

/**
 * A gateway and a stream for one call. `wordsWaitMs`: how long the first
 * reply to a turn waits for the caller's words. 0, asking at once, unless a
 * test is about the wait, so a test can say what a reply is asked for with
 * as soon as the turn ends.
 */
function connect(options: { wordsWaitMs?: number } = {}) {
  const gateway = new RealtimeVoiceGateway(
    callSession as never,
    businessConfig as never,
    ({ instructions, callbacks, transcriptionPrompt }) => {
      model = new FakeConversation(instructions, callbacks, transcriptionPrompt);
      return model;
    },
    fillers,
    judge,
    undefined,
    undefined,
    options.wordsWaitMs ?? 0,
  );
  socket = new FakeTwilioSocket();
  gateway.handleConnection(socket as never);
}

afterEach(async () => {
  vi.useRealTimers();
  const actual = await vi.importActual<typeof import('../../realtime/caller-words')>('../../realtime/caller-words');
  vi.mocked(classifyCallerWords).mockImplementation(actual.classifyCallerWords);
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
  if (values) nextStateIs(values);
  model.callbacks.onCallerTurn(itemId);
  await settle();
}

/**
 * The next state request, and only that, returns the backend's view of
 * `values`. Not the next operation of any kind: an ask the caller never
 * heard is taken back just before the state is read.
 */
function nextStateIs(values: SlotValues) {
  const previous = callSession.applyIntakeOperation.getMockImplementation()!;
  let used = false;
  callSession.applyIntakeOperation.mockImplementation(async (b: string, c: string, op: { kind: string }, meta?: unknown) => {
    if (!used && op.kind === 'state') {
      used = true;
      return backend(values);
    }
    return previous(b, c, op, meta);
  });
}

/** μ-law frames from the caller: full-scale (speech) or digital silence. */
const LOUD = Buffer.alloc(160, 0x00);
const QUIET = Buffer.alloc(160, 0xff);
function callerAudio(frame: Buffer, ms: number) {
  for (let i = 0; i < ms / 20; i += 1) {
    socket.fromTwilio({ event: 'media', streamSid: 'MZ1', media: { payload: frame.toString('base64') } });
  }
}

/** The caller says a short word over the receptionist, then goes quiet: too short to pause for, the reply plays through it. */
function briefOverlap() {
  model.callbacks.onSpeechStarted();
  callerAudio(LOUD, 200);
  callerAudio(QUIET, HOLD_RESUME_SILENCE_MS);
}

/** The caller says a word or two over the receptionist, then goes quiet: long enough to pause for, and the reply resumes. */
function pausedOverlap() {
  model.callbacks.onSpeechStarted();
  callerAudio(LOUD, 400);
  callerAudio(QUIET, HOLD_RESUME_SILENCE_MS);
}

describe('the realtime receptionist', () => {
  it('runs one conversation, and opens it with the stored greeting', async () => {
    await startCall();

    expect(model.instructions).toBe(promptFor('+18174098408'));
    expect(model.lastRequest()?.instructions).toContain(greetingInstructions(GREETING));
    expect(model.lastRequest()?.toolChoice).toBe('none');

    socket.fromTwilio({ event: 'media', media: { payload: Buffer.alloc(160).toString('base64') } });
    expect(model.appendAudio).toHaveBeenCalledTimes(1);
  });

  it('does not record the greeting twice when it is spoken as stored', async () => {
    await greeted();
    await settle();
    expect(callSession.appendAiTranscriptLine).not.toHaveBeenCalled();
  });

  it('does not record the greeting twice when the caller speaks over it', async () => {
    // The real call: the stored greeting, then the same line again, "[interrupted]".
    await startCall();
    model.say('greet', GREETING, { chunks: 4, finish: false });
    socket.play(2);
    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, BARGE_IN_VOICED_MS);
    await settle();

    expect(model.cancelResponse).toHaveBeenCalled();
    expect(callSession.appendAiTranscriptLine).not.toHaveBeenCalled();
    // The interruption is still on record.
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.AI_RESPONSE,
      expect.objectContaining({ greeting: true, stopped: 'interrupted', text: GREETING }),
    );
  });

  it('records a greeting the model put in its own words', async () => {
    await startCall();
    model.say('greet', 'Hi, Liberty Towing here. What can I do for you?');
    socket.play();
    await settle();
    expect(callSession.appendAiTranscriptLine).toHaveBeenCalledWith('biz-1', 'call-1', 'Hi, Liberty Towing here. What can I do for you?');
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

  it('closes the call\'s own socket, and nothing else, when its business cannot be loaded', async () => {
    // On a real deployment this rejection was uncaught: the process, and every
    // live call on it, would have ended with this one stream.
    model = null as unknown as FakeConversation;
    businessConfig.load.mockRejectedValueOnce(new Error('Business nope not found'));
    socket.fromTwilio({
      event: 'start',
      streamSid: 'MZ1',
      start: { callSid: 'CA1', customParameters: { businessId: 'nope', callId: 'call-1', greeting: GREETING } },
    });
    await settle();

    expect(socket.closed).toBe(true);
    expect(model).toBeNull();
    expect(callSession.handleEvent).toHaveBeenCalledWith('nope', 'call-1', { kind: 'HANGUP' }, expect.objectContaining({ phrase: false }));
  });

  it('ignores a media frame that carries no audio', async () => {
    await greeted();
    socket.fromTwilio({ event: 'media', media: { payload: 12345 } });
    socket.fromTwilio({ event: 'media', media: {} });
    await settle();

    expect(socket.closed).toBe(false);
    expect(model.appendAudio).not.toHaveBeenCalled();
  });

  describe('with a stream gate', () => {
    function gated(admit: ReturnType<typeof vi.fn>) {
      model = null as unknown as FakeConversation;
      const gateway = new RealtimeVoiceGateway(
        callSession as never,
        businessConfig as never,
        ({ instructions, callbacks }) => (model = new FakeConversation(instructions, callbacks)),
        undefined,
        judge,
        { admit },
        undefined,
        0,
      );
      socket = new FakeTwilioSocket();
      gateway.handleConnection(socket as never);
    }

    it('opens no session for a stream it cannot admit', async () => {
      // The socket is open to anyone who can reach the API; a business id
      // alone used to be enough to open a paid session on the platform's key.
      gated(vi.fn(async () => ({ ok: false, reason: 'the stream token is missing or wrong' })));
      await startCall();

      expect(socket.closed).toBe(true);
      expect(model).toBeNull();
      expect(callSession.handleEvent).not.toHaveBeenCalled();
    });

    it('takes the greeting and the caller\'s number from the call record, not from the socket', async () => {
      const admit = vi.fn(async () => ({
        ok: true,
        call: { businessId: 'biz-1', callId: 'call-1', callerNumber: '+15550001111', greeting: 'Liberty Towing, go ahead.' },
      }));
      gated(admit);
      socket.fromTwilio({
        event: 'start',
        streamSid: 'MZ1',
        start: {
          callSid: 'CA1',
          customParameters: { businessId: 'biz-1', callId: 'call-1', token: 'abc', greeting: 'Say something else.', callerNumber: '+19990000000' },
        },
      });
      await settle();

      expect(admit).toHaveBeenCalledWith({ businessId: 'biz-1', callId: 'call-1', callSid: 'CA1', token: 'abc' });
      expect(model.lastRequest()?.instructions).toContain(greetingInstructions('Liberty Towing, go ahead.'));
      expect(model.instructions).toBe(promptFor('+15550001111'));
      expect(model.instructions).not.toContain('+19990000000');
    });

    it('closes a socket that never says which call it carries', async () => {
      gated(vi.fn());
      vi.advanceTimersByTime(10_100);
      await settle();
      expect(socket.closed).toBe(true);
    });
  });
});

describe('the backend decides what comes next', () => {
  it('pins the required action to the conversation before every reply', async () => {
    await greeted();
    model.requestResponse.mockClear();

    await callerTurn('c1', MIKE);

    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'state' }, { callerTurn: 1 });
    expect(model.lastNote()).toContain('REQUIRED ACTION: ASK_LOCATION_DETAIL');
    // The state predates the caller's latest words, which are not known yet: save them first.
    expect(model.lastNote()).toBe(buildActionNote(stateOf(MIKE), { beforeSave: true }));
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
    expect(model.submitToolResults).toHaveBeenCalledWith([{ callId: 'fc1', output: { ok: true } }], undefined, expect.objectContaining({ reason: 'tool-results' }));
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
    const values = { ...MIKE, location: 'I-95, exit 42', vehicleMovable: false };
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(values, { phoneConfirmed: true }));

    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { vehicleMovable: false } }]);
    await settle();

    const [, note, request] = model.submitToolResults.mock.calls.at(-1)!;
    expect(note).toContain('REQUIRED ACTION: CONFIRM_DETAILS');
    expect(request).toEqual(expect.objectContaining({ toolChoice: 'none' }));
    const readBack = renderReadBack(stateOf(values, { phoneConfirmed: true }).readBack!);
    expect(readBack).toContain('8 1 7');
    expect(request.instructions).toContain(exactLineInstructions(readBack));
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
    expect(note).toContain('REQUIRED ACTION: ASK_LOCATION_DETAIL');
    expect(note).toBe(buildActionNote(stateOf(MIKE), { alreadySaid: 'Got it, Mike.' }));
  });

  /** The model asks `said` in the same breath as saving a detail; the backend's next step is `values`'s. Resolves to that state. */
  async function askedWhileSaving(said: string, values: SlotValues, hazard?: string, heardToTheEnd = true): Promise<IntakeSnapshot> {
    await greeted();
    const ctx = { ...initialContext({ customerPhone: '+18174098408', ...values }), ...(hazard ? { safety: { hazard, issuedAtTurn: null } } : {}) };
    const plan = determineNextAction(ctx, { emergencyNumber: '911' });
    const state = describeIntake(ctx, plan);
    callSession.applyIntakeOperation.mockResolvedValueOnce({ output: { state }, ended: false, outcome: null, plan });
    const id = model.say('a1', said, { finish: false });
    if (heardToTheEnd) socket.play();
    model.callbacks.onResponseDone({
      id,
      status: 'completed',
      toolCalls: [{ callId: 'fc1', name: 'update_call_information', arguments: '{"serviceType":"tow"}' }],
    });
    await settle();
    return state;
  }

  it('lets the caller answer a question asked while saving, rather than asking a second one', async () => {
    // The real call: "what exactly happened?" and straight after it "where is the vehicle right now?".
    const said = 'Got it. What exactly happened to the car?';
    const state = await askedWhileSaving(said, { serviceType: 'tow' });

    expect(model.submitToolResults).toHaveBeenLastCalledWith(expect.any(Array), expect.stringContaining('REQUIRED ACTION: ASK_LOCATION'), null);
    const [, note] = model.submitToolResults.mock.calls.at(-1)!;
    // The note for a question asked in the same breath as the save.
    expect(note).toBe(buildActionNote(state, { alreadySaid: said }));
  });

  it('asks nothing more when the question asked with the save is the one the save leads to', async () => {
    // One reply for a detail turn: the save, and the next question with it.
    // The caller is still hearing the question when the save comes back.
    const said = "A Civic, got it. What's wrong with it?";
    const state = await askedWhileSaving(said, { serviceType: 'tow', location: '3114 Holloway Street', vehicleMake: 'Honda', vehicleModel: 'Civic' }, undefined, false);

    expect(state.nextAction).toBe('ASK_VEHICLE_CONDITION');
    expect(model.submitToolResults).toHaveBeenLastCalledWith(expect.any(Array), buildActionNote(state, { alreadySaid: said }), null);
    expect(socket.count('clear')).toBe(0);
    expect(callSession.logCallEvent).not.toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.ACTION_DEVIATION, expect.anything());
  });

  it('asks for the reply to someone who is only talking with what to do about it, and leaves the tools allowed', async () => {
    // The real call 8b6ae0a9: this line, quoted in the note alone, was met with "Where are you right now?".
    connect({ wordsWaitMs: 500 });
    await greeted();
    const said = 'Okay, so you can only help me with my vehicle issues.';
    stateIs({});
    model.callbacks.onCallerTurn('c1');
    await settle();
    model.callbacks.onCallerTranscript('c1', said);
    await settle();

    const request = model.lastRequest()!;
    expect(request.reason).toBe('caller-turn');
    expect(request.toolChoice).toBeUndefined();
    expect(request.instructions).toContain(remarkInstructions(stateOf({}), { text: said, kind: 'unknown' })!);
    expect(request.instructions).toContain("reply to what they said, like a person would");
  });

  describe('an ask the caller never heard', () => {
    const unasked = () =>
      callSession.applyIntakeOperation.mock.calls.filter(([, , op]) => (op as { kind: string }).kind === 'ask_unheard').map(([, , op, meta]) => [op, meta]);

    it('is taken back when the turn went by without the question being put', async () => {
      // The real call 09ba2f2a: the location, asked twice, was given up as
      // "asked three times" after "I have a truck" and "Um".
      await greeted();
      await callerTurn('c1', MIKE);
      model.say('a1', 'Okay, a semi truck.');
      socket.play();
      await settle();

      await callerTurn('c2', MIKE);
      expect(unasked()).toEqual([[{ kind: 'ask_unheard', action: 'ASK_LOCATION_DETAIL' }, { callerTurn: 1 }]]);
    });

    it('stays counted when the caller heard the question, in the samples\' words or in words of its own', async () => {
      await greeted();
      await callerTurn('c1', MIKE);
      model.say('a1', 'Where on I-95 are you, the nearest exit or a mile marker?');
      socket.play();
      await settle();
      await callerTurn('c2', MIKE);
      // A question the word lists cannot place may be the same one, differently put.
      model.say('a2', 'Whereabouts, roughly?');
      socket.play();
      await settle();
      await callerTurn('c3', MIKE);

      expect(unasked()).toEqual([]);
    });

    it('is left alone while the reply is still being said', async () => {
      await greeted();
      await callerTurn('c1', MIKE);
      model.say('a1', 'Where on I-95 are you, the nearest exit or a mile marker?', { chunks: 4 });
      socket.play(1);
      await callerTurn('c2', MIKE);

      expect(unasked()).toEqual([]);
    });
  });

  it('asks nothing of a caller who is still thinking', async () => {
    // The real call 09ba2f2a: "Um", a pause, then "5532" were two turns.
    connect({ wordsWaitMs: 500 });
    await greeted();
    await callerTurn('c1', MIKE);
    model.callbacks.onCallerTranscript('c1', 'Um...');
    await settle();

    expect(model.requestResponse).toHaveBeenCalledTimes(1); // the greeting, and no more
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.OVERLAP_DECIDED,
      expect.objectContaining({ said: 'Um...', decision: 'no reply', hesitation: true }),
    );
    // No filler for a wait that is the caller's own.
    vi.advanceTimersByTime(2_000);
    expect(fillers.next).not.toHaveBeenCalled();

    // What they go on to say is answered as usual.
    await callerTurn('c2', MIKE);
    model.callbacks.onCallerTranscript('c2', 'Exit 42.');
    await settle();
    expect(model.lastRequest()?.reason).toBe('caller-turn');
    expect(model.lastNote()).toContain('THE CALLER JUST SAID: "Exit 42."');
  });

  it('records the next question asked in a reply that saved nothing', async () => {
    // The live check lets the next question through, so a skipped save is not stopped: it has to show in the trail.
    await greeted();
    const values = { serviceType: 'tow', location: '3114 Holloway Street' };
    await callerTurn('c1', values);
    expect(backend(values).plan.ifAnswered?.topic).toBe('condition');

    model.say('a1', "A Civic, got it. What's wrong with it?");
    await settle();

    expect(model.cancelResponse).not.toHaveBeenCalled();
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.ACTION_DEVIATION,
      expect.objectContaining({ asked: 'condition', required: 'ASK_VEHICLE', redirected: false, unsaved: true }),
    );
  });

  it('stops a question asked with a save that made something else the next step', async () => {
    // The answer was not good enough to move on from (here the street has no
    // number), so the question about the car has to wait.
    const said = 'Main Street, got it. What are you driving?';
    const state = await askedWhileSaving(said, { serviceType: 'tow', location: 'Main Street' }, undefined, false);

    expect(state.nextAction).toBe('ASK_LOCATION_DETAIL');
    expect(socket.count('clear')).toBe(1);
    expect(model.truncate).toHaveBeenCalledWith('a1', 0);
    const plan = determineNextAction(initialContext({ customerPhone: '+18174098408', serviceType: 'tow', location: 'Main Street' }), { emergencyNumber: '911' });
    expect(model.addNote).toHaveBeenCalledWith(redirectNote('vehicle', plan, ''));
    // The reply to the results follows the fresh plan, and is not told to wait for an answer to the stopped question.
    const [, note, request] = model.submitToolResults.mock.calls.at(-1)!;
    expect(note).toBe(buildActionNote(state, {}));
    expect(request).toEqual(expect.objectContaining({ reason: 'tool-results' }));
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.ACTION_DEVIATION,
      expect.objectContaining({ asked: 'vehicle', required: 'ASK_LOCATION_DETAIL', redirected: true, afterSave: true }),
    );
  });

  it('still gives the safety advice after a question asked while saving', async () => {
    await askedWhileSaving('Got it. Is the car still running?', { serviceType: 'tow', location: 'I-95 near exit 42' }, 'being stopped on a high-speed road');

    const [, note, request] = model.submitToolResults.mock.calls.at(-1)!;
    expect(note).toContain('REQUIRED ACTION: HANDLE_SAFETY');
    expect(request).toEqual(expect.objectContaining({ reason: 'tool-results' }));
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
    expect(model.lastNote()).toBe(redirectNote('callback_number', backend(MIKE).plan, ''));
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

describe('what the transcript records', () => {
  const QUESTION = 'Got it, Mike. Can you confirm if this is the best number to reach you?';

  /** The model speaks `chunks` × 0.2 s of audio, the caller hears `played` marks of it, then its words arrive. */
  function speakHeard(itemId: string, text: string, chunks: number, played: number) {
    model.callbacks.onResponseStarted('resp-x', true, 'caller-turn');
    for (let i = 0; i < chunks; i += 1) model.callbacks.onAudio(itemId, Buffer.alloc(1600, 0xff));
    socket.play(played);
    model.callbacks.onSpokenText(itemId, text);
  }

  it('keeps every word of a reply stopped before any playback was confirmed', async () => {
    // The real calls: audio reaches the caller ahead of the marks that
    // measure it, and a reply stopped with "nothing heard" left no line.
    await greeted();
    await callerTurn('c1', MIKE);
    model.callbacks.onCallerTranscript('c1', 'My semi broke down on I-95.');
    model.say('a1', QUESTION, { finish: false });
    await settle();

    expect(callSession.appendAiTranscriptLine).toHaveBeenCalledWith('biz-1', 'call-1', `${QUESTION} [stopped]`);
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.ACTION_DEVIATION,
      expect.objectContaining({ redirected: true, heard: '', heardMs: 0 }),
    );
    // Told that none of it was heard.
    expect(model.lastNote()).toBe(redirectNote('callback_number', backend(MIKE).plan, ''));
  });

  it('tells the model what the caller heard of a stopped question, so it does not carry on as if nothing was said', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.callbacks.onCallerTranscript('c1', 'My semi broke down on I-95.');
    model.addNote.mockClear();
    speakHeard('a1', QUESTION, 4, 4); // half of it
    await settle();

    expect(callSession.appendAiTranscriptLine).toHaveBeenCalledWith('biz-1', 'call-1', `${QUESTION} [stopped]`);
    expect(model.lastNote()).toBe(redirectNote('callback_number', backend(MIKE).plan, 'Got it, Mike. Can you confirm if'));
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.ACTION_DEVIATION,
      expect.objectContaining({ heard: 'Got it, Mike. Can you confirm if', heardMs: 400 }),
    );
  });

  it('keeps a line still playing when the call ends, marked as cut off by the end of the call', async () => {
    await greeted();
    model.say('a1', 'Where exactly on I-95 are you?', { chunks: 2 });
    socket.play(1);
    socket.close();
    await settle();

    expect(callSession.appendAiTranscriptLine).toHaveBeenCalledWith('biz-1', 'call-1', 'Where exactly on I-95 are you? [call ended]');
  });

  it('judges a reply by the words the caller heard, not every word the model produced', async () => {
    await greeted();
    await callerTurn('c1');
    model.callbacks.onCallerTranscript('c1', 'Who will call me back?');
    model.say('a1', 'Okay, the towing team will call you about that.', { chunks: 4, finish: false });
    socket.play(4); // half of it
    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, BARGE_IN_VOICED_MS);
    await settle();

    expect(callSession.judgeReply).toHaveBeenCalledWith('biz-1', 'call-1', 'Okay, the towing team', 1);
  });

  it('records why a caller line is missing from the transcript', async () => {
    await greeted();
    // The receptionist's own greeting, heard back through the caller's phone.
    model.callbacks.onCallerTranscript('c1', 'Thanks for calling Liberty Towing. How can I help?');
    model.callbacks.onCallerTranscript('c2', null);
    await callerTurn('c3');
    vi.advanceTimersByTime(8_000);
    await settle();

    const dropped = callSession.logCallEvent.mock.calls.filter(([, , type]) => type === CallEventType.TRANSCRIPT_DROPPED).map(([, , , p]) => p);
    expect(dropped).toEqual([
      expect.objectContaining({ speaker: 'customer', reason: 'echo', text: GREETING }),
      expect.objectContaining({ speaker: 'customer', reason: 'failed' }),
      expect.objectContaining({ speaker: 'customer', reason: 'timeout', turn: 1 }),
    ]);
  });

  it('never quotes to the model what the transcriber wrote in another script', async () => {
    // The real call 09ba2f2a: "5522 ہائی وے" was quoted in the note and saved as the location.
    connect({ wordsWaitMs: 500 });
    await greeted();
    await callerTurn('c1', MIKE);
    model.callbacks.onCallerTranscript('c1', '5522 ہائی وے');
    await settle();

    expect(model.lastNote()).toContain('THE CALLER JUST SAID: "5522"');
    expect(model.lastNote()).not.toContain('ہائی');
    expect(order).toEqual(['caller: 5522']);
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.TRANSCRIPT_DROPPED,
      expect.objectContaining({ reason: 'script', text: '5522 ہائی وے', kept: '5522' }),
    );

    // Nothing left of the line: the reply is asked for without their words, as when a transcript fails.
    await callerTurn('c2', MIKE);
    model.callbacks.onCallerTranscript('c2', 'السلام علیکم');
    await settle();
    expect(model.lastNote()).not.toContain('THE CALLER JUST SAID');
    expect(order.filter((entry) => entry.startsWith('caller:'))).toEqual(['caller: 5522']);
    const dropped = callSession.logCallEvent.mock.calls.filter(([, , type]) => type === CallEventType.TRANSCRIPT_DROPPED).map(([, , , p]) => p);
    expect(dropped).toEqual([expect.objectContaining({ reason: 'script', kept: '5522' }), expect.objectContaining({ reason: 'script', kept: '' })]);
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
    expect(callSession.handleEvent).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'HANGUP' }, expect.objectContaining({ phrase: false }));
  });
});

describe('barge-in', () => {
  it('stops the reply, clears Twilio, and truncates the model\'s memory to what was heard', async () => {
    await greeted();
    model.say('a1', 'Can you tell me the nearest exit', { chunks: 2, finish: false });
    socket.play(2); // the caller heard the first 0.2 s of 0.4 s

    model.callbacks.onSpeechStarted();
    // Nothing stops at the onset, or for a short sound.
    callerAudio(LOUD, PLAY_THROUGH_VOICED_MS - 20);
    expect(socket.count('clear')).toBe(0);
    // Playback stops once the sound has gone on, but the reply is only given
    // up once the caller has clearly taken the floor.
    callerAudio(LOUD, 20);
    expect(socket.count('clear')).toBe(1);
    expect(model.cancelResponse).not.toHaveBeenCalled();
    callerAudio(LOUD, BARGE_IN_VOICED_MS - PLAY_THROUGH_VOICED_MS);
    await settle();

    expect(model.cancelResponse).toHaveBeenCalled();
    expect(model.truncate).toHaveBeenCalledWith('a1', 200);
    // The whole line, marked: how much was heard is in the event.
    expect(callSession.appendAiTranscriptLine).toHaveBeenCalledWith('biz-1', 'call-1', 'Can you tell me the nearest exit [interrupted]');
    expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.AI_INTERRUPTED, expect.objectContaining({
      heardMs: 200,
      text: 'Can you tell me the nearest exit',
      heard: 'Can you tell',
      voicedMs: expect.any(Number),
      via: 'gauge',
      turn: 0,
    }));

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
    const values = { ...MIKE, location: 'I-95, exit 42', vehicleMovable: false };
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(values, { phoneConfirmed: true }));
    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { vehicleMovable: false } }]);
    await settle();

    const readBack = renderReadBack(stateOf(values, { phoneConfirmed: true }).readBack!);
    model.say('rb', readBack, { chunks: 4, finish: false });
    socket.play(2); // a quarter of it heard
    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, BARGE_IN_VOICED_MS);
    await settle();

    const heard = heardPortion(readBack, 1600, 6400);
    expect(heard).not.toBe('');
    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'read_back_cut', heard });
  });

  describe('a caller who speaks softly', () => {
    // A real call: the caller's voice sat under the usual bar. Each time they
    // spoke over a reply the gauge heard 0 ms of voice, and the reply talked
    // over them while OpenAI heard them speak for two seconds.
    const SOFT = Buffer.alloc(160);
    for (let i = 0; i < SOFT.length; i += 1) SOFT[i] = linearToMulaw(280 * Math.sin((2 * Math.PI * 440 * i) / 8000));

    async function speaksOverReply() {
      model.say('a1', 'Where exactly on I-95 are you, the nearest exit or a mile marker?', { chunks: 6, finish: false });
      socket.play(2);
      model.callbacks.onSpeechStarted();
      callerAudio(SOFT, BARGE_IN_VOICED_MS + 200);
      await settle();
    }

    it('is talked over before their level is known, and the trail says so', async () => {
      await greeted();
      await speaksOverReply();
      expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.HOLD_RESUMED, expect.objectContaining({ voicedMs: 0, minVoicedRms: 250 }));

      model.callbacks.onSpeechStopped?.(1_500);
      await settle();
      expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.TALKED_OVER, expect.objectContaining({ spokenMs: 1_500 }));
    });

    it('is heard over a reply once they have spoken alone', async () => {
      await greeted();
      // The caller's first turn, with the receptionist silent: their level is learned.
      model.callbacks.onSpeechStarted();
      callerAudio(SOFT, 1_000);
      model.callbacks.onSpeechStopped?.(1_000);
      await callerTurn('c1', MIKE);

      await speaksOverReply();
      expect(model.cancelResponse).toHaveBeenCalled();
      expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.AI_INTERRUPTED, expect.objectContaining({ via: 'gauge', minVoicedRms: 120 }));
    });
  });

  it('tells the backend a question was not asked when the caller spoke before hearing it', async () => {
    // The real call: "Where is the vehicle right now?", cut with nothing heard, counted as an ask.
    await greeted();
    await callerTurn('c1', MIKE);
    model.say('a1', 'Where exactly on I-95 are you, the nearest exit or a mile marker?', { chunks: 4, finish: false });
    socket.play(2);
    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, BARGE_IN_VOICED_MS);
    await settle();

    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'ask_unheard', action: 'ASK_LOCATION_DETAIL' }, { callerTurn: 1 });
    expect(callSession.applyIntakeOperation).not.toHaveBeenCalledWith('biz-1', 'call-1', expect.objectContaining({ kind: 'read_back_cut' }));
  });

  it('says nothing to the backend about a question the caller heard before speaking', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.say('a1', 'Where on I-95? Take your time.', { chunks: 4, finish: false });
    socket.play(4); // the question heard, the rest not
    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, BARGE_IN_VOICED_MS);
    await settle();

    expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.AI_INTERRUPTED, expect.objectContaining({ heard: 'Where on I-95?' }));
    expect(callSession.applyIntakeOperation).not.toHaveBeenCalledWith('biz-1', 'call-1', expect.objectContaining({ kind: 'ask_unheard' }), expect.anything());
  });

  it('talks straight through a short sound, and cuts no hole in its own sentence', async () => {
    // The real call (5176f4be): a 200 ms sound stopped playback at its onset,
    // and the safety line carried on 605 ms later with a hole in the middle.
    await greeted();
    const text = 'Please stay well away from the traffic, behind the barrier if there is one.';
    const id = model.say('a1', text, { chunks: 4, finish: false });
    socket.play(2);
    const sentBefore = socket.count('media');

    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, 200);
    // The rest of the reply still reaches the caller while the sound is watched.
    model.callbacks.onAudio('a1', Buffer.alloc(1600, 0xff));
    expect(socket.count('media')).toBe(sentBefore + 10);
    callerAudio(QUIET, HOLD_RESUME_SILENCE_MS);
    model.callbacks.onResponseDone({ id, status: 'completed', toolCalls: [] });
    await settle();

    // Nothing was stopped, so nothing is sent a second time.
    expect(socket.count('clear')).toBe(0);
    expect(socket.count('media')).toBe(sentBefore + 10);
    expect(model.cancelResponse).not.toHaveBeenCalled();
    expect(model.truncate).not.toHaveBeenCalled();
    expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.HOLD_RESUMED, expect.objectContaining({
      playedThrough: true,
      holdMs: expect.any(Number),
      voicedMs: 200,
      resumedMs: 0,
      via: 'gauge',
      nothingHeard: false,
    }));

    // The sound is still a turn of the caller's, and still one that needs no reply.
    model.requestResponse.mockClear();
    model.callbacks.onCallerTurn('c1');
    socket.play();
    model.callbacks.onCallerTranscript('c1', 'Okay.');
    await settle();

    expect(model.requestResponse).not.toHaveBeenCalled();
    expect(callSession.applyIntakeOperation).not.toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'state' }, expect.anything());
    expect(order).toEqual([`ai: ${text}`, 'caller: Okay.']);
  });

  it('plays through a sound that OpenAI ends before it has gone on long enough to pause for', async () => {
    await greeted();
    model.say('a1', 'Where exactly on I-95 are you?', { chunks: 3 });
    const sentBefore = socket.count('media');

    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, 100);
    model.callbacks.onSpeechStopped?.(400);
    await settle();

    expect(socket.count('clear')).toBe(0);
    expect(socket.count('media')).toBe(sentBefore);
    expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.HOLD_RESUMED, expect.objectContaining({
      playedThrough: true,
      via: 'speech_stopped',
      spokenMs: 400,
      resumedMs: 0,
    }));
  });

  it('gives the floor to a caller who is still talking when the pause runs out, however little of it counted as voice', async () => {
    // The real call 8b6ae0a9: a sentence measured 540 ms voiced in 1.2 s; the
    // reply carried on and talked over the three seconds that followed.
    await greeted();
    model.say('a1', "Sure, what's going on with the car?", { chunks: 6, finish: false });
    socket.play(2);

    model.callbacks.onSpeechStarted();
    // A sentence with gaps in it: paused for at 300 ms, 500 ms voiced in all, never 300 ms of quiet.
    callerAudio(LOUD, 300);
    callerAudio(QUIET, 200);
    callerAudio(LOUD, 200);
    callerAudio(QUIET, 100);
    expect(socket.count('clear')).toBe(1);
    vi.advanceTimersByTime(1_200);
    await settle();

    expect(model.cancelResponse).toHaveBeenCalled();
    expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.AI_INTERRUPTED, expect.objectContaining({ via: 'timer', voicedMs: 500 }));
    expect(callSession.logCallEvent).not.toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.HOLD_RESUMED, expect.anything());
  });

  it('plays through scattered sounds that never add up to a pause, for as long as they are judged', async () => {
    await greeted();
    model.say('a1', 'Where exactly on I-95 are you?', { chunks: 3 });
    const sentBefore = socket.count('media');

    model.callbacks.onSpeechStarted();
    // Clicks on the line: never 300 ms of sound, and never 300 ms of quiet.
    for (let i = 0; i < 2; i += 1) {
      callerAudio(LOUD, 100);
      callerAudio(QUIET, 200);
    }
    expect(callSession.logCallEvent).not.toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.HOLD_RESUMED, expect.anything());
    vi.advanceTimersByTime(1_200);
    await settle();

    expect(socket.count('clear')).toBe(0);
    expect(socket.count('media')).toBe(sentBefore);
    expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.HOLD_RESUMED, expect.objectContaining({
      playedThrough: true,
      via: 'timer',
      voicedMs: 200,
      resumedMs: 0,
    }));
  });

  it('pauses for a word or two of acknowledgement and carries on from where the caller stopped hearing', async () => {
    await greeted();
    const text = 'So that is a Honda Civic at exit 12 on I-95, and the best number is the one you are calling from.';
    model.say('a1', text, { chunks: 4 }); // 0.8 s of audio, 40 frames
    socket.play(2); // 0.2 s heard
    const sentBefore = socket.count('media');

    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, PLAY_THROUGH_VOICED_MS - 20);
    expect(socket.count('clear')).toBe(0); // still a short sound: nothing stopped yet
    callerAudio(LOUD, 120); // "okay, yeah": 400 ms in all, and playback stops for it
    expect(socket.count('clear')).toBe(1);
    expect(socket.count('media')).toBe(sentBefore);
    callerAudio(QUIET, HOLD_RESUME_SILENCE_MS);
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
    // The overlap's own note quotes the words, once.
    expect(model.lastNote()).toBe(buildActionNote(stateOf(MIKE), { beforeSave: true, overlap: 'Yes.' }));
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
    expect(model.lastNote()).toBe(buildActionNote(stateOf(MIKE), { beforeSave: true, overlap: 'Right, exit 14.' }));
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
    expect(model.requestResponse).toHaveBeenCalledWith(expect.objectContaining({ reason: 'caller-turn' }));

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
    callerAudio(QUIET, HOLD_RESUME_SILENCE_MS); // nothing voiced: the reply never stopped
    expect(model.cancelResponse).not.toHaveBeenCalled();
    expect(socket.count('clear')).toBe(0);
    expect(socket.count('media')).toBe(sentBefore); // nothing was stopped, so nothing is sent again

    callerAudio(LOUD, BARGE_IN_VOICED_MS); // the caller was only drawing breath
    await settle();
    expect(model.cancelResponse).toHaveBeenCalled();
    expect(model.truncate).toHaveBeenCalledWith('a1', 0);
    // Paused again once they had gone on for 300 ms, then stopped for good.
    expect(socket.count('clear')).toBe(2);
  });

  it('pauses again for a caller who carries on after the reply resumed, and resumes if that was brief too', async () => {
    // The real call 09ba2f2a: after a pause judged brief, the reply talked
    // over four sentences, each about two seconds long.
    await greeted();
    model.say('a1', 'Where exactly on I-95 are you?', { chunks: 8, finish: false });
    socket.play(2);

    pausedOverlap(); // paused for, judged brief, resumed
    expect(socket.count('clear')).toBe(1);
    const sentAfterResume = socket.count('media');

    callerAudio(LOUD, 300); // they carry on
    expect(socket.count('clear')).toBe(2);
    expect(model.cancelResponse).not.toHaveBeenCalled();
    callerAudio(QUIET, HOLD_RESUME_SILENCE_MS); // and stop again: the reply picks up where they stopped hearing it
    await settle();
    expect(socket.count('media')).toBeGreaterThan(sentAfterResume);
    expect(model.cancelResponse).not.toHaveBeenCalled();
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
    // Held back from their first sound, not only once it has gone on: a
    // reply must not start on top of the caller.
    callerAudio(LOUD, 100);
    model.callbacks.onSpokenText('a1', 'Where exactly on I-95 are you?');
    model.callbacks.onAudio('a1', Buffer.alloc(1600, 0xff));
    expect(socket.count('media')).toBe(sentBefore);
    callerAudio(LOUD, BARGE_IN_VOICED_MS + 100);
    expect(model.cancelResponse).not.toHaveBeenCalled();
    expect(socket.count('media')).toBe(sentBefore); // held until the caller stops

    model.callbacks.onCallerTurn('c2');
    model.callbacks.onResponseDone({ id: 'r1', status: 'completed', toolCalls: [] });
    await settle();
    expect(socket.count('media')).toBe(sentBefore + 10); // now played in full
    expect(model.truncate).not.toHaveBeenCalled();
    const resumed = callSession.logCallEvent.mock.calls.filter(([, , type]) => type === CallEventType.HOLD_RESUMED).map(([, , , payload]) => payload);
    expect(resumed).toEqual([expect.objectContaining({ nothingHeard: true, via: 'turn_ended', resumedMs: 200 })]);
    expect(resumed[0]).not.toHaveProperty('playedThrough');

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
    const promise = 'No problem, a truck will be there in 20 minutes';
    model.say('a1', promise, { finish: false });
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
    // Told that none of it was heard, and why it was stopped.
    const verdict = checkReply(promise);
    expect(verdict.ok).toBe(false);
    const why = verdict.ok ? '' : verdict.violations[0]!.detail;
    expect(model.lastNote()).toBe(guardrailRecoveryInstructions(why, ''));
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'guardrail-recovery' }));
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

  it('stop the model thinking aloud, and tell it again rather than play the fixed line', async () => {
    await greeted();
    // Location settled, movability known: before, this was stopped as a movability question.
    model.say('a1', "Okay. What's my next move?", { finish: false });
    model.say('a2', 'The required action is to ask for your name.', { finish: false });
    await settle();

    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.GUARDRAIL_TRIPPED,
      expect.objectContaining({ violations: ['self_talk'], suppressed: "Okay. What's my next move?", attempt: 1 }),
    );
    expect(callSession.logCallEvent).not.toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.ACTION_DEVIATION, expect.anything());
    expect(model.lastNote()).toBe(SELF_TALK_RECOVERY_INSTRUCTIONS);
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'self-talk-recovery' }));
    expect(model.lastRequest()?.instructions ?? '').not.toContain(SAFE_FALLBACK_LINE);
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

describe('a reply that was only an ack', () => {
  // The model is told to say a short ack with every save, so the caller is
  // not left in silence while it saves. Said without the save, and with no
  // question, the caller would hear nothing more until the silence check.
  const asked = (reason: string) => model.requestResponse.mock.calls.filter(([request]) => request?.reason === reason).map(([request]) => request!);
  const ALL: SlotValues = { ...MIKE, location: 'I-95 near exit 42', vehicleMovable: false };

  /** The caller answers, and the model says `reply` with no tool call. */
  async function answered(said: string | null, reply: string, values: SlotValues = MIKE) {
    await greeted();
    await callerTurn('c1', values);
    if (said) model.callbacks.onCallerTranscript('c1', said);
    await settle();
    model.say('a1', reply);
    socket.play();
    await settle();
  }

  it('is followed up, with the ack quoted as already said and the tools still allowed', async () => {
    await answered('Exit 12.', 'Exit 12, got it.');

    expect(asked('after-ack')).toHaveLength(1);
    expect(asked('after-ack')[0]).not.toHaveProperty('toolChoice');
    expect(asked('after-ack')[0]).not.toHaveProperty('instructions');
    expect(model.lastNote()).toBe(buildActionNote(stateOf(MIKE), { beforeSave: true, alreadySaid: 'Exit 12, got it.' }));
    expect(model.lastNote()).toContain('You ALREADY SAID: "Exit 12, got it."');
  });

  it('is followed up once per caller turn', async () => {
    await answered('Exit 12.', 'Exit 12, got it.');
    model.say('a2', 'Okay.');
    socket.play();
    await settle();

    expect(asked('after-ack')).toHaveLength(1);
  });

  it('is left alone when the reply asked something', async () => {
    await answered('Exit 12.', 'Exit 12, got it. Which side of the road are you on?');
    expect(asked('after-ack')).toEqual([]);
  });

  it('is left alone when the caller asked for a moment: an ack and a wait is the reply', async () => {
    await answered('Hold on, one sec.', 'Sure, take your time.');
    expect(asked('after-ack')).toEqual([]);
  });

  it('is left alone while the caller\'s words are not known', async () => {
    await answered(null, 'Okay.');
    expect(asked('after-ack')).toEqual([]);
  });

  it('is left to the judge for a yes to the callback number, which the backend can take itself', async () => {
    expect(stateOf(ALL).nextAction).toBe('CONFIRM_CALLBACK_NUMBER');
    await answered('Yes.', 'Got it.', ALL);
    expect(asked('after-ack')).toEqual([]);
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

  it('is covered by a filler each time it stalls, and after a long time the call ends as a failure', async () => {
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
      await settle();
    }
    // Nothing came. A receptionist that cannot speak hands the caller to a
    // person: the failure is recorded, the stream closed, and the call
    // finalised as a technical problem, which always raises a callback.
    expect(callSession.logCallEvent).toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.PROVIDER_ERROR, expect.objectContaining({ stage: 'fatal' }));
    expect(socket.closed).toBe(true);
    expect(callSession.handleEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      { kind: 'PROVIDER_ERROR', message: expect.stringContaining('No reply from the model') },
      expect.objectContaining({ phrase: false, trace: expect.objectContaining({ endedBy: 'failure' }) }),
    );
    expect(silences()).toBe(0);
  });

  it('ends the call as a failure, with a callback, when the model is lost mid-call', async () => {
    await greeted();
    await callerTurn('c1', MIKE);

    model.callbacks.onClose?.();
    await settle();

    expect(socket.closed).toBe(true);
    expect(callSession.handleEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      { kind: 'PROVIDER_ERROR', message: 'OpenAI realtime session closed mid-call' },
      expect.objectContaining({ phrase: false, trace: expect.objectContaining({ endedBy: 'failure' }) }),
    );
    expect(callSession.handleEvent).not.toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'HANGUP' }, expect.objectContaining({ phrase: false }));
  });

  it('treats the model going away during the goodbye as an ordinary end', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.callTools([{ callId: 't1', name: 'complete_request', arguments: { callerConfirmed: true } }]);
    callSession.applyIntakeOperation.mockResolvedValueOnce({ output: { callEnded: true }, ended: true, outcome: 'lead_created', plan: null });
    await settle();

    model.callbacks.onClose?.();
    await settle();

    expect(socket.closed).toBe(true);
    expect(callSession.handleEvent).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'HANGUP' }, expect.objectContaining({ phrase: false }));
  });

  it('is asked for again when OpenAI fails it', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.requestResponse.mockClear();

    model.callbacks.onResponseStarted('r1', true, 'caller-turn');
    model.callbacks.onResponseDone({ id: 'r1', status: 'failed', toolCalls: [], failure: 'rate_limit_exceeded: slow down' });
    vi.advanceTimersByTime(7_100); // owed again: still not the caller's silence
    await settle();

    expect(model.requestResponse).toHaveBeenCalledWith(expect.objectContaining({ reason: 'retry' }));
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
    expect(model.lastRequest()?.instructions).toContain(exactLineInstructions(SILENCE_CHECK_LINE));
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

    const reasons = model.requestResponse.mock.calls.map(([r]) => r?.reason);
    expect(reasons).not.toContain('silence-check');
    expect(reasons).not.toContain('silence-goodbye');
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-turn' }));
  });

  it('ends the call with a goodbye when the backend says silence has gone on too long', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce({ output: {}, ended: true, outcome: 'callback_created', plan: null });

    vi.advanceTimersByTime(7_100);
    await settle();
    expect(model.lastRequest()?.instructions).toContain(SILENCE_GOODBYE_INSTRUCTIONS);

    model.say('bye', 'The towing team will contact you. Goodbye.');
    socket.play();
    await settle();
    expect(socket.closed).toBe(true);
  });

  it('gives a caller who asked for a moment longer before checking in', async () => {
    // "Hold on, let me find the exit number": a stranded caller walking to a
    // sign, checked on after seven seconds and hung up on after fourteen.
    await greeted();
    await callerTurn('c1', MIKE);
    model.say('a1', 'Sure, take your time.');
    socket.play();
    await settle();
    model.callbacks.onCallerTranscript('c1', 'Hold on, let me go and find the exit number.');
    await settle();

    vi.advanceTimersByTime(7_100);
    await settle();
    expect(callSession.applyIntakeOperation).not.toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'silence' });

    vi.advanceTimersByTime(PATIENT_NO_INPUT_MS - 7_100 + 100);
    await settle();
    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'silence' });
  });
});

describe('limits on a call', () => {
  /** The backend ends the call on operations of `kind`, and carries on for any other. */
  function endsOn(kind: string) {
    callSession.applyIntakeOperation.mockImplementation(async (_b: string, _c: string, op: { kind: string }) =>
      op.kind === kind
        ? { output: { callEnded: true }, ended: true, outcome: 'callback_created', plan: null }
        : { output: { ok: true }, ended: false, outcome: null, plan: null },
    );
  }

  it('ends a call that has run past the tenant\'s limit, with a goodbye', async () => {
    businessConfig.load.mockResolvedValueOnce({
      flow: { facts: FACTS },
      maxCallSeconds: 5,
    });
    await greeted();
    endsOn('end');

    vi.advanceTimersByTime(5_100);
    await settle();

    expect(callSession.applyIntakeOperation).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'end', reason: expect.stringContaining('maximum length') });
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'time-limit-goodbye' }));

    model.say('bye', 'The towing team will contact you. Goodbye.');
    socket.play();
    await settle();
    expect(socket.closed).toBe(true);
  });

  it('hangs up even when the turn-limit goodbye never plays', async () => {
    await greeted();
    endsOn('caller_speech');
    await callerTurn('c1');
    model.callbacks.onCallerTranscript('c1', 'And another thing.');
    await settle();
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'turn-limit-goodbye' }));

    vi.advanceTimersByTime(20_100); // no goodbye ever came
    await settle();
    expect(socket.closed).toBe(true);
  });

  it('says goodbye with the details unconfirmed when the backend stops waiting for a yes', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce({ output: { callEnded: true }, ended: true, outcome: 'lead_created', plan: null });
    await callerTurn('c1');

    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'unconfirmed-goodbye' }));
    expect(model.lastRequest()?.instructions).toContain(UNCONFIRMED_GOODBYE_INSTRUCTIONS);
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
    expect(callSession.handleEvent).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'HANGUP' }, expect.objectContaining({ phrase: false }));
  });

  it("measures the caller's wait from their last sound, not only from the end of their turn", async () => {
    // The turn's end is OpenAI's, and comes some time after the caller stops.
    // Counted from there alone, that time was in no figure.
    await greeted();
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      model.callbacks.onSpeechStarted();
      callerAudio(LOUD, 400);
      now += 700; // the turn detector deciding they have finished
      callerAudio(QUIET, 100);
      model.callbacks.onSpeechStopped?.(1_200);
      await callerTurn('c1');
      now += 900; // the model
      model.say('a1', 'Where are you right now?');
      socket.play();
      model.callbacks.onUsage?.({ kind: 'response', usage: { output_token_details: { text_tokens: 8, audio_tokens: 40 } } });
      await settle();
    } finally {
      clock.mockRestore();
    }
    socket.fromTwilio({ event: 'stop', streamSid: 'MZ1' });
    await settle();

    const logged = (type: CallEventType) => callSession.logCallEvent.mock.calls.filter(([, , t]) => t === type).map(([, , , payload]) => payload);
    expect(logged(CallEventType.REPLY_REQUESTED)).toContainEqual(expect.objectContaining({ reason: 'caller-turn', endpointMs: 700 }));
    expect(logged(CallEventType.AI_RESPONSE)).toContainEqual(
      expect.objectContaining({ text: 'Where are you right now?', afterTurnMs: 900, afterLastSoundMs: 1_600 }),
    );
    expect(logged(CallEventType.AI_USAGE)).toContainEqual(
      expect.objectContaining({
        endpointMs: expect.objectContaining({ count: 1, medianMs: 700 }),
        lastSoundToReplyMs: expect.objectContaining({ count: 1, medianMs: 1_600 }),
        callerTurns: 1,
        fillers: 0,
        pauses: 0,
      }),
    );
  });

  it('counts a filler still playing in the wait for the reply behind it', async () => {
    await greeted();
    let now = 2_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      model.callbacks.onSpeechStarted();
      callerAudio(LOUD, 400);
      model.callbacks.onSpeechStopped?.(500);
      await callerTurn('c1');
      // The filler: 200 ms of audio, none of it played yet when the reply arrives.
      now += 1_100;
      await vi.advanceTimersByTimeAsync(1_100);
      now += 100;
      model.say('a1', 'Where are you right now?');
      await settle();
    } finally {
      clock.mockRestore();
    }
    socket.play();
    await settle();

    const replies = callSession.logCallEvent.mock.calls.filter(([, , t]) => t === CallEventType.AI_RESPONSE).map(([, , , payload]) => payload);
    // 1,200 ms until it was sent, and the filler's 200 ms to be heard out first.
    expect(replies).toContainEqual(expect.objectContaining({ text: 'Where are you right now?', afterTurnMs: 1_200, afterLastSoundMs: 1_400 }));
  });
});

describe('questionWithSave', () => {
  const asking = { nextAction: 'ASK_VEHICLE_CONDITION' } as const;
  const plan = { topic: 'condition', settled: ['service', 'location', 'vehicle'] } as const;

  it('is nothing when no question was asked with the save', () => {
    expect(questionWithSave('', asking, plan as never)).toBeNull();
    expect(questionWithSave('A Civic, got it.', asking, plan as never)).toBeNull();
  });

  it("fits when it is the fresh plan's question, or about something the save settled", () => {
    expect(questionWithSave("A Civic, got it. What's wrong with it?", asking, plan as never)).toEqual({ verdict: 'fits' });
    // Topics a caller hears as one question.
    expect(questionWithSave("What's going on with the car?", { nextAction: 'ASK_SERVICE_TYPE' }, { topic: 'service', settled: [] })).toEqual({ verdict: 'fits' });
    expect(questionWithSave('What are you driving?', asking, plan as never)).toEqual({ verdict: 'fits' });
    // A question about nothing the intake tracks is the caller's to answer.
    expect(questionWithSave('Sorry, try to what?', asking, plan as never)).toEqual({ verdict: 'fits' });
  });

  it('is stray when it is about something that has to wait, or the next step is not a question', () => {
    expect(questionWithSave("What's your name?", asking, plan as never)).toEqual({ verdict: 'stray', asked: 'name' });
    expect(questionWithSave("What's wrong with it?", { nextAction: 'HANDLE_SAFETY' }, { topic: 'safety', settled: [] })).toEqual({ verdict: 'stray', asked: 'condition' });
  });

  it('takes the number confirmation for a question put to the caller', () => {
    expect(
      questionWithSave('Thanks, Mike. Is this the best number to reach you on?', { nextAction: 'CONFIRM_CALLBACK_NUMBER' }, { topic: 'callback_number', settled: ['name'] }),
    ).toEqual({ verdict: 'fits' });
  });
});

describe('heardPortion', () => {
  it('keeps the share of words matching the share of audio played', () => {
    expect(heardPortion('one two three four', 800, 1600)).toBe('one two');
    expect(heardPortion('one two three four', 0, 1600)).toBe('');
    expect(heardPortion('one two', 5000, 1600)).toBe('one two');
  });
});

describe('transcriptLine', () => {
  const item = (stopped: Parameters<typeof transcriptLine>[0]['stopped'], played = 800) => ({
    text: ' one two three four ',
    stopped,
    bytesPlayed: played,
    bytesReceived: 1600,
  });

  it('records a reply played in full as said, and heard in full', () => {
    expect(transcriptLine(item(null, 1600))).toEqual({ text: 'one two three four', heard: 'one two three four' });
  });

  it('records every word of a stopped reply, marked, and how much was heard separately', () => {
    expect(transcriptLine(item('interrupted'))).toEqual({ text: 'one two three four [interrupted]', heard: 'one two' });
    expect(transcriptLine(item('redirected', 0))).toEqual({ text: 'one two three four [stopped]', heard: '' });
    expect(transcriptLine(item('guardrail')).text).toBe('one two three four [stopped]');
    expect(transcriptLine(item('hangup')).text).toBe('one two three four [call ended]');
  });

  it('records nothing for a reply never played, or with no words', () => {
    expect(transcriptLine(item('stale')).text).toBeNull();
    expect(transcriptLine({ ...item(null), text: '  ' }).text).toBeNull();
  });
});

describe('the call trail', () => {
  /** Every payload logged as `type`, in order. */
  const events = (type: string) => callSession.logCallEvent.mock.calls.filter(([, , t]) => t === type).map(([, , , payload]) => payload);

  it('stamps every event with the caller turn it happened on', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.say('a1', 'Where exactly on I-95 are you?');
    socket.play();
    await settle();

    expect(callSession.logCallEvent.mock.calls.length).toBeGreaterThan(0);
    for (const [, , type, payload] of callSession.logCallEvent.mock.calls) {
      expect(payload, type).toHaveProperty('turn');
    }
  });

  it("records where a turn's wait went: the state, each reply asked of the model, and its tools", async () => {
    // A clock the test moves, so each stage has a known length.
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await greeted();
      await callerTurn('c1', MIKE);

      // Reply 1: a word of acknowledgement and a save, 900 ms after it was asked for.
      now += 900;
      const first = model.say('a1', 'Okay.', { finish: false });
      socket.play();
      now += 100;
      callSession.applyIntakeOperation.mockResolvedValueOnce(backend(MIKE));
      model.callbacks.onResponseDone({
        id: first,
        status: 'completed',
        toolCalls: [{ callId: 'fc1', name: 'update_call_information', arguments: JSON.stringify({ customerName: 'Mike' }) }],
      });
      await settle();

      // Reply 2: the question, 950 ms after the tool results went back.
      now += 950;
      model.say('a2', 'Where exactly on I-95 are you?');
      socket.play();
      await settle();
      expect(events(CallEventType.TURN_TIMING)).toEqual([]);

      // Recorded as the next turn begins.
      await callerTurn('c2', MIKE);
      expect(events(CallEventType.TURN_TIMING)).toEqual([
        {
          turn: 1,
          stateMs: 0,
          replies: [
            { reason: 'caller-turn', askedMs: 0, audioMs: 900, toolsMs: 0 },
            { reason: 'tool-results', askedMs: 1000, audioMs: 950 },
          ],
          voiceMs: 900,
          lastReplyMs: 1950,
          sinceLastSound: false,
          fillers: 0,
        },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it('records the timing of the last turn when the call ends', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.say('a1', 'Where exactly on I-95 are you?');
    socket.play();
    await settle();
    socket.close();
    await settle();

    const timings = events(CallEventType.TURN_TIMING);
    expect(timings).toHaveLength(1);
    expect(timings[0]).toEqual(expect.objectContaining({ turn: 1, replies: [expect.objectContaining({ reason: 'caller-turn', audioMs: expect.any(Number) })] }));
  });

  it('records no timing for a turn nothing was asked of the model for', async () => {
    connect({ wordsWaitMs: 1_500 });
    await greeted();
    // "Um" on a turn of its own: the caller has not finished, and no reply is asked for.
    await callerTurn('c1', {});
    model.callbacks.onCallerTranscript('c1', 'Um');
    await settle();
    expect(model.requestResponse.mock.calls.filter(([request]) => request?.reason === 'caller-turn')).toHaveLength(0);
    await callerTurn('c2', MIKE);
    model.callbacks.onCallerTranscript('c2', 'My semi truck broke down on I-95.');
    await settle();

    expect(model.requestResponse.mock.calls.filter(([request]) => request?.reason === 'caller-turn')).toHaveLength(1);
    expect(events(CallEventType.TURN_TIMING)).toEqual([]);
  });

  it('records the note pinned before a reply, and the reply asked for', async () => {
    await greeted();
    await callerTurn('c1', MIKE);

    expect(events(CallEventType.MODEL_NOTE)).toEqual([
      expect.objectContaining({ kind: 'state', pinned: true, action: 'ASK_LOCATION_DETAIL', text: expect.stringContaining('REQUIRED ACTION: ASK_LOCATION_DETAIL'), turn: 1 }),
    ]);
    expect(events(CallEventType.REPLY_REQUESTED)).toContainEqual(expect.objectContaining({ reason: 'caller-turn', turn: 1 }));
  });

  it('records one-off instructions for a reply, but never the receptionist\'s whole prompt', async () => {
    await startCall();
    const [greeting] = events(CallEventType.REPLY_REQUESTED);

    expect(greeting).toEqual(expect.objectContaining({ reason: 'greeting', toolChoice: 'none', instructions: expect.stringContaining(GREETING) }));
    // The one-off line alone: the receptionist's whole prompt is never in the trail.
    expect(greeting!.instructions).toBe(greetingInstructions(GREETING));
  });

  it('records each reply: what was said, how much was heard, and what it answered', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.callbacks.onCallerTranscript('c1', 'My semi broke down on I-95.');
    model.say('a1', 'Where exactly on I-95 are you?');
    socket.play();
    await settle();

    expect(events(CallEventType.AI_RESPONSE)).toContainEqual(
      expect.objectContaining({ text: 'Where exactly on I-95 are you?', stopped: null, heardMs: 200, audioMs: 200, inReplyTo: 'caller-turn', turn: 1 }),
    );
    expect(events(CallEventType.AI_RESPONSE)).toContainEqual(expect.objectContaining({ greeting: true, inReplyTo: 'greeting' }));
  });

  it('records a filler as a reply the gateway played', async () => {
    await greeted();
    await callerTurn('c1');
    vi.advanceTimersByTime(1_100);
    socket.play();
    await settle();

    expect(events(CallEventType.AI_RESPONSE)).toContainEqual(expect.objectContaining({ text: 'One moment.', filler: true, inReplyTo: 'filler' }));
  });

  it('records a tool call the backend could not use', async () => {
    await greeted();
    model.callTools([{ callId: 'fc1', name: 'nope', arguments: {} }]);
    await settle();

    expect(events(CallEventType.TOOL_CALL)).toEqual([
      expect.objectContaining({ kind: 'nope', understood: false, output: { error: expect.stringContaining('Could not use nope') } }),
    ]);
  });

  it('records a pause for the caller\'s acknowledgement, and what decided it', async () => {
    await greeted();
    model.say('a1', 'So that is a Honda Civic at exit 12 on I-95.', { chunks: 4 });
    socket.play(2);
    let now = 3_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      model.callbacks.onSpeechStarted();
      callerAudio(LOUD, PLAY_THROUGH_VOICED_MS - 20);
      now += 300; // played through so far
      callerAudio(LOUD, 120); // playback stops here
      now += 400;
      callerAudio(QUIET, HOLD_RESUME_SILENCE_MS);
    } finally {
      clock.mockRestore();
    }
    await settle();

    // The gap the caller heard is the 400 ms playback was stopped for, not the 700 ms since the sound began.
    expect(events(CallEventType.HOLD_RESUMED)).toEqual([
      expect.objectContaining({ via: 'gauge', voicedMs: 400, holdMs: 700, pausedMs: 400, resumedMs: 600, nothingHeard: false }),
    ]);
    expect(events(CallEventType.HOLD_RESUMED)[0]).not.toHaveProperty('playedThrough');
  });

  it('records a sound the reply played through as one, and counts only a real pause as a pause', async () => {
    await greeted();
    model.say('a1', 'So that is a Honda Civic at exit 12 on I-95, and the best number is the one you are calling from.', { chunks: 6 });
    socket.play(2);
    briefOverlap(); // 200 ms: played through
    pausedOverlap(); // 400 ms: paused, and the unheard second sent again
    model.callbacks.onUsage?.({ kind: 'response', usage: { output_token_details: { text_tokens: 8, audio_tokens: 40 } } });
    socket.fromTwilio({ event: 'stop', streamSid: 'MZ1' });
    await settle();

    expect(events(CallEventType.HOLD_RESUMED)).toEqual([
      expect.objectContaining({ via: 'gauge', voicedMs: 200, resumedMs: 0, playedThrough: true, nothingHeard: false }),
      expect.objectContaining({ via: 'gauge', voicedMs: 400, resumedMs: 1_000, nothingHeard: false }),
    ]);
    expect(events(CallEventType.AI_USAGE)).toEqual([expect.objectContaining({ pauses: 1 })]);
  });

  it('records how the stream ended', async () => {
    await greeted();
    socket.close();
    await settle();

    expect(callSession.handleEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      { kind: 'HANGUP' },
      { phrase: false, trace: { endedBy: 'caller hung up' } },
    );
  });
});

describe('a yes the model did not save', () => {
  /** Everything saved; the number is the question. */
  const ALL: SlotValues = { ...MIKE, location: 'I-95 near exit 42', vehicleMovable: false };
  const QUESTION = "Is the number you're calling from the best one to reach you?";

  /** From now on the judge reads the caller's line as a yes, and the backend confirms the number on it. */
  function judgeTakesYes() {
    callSession.judgeCallerLine.mockResolvedValueOnce({ kind: 'judgment', text: 'Yes.', judgments: {} });
    callSession.applyIntakeOperation.mockImplementation(async () => backend(ALL, { phoneConfirmed: true }));
  }
  const tagOf = (reason: string) =>
    model.requestResponse.mock.calls.filter(([request]) => request?.reason === reason).at(-1)?.[0]?.tag;

  it('drops the reply asked for under the old plan, and asks for the read-back instead', async () => {
    await greeted();
    await callerTurn('c1', ALL);
    expect(model.lastNote()).toContain('REQUIRED ACTION: CONFIRM_CALLBACK_NUMBER');
    const old = tagOf('caller-turn');

    judgeTakesYes();
    model.callbacks.onCallerTranscript('c1', 'Yes.');
    await settle();

    expect(model.lastNote()).toContain('REQUIRED ACTION: CONFIRM_DETAILS');
    // The yes is saved, and the read-back is in the note word for word.
    const fresh = stateOf(ALL, { phoneConfirmed: true });
    expect(model.lastNote()).toBe(buildActionNote(fresh, { answered: 'Yes.' }));
    expect(model.lastNote()).toContain(renderReadBack(fresh.readBack!));
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'judged-yes' }));

    // The reply asked for before the yes was taken starts: it is dropped unheard.
    const media = socket.count('media');
    model.say('a1', QUESTION, { reason: 'caller-turn', tag: old });
    await settle();
    expect(model.cancelResponse).toHaveBeenCalledWith({ keepQueued: true });
    expect(socket.count('media')).toBe(media);
    expect(callSession.appendAiTranscriptLine).not.toHaveBeenCalledWith('biz-1', 'call-1', expect.stringContaining(QUESTION));

    // The read-back asked for under the fresh plan plays.
    model.say('rb', renderReadBack(fresh.readBack!));
    await settle();
    expect(socket.count('media')).toBeGreaterThan(media);
  });

  it('stops the number question already under way, and redirects it as settled', async () => {
    await greeted();
    await callerTurn('c1', ALL);
    model.say('a1', 'Okay.', { finish: false });

    judgeTakesYes();
    model.callbacks.onCallerTranscript('c1', 'Yes.');
    await settle();
    // Under way: left to run, under the fresh plan's checks.
    expect(model.cancelResponse).not.toHaveBeenCalled();

    model.callbacks.onSpokenText('a1', `Okay. ${QUESTION}`);
    await settle();

    expect(model.cancelResponse).toHaveBeenCalled();
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.ACTION_DEVIATION,
      expect.objectContaining({ asked: 'callback_number', required: 'CONFIRM_DETAILS', redirected: true }),
    );
    // Redirected as settled, not as waiting, with the read-back word for word.
    const { plan } = backend(ALL, { phoneConfirmed: true });
    expect(model.lastNote()).toBe(redirectNote('callback_number', plan, ''));
    expect(model.lastNote()).toContain(renderReadBack(plan.summary!));
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'redirect' }));
  });

  it('delivers the fresh plan once a reply under way has finished without asking again', async () => {
    await greeted();
    await callerTurn('c1', ALL);
    model.say('a1', 'Okay.', { finish: false });

    judgeTakesYes();
    model.callbacks.onCallerTranscript('c1', 'Yes.');
    await settle();
    model.callbacks.onResponseDone({ id: 'resp-2', status: 'completed', toolCalls: [] });
    await settle();

    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'judged-yes' }));
    expect(model.lastNote()).toContain('REQUIRED ACTION: CONFIRM_DETAILS');
  });

  it('leaves a question already asked for the caller to answer', async () => {
    await greeted();
    await callerTurn('c1', ALL);
    model.say('a1', QUESTION);
    socket.play();
    await settle();
    const asked = model.requestResponse.mock.calls.length;

    judgeTakesYes();
    model.callbacks.onCallerTranscript('c1', 'Yes.');
    await settle();
    expect(model.requestResponse.mock.calls.length).toBe(asked);
  });

  it('ends the call on a yes to the read-back with one goodbye, and returns a late complete_request with none', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(ALL, { phoneConfirmed: true }));
    model.callbacks.onCallerTurn('c1');
    await settle();
    expect(model.lastNote()).toContain('REQUIRED ACTION: CONFIRM_DETAILS');

    const judging = deferred<unknown>();
    const done = { output: { callEnded: true, note: 'This call has already been completed.' }, ended: true, outcome: 'lead_created', plan: null };
    callSession.judgeCallerLine.mockResolvedValueOnce({ kind: 'judgment', text: "Yes, that's right.", judgments: {} });
    callSession.applyIntakeOperation.mockImplementation(async (_b: string, _c: string, op: { kind: string }) =>
      op.kind === 'judgment' ? judging.promise : op.kind === 'complete' ? done : { output: { ok: true }, ended: false, outcome: null, plan: null },
    );
    model.callbacks.onCallerTranscript('c1', "Yes, that's right.");
    await settle();
    // The model calls complete_request itself while the backend is completing the request.
    model.callTools([{ callId: 'fc1', name: 'complete_request', arguments: { callerConfirmed: true } }]);
    await settle();
    const { state } = backend(ALL, { phoneConfirmed: true }).output;
    judging.resolve({ output: { callEnded: true, leadCreated: true, state }, ended: true, outcome: 'lead_created', plan: null });
    await settle();

    expect(model.submitToolResults).toHaveBeenLastCalledWith(expect.any(Array), undefined, null);
    const goodbyes = model.requestResponse.mock.calls.filter(([request]) => request?.reason?.endsWith('goodbye'));
    expect(goodbyes).toEqual([
      [
        expect.objectContaining({
          reason: 'confirmed-goodbye',
          toolChoice: 'none',
          instructions: expect.stringContaining(exactLineInstructions(confirmedGoodbyeLine(state))),
        }),
      ],
    ]);
    expect(confirmedGoodbyeLine(state)).toContain('Mike');

    model.say('bye', confirmedGoodbyeLine(state));
    socket.play();
    await settle();
    expect(socket.closed).toBe(true);
  });

  /** The judge reads the caller's line as a yes to the read-back, and the backend ends the call on it. */
  function judgeEndsCall(output: Record<string, unknown>) {
    callSession.judgeCallerLine.mockResolvedValueOnce({ kind: 'judgment', text: 'Yes.', judgments: {} });
    callSession.applyIntakeOperation.mockImplementation(async (_b: string, _c: string, op: { kind: string }) =>
      op.kind === 'judgment' ? { output, ended: true, outcome: 'lead_created', plan: null } : { output: { ok: true }, ended: false, outcome: null, plan: null },
    );
  }

  /** Whether the ending note was pinned before the goodbye asked for with `reason`. */
  function endingNoteBefore(reason: string): boolean {
    const notes = model.addNote.mock.calls.map(([text], i) => ({ text, order: model.addNote.mock.invocationCallOrder[i]! }));
    const ending = notes.find((note) => note.text === ENDING_NOTE);
    const requests = model.requestResponse.mock.calls.map(([request], i) => ({ request, order: model.requestResponse.mock.invocationCallOrder[i]! }));
    const goodbye = requests.find(({ request }) => request?.reason === reason);
    return Boolean(ending && goodbye && ending.order < goodbye.order);
  }

  it('replaces the note that asks for a yes before asking for the goodbye', async () => {
    // A real call: the note still said "ask whether the details were right",
    // and "Were those details right?" was the goodbye.
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(ALL, { phoneConfirmed: true }));
    model.callbacks.onCallerTurn('c1');
    await settle();

    const { state } = backend(ALL, { phoneConfirmed: true }).output;
    judgeEndsCall({ callEnded: true, state });
    model.callbacks.onCallerTranscript('c1', 'Yes.');
    await settle();

    expect(model.addNote).toHaveBeenCalledWith(ENDING_NOTE, { pinned: true });
    expect(endingNoteBefore('confirmed-goodbye')).toBe(true);
  });

  it('says the goodbye word for word when the model completes the request itself', async () => {
    await greeted();
    await callerTurn('c1', ALL);
    const { state } = backend({ ...ALL, location: undefined }, { phoneConfirmed: true }).output;
    callSession.applyIntakeOperation.mockResolvedValueOnce({ output: { callEnded: true, state }, ended: true, outcome: 'callback_created', plan: null });
    model.callTools([{ callId: 'fc1', name: 'complete_request', arguments: { callerConfirmed: true } }]);
    await settle();

    const [, , request] = model.submitToolResults.mock.calls.at(-1)!;
    expect(request).toEqual(
      expect.objectContaining({
        reason: 'tool-results-goodbye',
        toolChoice: 'none',
        instructions: expect.stringContaining(exactLineInstructions(confirmedGoodbyeLine(state))),
      }),
    );
    // What the team will still call about is in it: the location was never given.
    expect(confirmedGoodbyeLine(state)).not.toBe(confirmedGoodbyeLine(stateOf(ALL, { phoneConfirmed: true })));
    expect(model.addNote).toHaveBeenCalledWith(ENDING_NOTE, { pinned: true });
  });

  it('owes no reply to a caller who speaks during the goodbye, so the line closes once it has played', async () => {
    await greeted();
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(ALL, { phoneConfirmed: true }));
    model.callbacks.onCallerTurn('c1');
    await settle();
    judgeEndsCall({ callEnded: true });
    model.callbacks.onCallerTranscript('c1', 'Yes.');
    await settle();

    const bye = model.say('bye', confirmedGoodbyeLine(undefined), { finish: false });
    model.callbacks.onCallerTurn('c2'); // "Thanks, bye!" over the goodbye
    await settle();
    model.callbacks.onResponseDone({ id: bye, status: 'completed', toolCalls: [] });
    socket.play();
    await settle();

    expect(socket.closed).toBe(true);
  });
});

describe('the caller\'s words, known before the reply', () => {
  // The real call of 12 October: on every turn the transcript arrived about
  // 400 ms before the model's first audio, and the reply had been planned
  // without it. "I asked you something else." was met with "Could you
  // describe the location?", and the caller hung up.

  /** Needs a reply whatever the classifier makes of it: a question to some versions, a complaint to others. */
  const COMPLAINT = 'Why do you keep cutting me off?';
  const events = (type: string) => callSession.logCallEvent.mock.calls.filter(([, , t]) => t === type).map(([, , , payload]) => payload);
  const asked = (reason: string) => model.requestResponse.mock.calls.filter(([request]) => request?.reason === reason).map(([request]) => request!);
  const tagOf = (reason: string) => asked(reason).at(-1)?.tag;
  const asksUnheard = () => callSession.applyIntakeOperation.mock.calls.filter(([, , op]) => op.kind === 'ask_unheard');

  it('asks again with words the reply was planned without, and drops the first reply when it starts', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    const old = tagOf('caller-turn');

    model.callbacks.onCallerTranscript('c1', COMPLAINT);
    await settle();

    // No tools: a line that needs a reply carries no detail to save.
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-words', toolChoice: 'none' }));
    expect(model.addNote).toHaveBeenLastCalledWith(expect.stringContaining(`THE CALLER JUST SAID: "${COMPLAINT}"`), { pinned: true });
    // The backend's required action is still the note's.
    expect(model.lastNote()).toContain('REQUIRED ACTION: ASK_LOCATION_DETAIL');
    expect(events(CallEventType.REPLY_REQUESTED)).toContainEqual(
      expect.objectContaining({ reason: 'caller-words', toolChoice: 'none', said: COMPLAINT, superseded: 'asked', turn: 1 }),
    );

    // The reply asked for without the words starts: it is dropped unheard.
    const media = socket.count('media');
    model.say('a1', 'Where exactly on I-95 are you?', { reason: 'caller-turn', tag: old });
    await settle();
    expect(model.cancelResponse).toHaveBeenCalledWith({ keepQueued: true });
    expect(socket.count('media')).toBe(media);

    // The reply asked for with them plays, and is the only one on the record.
    const reply = "Sorry about that, I'm listening. Where exactly on I-95 are you?";
    model.say('a2', reply);
    socket.play();
    await settle();
    expect(socket.count('media')).toBeGreaterThan(media);
    expect(order).toEqual([`caller: ${COMPLAINT}`, `ai: ${reply}`]);
  });

  it('cancels a reply under way that the caller has heard none of, and keeps it out of the transcript', async () => {
    // Turn 5 of the real call, met with "Could you describe the location?".
    const complaint = 'I asked you something else.';
    await greeted();
    await callerTurn('c1', MIKE);
    // Started: its first words are known, none of its audio has arrived.
    model.callbacks.onResponseStarted('r1', true, 'caller-turn', tagOf('caller-turn'));
    model.callbacks.onSpokenText('a1', 'Could you describe');
    const media = socket.count('media');

    model.callbacks.onCallerTranscript('c1', complaint);
    await settle();

    expect(model.cancelResponse).toHaveBeenCalledWith({ keepQueued: true });
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-words', toolChoice: 'none' }));
    expect(model.lastNote()).toContain(`THE CALLER JUST SAID: "${complaint}"`);
    expect(events(CallEventType.REPLY_REQUESTED)).toContainEqual(expect.objectContaining({ reason: 'caller-words', superseded: 'started' }));

    // Its audio still arriving, before the cancel lands, goes nowhere.
    model.callbacks.onAudio('a1', Buffer.alloc(1600, 0xff));
    model.callbacks.onSpokenText('a1', 'Could you describe the location?');
    model.callbacks.onResponseDone({ id: 'r1', status: 'cancelled', toolCalls: [] });
    await settle();
    expect(socket.count('media')).toBe(media);

    const reply = "Sorry, I'm listening. Where exactly on I-95 are you?";
    model.say('a2', reply);
    socket.play();
    await settle();
    expect(order).toEqual([`caller: ${complaint}`, `ai: ${reply}`]);
  });

  it('leaves a reply the caller has begun to hear', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.say('a1', 'Where exactly on I-95 are you?', { finish: false });

    model.callbacks.onCallerTranscript('c1', COMPLAINT);
    await settle();

    expect(asked('caller-words')).toEqual([]);
    expect(model.cancelResponse).not.toHaveBeenCalled();
  });

  it.each([
    ['a detail', 'My Honda Civic broke down at exit 42.'],
    ['an acknowledgement', 'Okay.'],
    ['a request for a moment', 'Hold on, let me find the exit.'],
  ])('leaves the reply as it was after %s', async (_, said) => {
    await greeted();
    await callerTurn('c1', MIKE);
    const notes = model.addNote.mock.calls.length;

    model.callbacks.onCallerTranscript('c1', said);
    await settle();

    expect(asked('caller-words')).toEqual([]);
    expect(model.addNote.mock.calls.length).toBe(notes);
    expect(model.cancelResponse).not.toHaveBeenCalled();
  });

  it('leaves the words to the tool results while tools run, and quotes them in that note', async () => {
    // The real call, turn 6: a tool call on a line with no detail in it, and
    // the reply after it never answered "What kind of information have I
    // already given you?".
    await greeted();
    await callerTurn('c1', MIKE);
    const saving = deferred<unknown>();
    callSession.applyIntakeOperation.mockReturnValueOnce(saving.promise);
    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { callerIdConfirmed: true } }]);
    await settle();

    model.callbacks.onCallerTranscript('c1', COMPLAINT);
    await settle();
    expect(asked('caller-words')).toEqual([]);

    saving.resolve(backend(MIKE));
    await settle();
    const [, note, request] = model.submitToolResults.mock.calls.at(-1)!;
    expect(note).toContain(`THE CALLER JUST SAID: "${COMPLAINT}"`);
    expect(note).toContain('REQUIRED ACTION: ASK_LOCATION_DETAIL');
    expect(request).toEqual(expect.objectContaining({ reason: 'tool-results' }));
    expect(asked('caller-words')).toEqual([]);
  });

  it('leaves a line that gives a detail and asks something to the save, and quotes it after', async () => {
    // The classifier's contract, whatever version of it is in place: a line
    // that carries any detail is a detail, even if it also asks something.
    vi.mocked(classifyCallerWords).mockImplementation((text) => (/\bexit \d+/i.test(text) ? 'detail' : 'unknown'));
    const mixed = "I'm at exit 42, how long will it take?";
    await greeted();
    await callerTurn('c1', MIKE);

    model.callbacks.onCallerTranscript('c1', mixed);
    await settle();
    expect(asked('caller-words')).toEqual([]);
    expect(model.cancelResponse).not.toHaveBeenCalled();

    // The model saves the exit; the question reaches it with the results.
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend({ ...MIKE, location: 'I-95, exit 42' }));
    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { location: 'I-95, exit 42' } }]);
    await settle();
    const [, note] = model.submitToolResults.mock.calls.at(-1)!;
    expect(note).toContain(`THE CALLER JUST SAID: "${mixed}"`);
    expect(note).toContain('REQUIRED ACTION:');
  });

  it('quotes words transcribed before the state came back in the first note, and asks once', async () => {
    await greeted();
    const state = deferred<unknown>();
    callSession.applyIntakeOperation.mockReturnValueOnce(state.promise);
    model.requestResponse.mockClear();

    model.callbacks.onCallerTurn('c1');
    await settle();
    model.callbacks.onCallerTranscript('c1', COMPLAINT);
    await settle();
    expect(model.requestResponse).not.toHaveBeenCalled();

    state.resolve(backend(MIKE));
    await settle();
    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-turn', toolChoice: 'none' }));
    expect(model.lastNote()).toContain(`THE CALLER JUST SAID: "${COMPLAINT}"`);
    expect(model.lastNote()).toContain('REQUIRED ACTION: ASK_LOCATION_DETAIL');
    expect(events(CallEventType.REPLY_REQUESTED)).toContainEqual(expect.objectContaining({ reason: 'caller-turn', said: COMPLAINT, turn: 1 }));
  });

  it('counts the question in the reply that replaced another once, when the caller cuts it off unheard', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    // The first reply, an ask, has started and is dropped with nothing of it heard.
    model.callbacks.onResponseStarted('r1', true, 'caller-turn', tagOf('caller-turn'));
    model.callbacks.onSpokenText('a1', 'Where exactly');
    model.callbacks.onCallerTranscript('c1', COMPLAINT);
    await settle();
    model.callbacks.onResponseDone({ id: 'r1', status: 'cancelled', toolCalls: [] });
    await settle();

    const reply = 'Sorry about that. Where exactly on I-95 are you, the nearest exit or a mile marker?';
    model.say('a2', reply, { chunks: 4, finish: false });
    socket.play(2); // "Sorry about that. Where": the question not heard
    model.callbacks.onSpeechStarted();
    callerAudio(LOUD, BARGE_IN_VOICED_MS);
    await settle();

    expect(asksUnheard()).toEqual([['biz-1', 'call-1', { kind: 'ask_unheard', action: 'ASK_LOCATION_DETAIL' }, { callerTurn: 1 }]]);
    // The dropped reply left no line of its own.
    expect(callSession.appendAiTranscriptLine).not.toHaveBeenCalledWith('biz-1', 'call-1', 'Where exactly');
  });

  it('answers in place of a reply that finished without a word, instead of waiting to ask if they are there', async () => {
    const silences = () => callSession.applyIntakeOperation.mock.calls.filter(([, , op]) => op.kind === 'silence').length;
    await greeted();
    await callerTurn('c1', MIKE);
    model.callbacks.onResponseStarted('r1', true, 'caller-turn', tagOf('caller-turn'));
    model.callbacks.onResponseDone({ id: 'r1', status: 'completed', toolCalls: [] });
    await settle();

    model.callbacks.onCallerTranscript('c1', 'Can you hear me?');
    await settle();
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-words', toolChoice: 'none' }));
    expect(events(CallEventType.REPLY_REQUESTED)).toContainEqual(expect.objectContaining({ reason: 'caller-words', superseded: 'empty' }));

    vi.advanceTimersByTime(7_100);
    await settle();
    expect(silences()).toBe(0);
  });

  it('never replaces a line said word for word', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    // The model saves the last detail; the read-back is asked for, word for word.
    const values = { ...MIKE, location: 'I-95, exit 42', vehicleMovable: false };
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend(values, { phoneConfirmed: true }));
    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { vehicleMovable: false } }]);
    await settle();
    expect(model.submitToolResults.mock.calls.at(-1)![2]).toEqual(expect.objectContaining({ reason: 'read-back' }));

    model.callbacks.onCallerTranscript('c1', COMPLAINT);
    await settle();
    expect(asked('caller-words')).toEqual([]);
  });

  it('chooses a filler that fits what the caller just said', async () => {
    await greeted();
    await callerTurn('c1', MIKE);
    model.callbacks.onCallerTranscript('c1', 'How long will it take?');
    vi.advanceTimersByTime(1_100);
    await settle();
    expect(fillers.next).toHaveBeenLastCalledWith('question');

    // Not known yet: the usual sound of listening.
    model.say('a1', 'Where exactly on I-95 are you?');
    socket.play();
    await callerTurn('c2', MIKE);
    vi.advanceTimersByTime(1_100);
    await settle();
    expect(fillers.next).toHaveBeenLastCalledWith('turn');
  });
});

/** The wait these tests run with: longer than the 300 ms at which their transcripts arrive. */
const HELD_MS = 500;

describe('the first reply waits for the caller\'s words', () => {
  // The real call of 12 October (6d1304af): the transcript came 400 to 560 ms
  // after the reply was asked for, on every turn. Held that long, the first
  // request quotes the caller, and a question needs no second one.

  const COMPLAINT = 'Why do you keep cutting me off?';
  const QUESTION = 'How long will it take?';
  const DETAIL = 'My Honda Civic broke down at exit 42.';
  const events = (type: string) => callSession.logCallEvent.mock.calls.filter(([, , t]) => t === type).map(([, , , payload]) => payload);
  const asked = (reason: string) => model.requestResponse.mock.calls.filter(([request]) => request?.reason === reason).map(([request]) => request!);
  const requested = (reason: string) => events(CallEventType.REPLY_REQUESTED).filter((payload) => payload.reason === reason);

  beforeEach(() => {
    // The wait is counted from the end of the turn on the clock: faked with the timers.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    connect({ wordsWaitMs: HELD_MS });
  });

  /** The greeting has been heard; requests from here on are the turn's. */
  async function ready() {
    await greeted();
    model.requestResponse.mockClear();
    fillers.next.mockClear();
  }

  it.each([
    ['a question, without tools', QUESTION, 'none'],
    ['a detail, with tools', DETAIL, undefined],
  ])('asks once, when the words arrive, quoting %s', async (_, said, toolChoice) => {
    await ready();
    await callerTurn('c1', MIKE);
    expect(model.requestResponse).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    model.callbacks.onCallerTranscript('c1', said);
    await settle();

    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(model.lastRequest()?.reason).toBe('caller-turn');
    expect(model.lastRequest()?.toolChoice).toBe(toolChoice);
    // A line that needs a reply is also told what to do in the reply's own instructions; a detail is not.
    if (toolChoice === 'none') expect(model.lastRequest()?.instructions).toContain(`RIGHT NOW
The caller just said: "${said}"`);
    else expect(model.lastRequest()?.instructions).toBeUndefined();
    const kind = classifyCallerWords(said);
    expect(model.lastNote()).toBe(buildActionNote(stateOf(MIKE), { beforeSave: true, callerJustSaid: { text: said, kind } }));
    expect(requested('caller-turn')).toEqual([expect.objectContaining({ said, kind, waitedMs: 300, turn: 1 })]);

    // The rest of the wait, and the filler: nothing is asked for again.
    vi.advanceTimersByTime(2_000);
    await settle();
    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(asked('caller-words')).toEqual([]);
    expect(fillers.next).toHaveBeenCalledTimes(1);
  });

  it('does not wait when no filler is recorded to cover the wait', async () => {
    // The real call (fe228d39): the recordings had failed at start-up, and every reply came later into silence.
    (fillers as { size?: number }).size = 0;
    await ready();
    await callerTurn('c1', MIKE);
    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(requested('caller-turn')[0]).not.toHaveProperty('waitedMs');
  });

  it('asks at the cap with the note from before the words, and still answers words that come later', async () => {
    await ready();
    await callerTurn('c1', MIKE);
    vi.advanceTimersByTime(HELD_MS - 1);
    await settle();
    expect(model.requestResponse).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await settle();
    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-turn' }));
    expect(model.lastRequest()?.toolChoice).toBeUndefined();
    expect(model.lastNote()).toBe(buildActionNote(stateOf(MIKE), { beforeSave: true }));
    expect(requested('caller-turn')).toEqual([expect.objectContaining({ waitedMs: HELD_MS })]);
    expect(requested('caller-turn')[0]).not.toHaveProperty('said');

    // Late words that need a reply: the reply is asked for again, as before.
    vi.advanceTimersByTime(200);
    model.callbacks.onCallerTranscript('c1', COMPLAINT);
    await settle();
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-words', toolChoice: 'none' }));
    expect(model.lastNote()).toContain(`THE CALLER JUST SAID: "${COMPLAINT}"`);
    expect(requested('caller-words')).toEqual([expect.objectContaining({ said: COMPLAINT, superseded: 'asked' })]);
    expect(model.requestResponse).toHaveBeenCalledTimes(2);
  });

  it('asks at once, without words, when the transcription fails', async () => {
    await ready();
    await callerTurn('c1', MIKE);
    vi.advanceTimersByTime(100);
    model.callbacks.onCallerTranscript('c1', null);
    await settle();

    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(model.lastNote()).toBe(buildActionNote(stateOf(MIKE), { beforeSave: true }));
    vi.advanceTimersByTime(HELD_MS);
    await settle();
    expect(model.requestResponse).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for a turn the caller follows with another during the wait: the new turn\'s reply answers both', async () => {
    await ready();
    await callerTurn('c1', MIKE);
    vi.advanceTimersByTime(200);
    await callerTurn('c2', MIKE);

    model.callbacks.onCallerTranscript('c1', 'I need a tow.');
    await settle();
    vi.advanceTimersByTime(300); // where the first turn's wait would have ended
    await settle();
    expect(model.requestResponse).not.toHaveBeenCalled();

    model.callbacks.onCallerTranscript('c2', DETAIL);
    await settle();
    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(model.lastNote()).toContain(`THE CALLER JUST SAID: "${DETAIL}"`);
    expect(requested('caller-turn')).toEqual([expect.objectContaining({ said: DETAIL, turn: 2 })]);
  });

  it('asks nothing once the caller hangs up during the wait', async () => {
    await ready();
    await callerTurn('c1', MIKE);
    vi.advanceTimersByTime(200);
    socket.close();
    await settle();
    vi.advanceTimersByTime(HELD_MS);
    await settle();

    expect(model.requestResponse).not.toHaveBeenCalled();
    expect(requested('caller-turn')).toEqual([]);
  });

  it('asks only for the goodbye when the call ends during the wait', async () => {
    businessConfig.load.mockResolvedValueOnce({ flow: { facts: FACTS }, maxCallSeconds: 1 });
    await ready();
    vi.advanceTimersByTime(800);
    await callerTurn('c1', MIKE);
    vi.advanceTimersByTime(300); // the call's time runs out
    await settle();
    model.callbacks.onCallerTranscript('c1', QUESTION);
    vi.advanceTimersByTime(HELD_MS);
    await settle();

    expect(model.requestResponse.mock.calls.map(([request]) => request?.reason)).toEqual(['time-limit-goodbye']);
  });

  it('covers the wait with a filler timed from the end of the turn, once', async () => {
    connect({ wordsWaitMs: 1_500 });
    await ready();
    await callerTurn('c1', MIKE);
    const before = socket.count('media');

    vi.advanceTimersByTime(1_099);
    await settle();
    expect(socket.count('media')).toBe(before);
    vi.advanceTimersByTime(1);
    await settle();
    expect(socket.count('media')).toBe(before + 10);
    expect(fillers.next).toHaveBeenCalledTimes(1);
    expect(model.requestResponse).not.toHaveBeenCalled();
    socket.play();

    vi.advanceTimersByTime(400);
    await settle();
    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await settle();
    expect(fillers.next).toHaveBeenCalledTimes(1);
  });

  it('asks at once, as before, with the wait set to 0', async () => {
    connect({ wordsWaitMs: 0 });
    await ready();
    await callerTurn('c1', MIKE);

    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(model.lastNote()).toBe(buildActionNote(stateOf(MIKE), { beforeSave: true }));
    expect(requested('caller-turn')).toHaveLength(1);
    expect(requested('caller-turn')[0]).not.toHaveProperty('waitedMs');
  });

  it('keeps holding the reply while the caller talks again, and answers their next turn once', async () => {
    await ready();
    await callerTurn('c1', MIKE);
    vi.advanceTimersByTime(200);
    model.callbacks.onSpeechStarted();
    model.callbacks.onCallerTranscript('c1', 'I need a tow.');
    await settle();
    // Long enough for a stalled reply: the quiet is theirs, not the receptionist's.
    vi.advanceTimersByTime(REPLY_STALL_MS + 1_000);
    await settle();
    expect(model.requestResponse).not.toHaveBeenCalled();
    expect(callSession.logCallEvent).not.toHaveBeenCalledWith('biz-1', 'call-1', CallEventType.PROVIDER_ERROR, expect.objectContaining({ stage: 'reply_stalled' }));

    model.callbacks.onSpeechStopped?.(6_000);
    await callerTurn('c2', MIKE);
    model.callbacks.onCallerTranscript('c2', DETAIL);
    await settle();
    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(requested('caller-turn')).toEqual([expect.objectContaining({ said: DETAIL, turn: 2 })]);
  });

  it('asks for the held reply once the caller stops, if no turn of theirs follows', async () => {
    await ready();
    await callerTurn('c1', MIKE);
    vi.advanceTimersByTime(200);
    model.callbacks.onSpeechStarted();
    model.callbacks.onCallerTranscript('c1', QUESTION);
    await settle();
    expect(model.requestResponse).not.toHaveBeenCalled();

    model.callbacks.onSpeechStopped?.(300);
    vi.advanceTimersByTime(200);
    await settle();
    expect(model.requestResponse).toHaveBeenCalledTimes(1);
    expect(model.lastRequest()).toEqual(expect.objectContaining({ reason: 'caller-turn', toolChoice: 'none' }));
    expect(requested('caller-turn')).toEqual([expect.objectContaining({ said: QUESTION, turn: 1 })]);
  });

  it('leaves the turn to the tool results when tools start during the wait', async () => {
    await ready();
    await callerTurn('c1', MIKE);
    vi.advanceTimersByTime(200);
    callSession.applyIntakeOperation.mockResolvedValueOnce(backend({ ...MIKE, location: 'I-95, exit 42' }));
    model.callTools([{ callId: 'fc1', name: 'update_call_information', arguments: { location: 'I-95, exit 42' } }]);
    await settle();
    model.callbacks.onCallerTranscript('c1', DETAIL);
    vi.advanceTimersByTime(HELD_MS);
    await settle();

    expect(asked('caller-turn')).toEqual([]);
    // The caller spoke and is waiting: the results' reply is asked for.
    expect(model.submitToolResults).toHaveBeenCalledTimes(1);
    expect(model.submitToolResults.mock.calls[0]![2]).toEqual(expect.objectContaining({ reason: 'tool-results' }));
  });

  it('leaves the turn to a yes the backend took during the wait', async () => {
    const ALL: SlotValues = { ...MIKE, location: 'I-95 near exit 42', vehicleMovable: false };
    await ready();
    // The first turn: "Yes." to the number, whose judgment is slow.
    const judging = deferred<unknown>();
    callSession.judgeCallerLine.mockReturnValueOnce(judging.promise);
    await callerTurn('c1', ALL);
    model.callbacks.onCallerTranscript('c1', 'Yes.');
    await settle();
    model.say('a1', 'Got it.');
    socket.play();
    await settle();

    // The next turn's reply is held when the judgment lands: the backend takes the yes.
    await callerTurn('c2', ALL);
    vi.advanceTimersByTime(100);
    callSession.applyIntakeOperation.mockImplementation(async () => backend(ALL, { phoneConfirmed: true }));
    judging.resolve({ kind: 'judgment', text: 'Yes.', judgments: {} });
    await settle();
    model.callbacks.onCallerTranscript('c2', 'Okay.');
    vi.advanceTimersByTime(HELD_MS);
    await settle();

    expect(model.requestResponse.mock.calls.map(([request]) => request?.reason)).toEqual(['caller-turn', 'judged-yes']);
    expect(requested('caller-turn')).toEqual([expect.objectContaining({ said: 'Yes.', turn: 1 })]);
    expect(model.lastNote()).toBe(buildActionNote(stateOf(ALL, { phoneConfirmed: true }), { answered: 'Yes.' }));
  });

  it('reads the setting as a wait from 0 to 2 s, the default when unset or unreadable', () => {
    expect(readWordsWait(undefined)).toBe(WORDS_WAIT_MS);
    expect(readWordsWait('')).toBe(WORDS_WAIT_MS);
    expect(readWordsWait('abc')).toBe(WORDS_WAIT_MS);
    expect(readWordsWait('-5')).toBe(WORDS_WAIT_MS);
    expect(readWordsWait('0')).toBe(0);
    expect(readWordsWait('800')).toBe(800);
    expect(readWordsWait(99_999)).toBe(2_000);
  });
});

describe('a greeting recorded in the call voice', () => {
  const CLIP: Filler = { text: GREETING, audio: Buffer.alloc(3_200, 0xff) };
  let greetings: { get: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> };

  /** A gateway with a greeting bank holding `clip` for the greeting; `adjust` can change the fake conversation it opens. */
  function withGreetings(clip: Filler | null, adjust: (fake: FakeConversation) => FakeConversation = (fake) => fake) {
    greetings = { get: vi.fn(() => clip), record: vi.fn(async () => clip) };
    const gateway = new RealtimeVoiceGateway(
      callSession as never,
      businessConfig as never,
      ({ instructions, callbacks, transcriptionPrompt }) => (model = adjust(new FakeConversation(instructions, callbacks, transcriptionPrompt))),
      fillers,
      judge,
      undefined,
      greetings,
      0,
    );
    socket = new FakeTwilioSocket();
    gateway.handleConnection(socket as never);
  }

  it('gives each call its own rotation through the filler lines', () => {
    expect(fillers.forCall).toHaveBeenCalledTimes(1);
  });

  it('plays the recording the instant the stream starts, and puts it in the conversation as already said', async () => {
    withGreetings(CLIP);
    await startCall();

    expect(greetings.get).toHaveBeenCalledWith(GREETING);
    expect(socket.sent.filter((m) => m.event === 'media')).toHaveLength(CLIP.audio.length / 160);
    expect(model.requestResponse).not.toHaveBeenCalled();
    expect(model.addAssistantMessage).toHaveBeenCalledWith(GREETING);
    expect(greetings.record).not.toHaveBeenCalled();

    socket.play();
    await settle();
    // The voice webhook recorded the greeting, so it is not written again; its playing is still on record.
    expect(callSession.appendAiTranscriptLine).not.toHaveBeenCalled();
    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.AI_RESPONSE,
      expect.objectContaining({ greeting: true, text: GREETING, inReplyTo: 'greeting' }),
    );
  });

  it('tells the model in a note when the conversation cannot carry a line as its own', async () => {
    withGreetings(CLIP, (fake) => {
      (fake as { addAssistantMessage?: unknown }).addAssistantMessage = undefined;
      return fake;
    });
    await startCall();

    expect(model.addNote).toHaveBeenCalledWith(alreadySaidNote(GREETING));
    expect(model.requestResponse).not.toHaveBeenCalled();
  });

  it('has the model speak a greeting with no recording, and has it recorded for the next call', async () => {
    withGreetings(null);
    await startCall();

    expect(model.lastRequest()?.instructions).toContain(greetingInstructions(GREETING));
    expect(greetings.record).not.toHaveBeenCalled();
    model.say('greet', GREETING);
    socket.play();
    await settle();

    expect(greetings.record).toHaveBeenCalledWith(GREETING);
    expect(callSession.appendAiTranscriptLine).not.toHaveBeenCalled();
  });
});
