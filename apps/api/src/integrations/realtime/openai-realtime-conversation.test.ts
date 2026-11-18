import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MODEL_SHUTDOWNS,
  OpenAiRealtimeConversation,
  isReasoningModel,
  modelShutdown,
  noteEvents,
  readReasoningEffort,
  reasoningConfig,
  reasoningLabel,
  shutdownWarning,
  turnDetectionConfig,
  responseCreateEvent,
  type RealtimeConversationOptions,
} from './openai-realtime-conversation';
import { REALTIME_TOOLS } from './realtime-tools';

/** A stand-in for the `ws` socket to OpenAI: records what is sent, and plays server events back. */
const fake = vi.hoisted(() => {
  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeSocket[] = [];

    readyState = FakeSocket.CONNECTING;
    readonly sent: Array<Record<string, any>> = [];
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor() {
      FakeSocket.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    send(data: string): void {
      this.sent.push(JSON.parse(data));
    }

    close(): void {
      this.readyState = FakeSocket.CLOSED;
    }

    terminate(): void {
      this.readyState = FakeSocket.CLOSED;
    }

    /** OpenAI accepts the connection; the session's settings go out. */
    open(): void {
      this.readyState = FakeSocket.OPEN;
      for (const listener of this.listeners.get('open') ?? []) listener();
    }

    /** One server event. */
    receive(event: Record<string, unknown>): void {
      for (const listener of this.listeners.get('message') ?? []) listener(Buffer.from(JSON.stringify(event)));
    }

    /** The events of one type, in the order they were sent. */
    sentOf(type: string): Array<Record<string, any>> {
      return this.sent.filter((event) => event.type === type);
    }
  }
  return { FakeSocket };
});

vi.mock('ws', () => ({ default: fake.FakeSocket }));

const open: OpenAiRealtimeConversation[] = [];

afterEach(() => {
  for (const conversation of open.splice(0)) conversation.close();
  fake.FakeSocket.instances.length = 0;
  vi.restoreAllMocks();
});

function startSession(overrides: Partial<RealtimeConversationOptions> = {}) {
  const callbacks = {
    onSpeechStarted: vi.fn(),
    onCallerTurn: vi.fn(),
    onCallerTranscript: vi.fn(),
    onResponseStarted: vi.fn(),
    onAudio: vi.fn(),
    onSpokenText: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
  };
  const conversation = new OpenAiRealtimeConversation({
    apiKey: 'test-key',
    model: 'gpt-realtime-mini',
    voice: 'marin',
    silenceMs: 900,
    transcriptionModel: 'gpt-4o-transcribe',
    instructions: 'You are the receptionist.',
    callbacks,
    ...overrides,
  });
  open.push(conversation);
  const socket = fake.FakeSocket.instances.at(-1)!;
  return { conversation, socket, callbacks };
}

/** The bytes of every audio append sent, in order. */
const appended = (socket: InstanceType<typeof fake.FakeSocket>) =>
  Buffer.concat(socket.sentOf('input_audio_buffer.append').map((event) => Buffer.from(event.audio as string, 'base64')));

const GREETING = 'Hi, thanks for calling Liberty Towing, how can I help?';

describe('state notes', () => {
  it('adds the first note with an id of its own, so it can be removed later', () => {
    expect(noteEvents('CALL STATE\n- nothing saved yet', 'note_1', null)).toEqual([
      {
        type: 'conversation.item.create',
        item: { id: 'note_1', type: 'message', role: 'system', content: [{ type: 'input_text', text: 'CALL STATE\n- nothing saved yet' }] },
      },
    ]);
  });

  it('removes the note it replaces before adding the next, so a call carries one state and not thirty', () => {
    const events = noteEvents('CALL STATE\n- Name: Mike', 'note_2', 'note_1');
    expect(events.map((e) => e.type)).toEqual(['conversation.item.delete', 'conversation.item.create']);
    expect(events[0]).toMatchObject({ item_id: 'note_1', event_id: 'del-note_1' });
  });
});

describe('a tool call the model has begun', () => {
  it('is reported as it begins, with the tool, well before the response is done', () => {
    const onToolCallStarted = vi.fn();
    const { socket, callbacks } = startSession();
    Object.assign(callbacks, { onToolCallStarted });
    socket.receive({ type: 'session.updated' });

    socket.receive({ type: 'response.output_item.added', response_id: 'resp_1', item: { type: 'function_call', name: 'update_call_information' } });
    expect(onToolCallStarted).toHaveBeenCalledWith('resp_1', 'update_call_information');
    // The tool is not always named this early: reported all the same, without it.
    socket.receive({ type: 'response.output_item.added', response_id: 'resp_2', item: { type: 'function_call' } });
    expect(onToolCallStarted).toHaveBeenLastCalledWith('resp_2', null);
  });

  it('is not reported for a message the model begins to speak', () => {
    const onToolCallStarted = vi.fn();
    const { socket, callbacks } = startSession();
    Object.assign(callbacks, { onToolCallStarted });
    socket.receive({ type: 'session.updated' });

    socket.receive({ type: 'response.output_item.added', response_id: 'resp_1', item: { type: 'message' } });
    expect(onToolCallStarted).not.toHaveBeenCalled();
  });
});

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

describe('response.create', () => {
  it('makes an out-of-band response, outside the conversation, only when asked', () => {
    const outOfBand = responseCreateEvent('req-1', { instructions: 'Say "Okay."', toolChoice: 'none', outOfBand: true }) as { response: Record<string, unknown> };
    expect(outOfBand.response).toEqual({ metadata: { request: 'req-1' }, instructions: 'Say "Okay."', tool_choice: 'none', conversation: 'none' });
    const ordinary = responseCreateEvent('req-2', { reason: 'caller-turn', tag: '7' }) as { response: Record<string, unknown> };
    // The reason and the tag are the gateway's own: never sent to OpenAI.
    expect(ordinary.response).toEqual({ metadata: { request: 'req-2' } });
  });
});

describe('a greeting already played from a recording', () => {
  it('is added as the assistant\'s own message, after the session settings, so the model does not greet again', () => {
    const { conversation, socket } = startSession();
    socket.open();
    // Played the instant the call connected, before the session was ready.
    conversation.addAssistantMessage(GREETING);
    expect(socket.sentOf('conversation.item.create')).toEqual([]);

    socket.receive({ type: 'session.updated' });
    expect(socket.sent.map((event) => event.type)).toEqual(['session.update', 'conversation.item.create']);
    expect(socket.sent[1]).toEqual({
      type: 'conversation.item.create',
      event_id: 'said-1',
      item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: GREETING }] },
    });
  });

  it('is told to the model in a note instead, once, when OpenAI refuses it, and is not reported as a call error', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { conversation, socket, callbacks } = startSession();
    socket.open();
    socket.receive({ type: 'session.updated' });
    conversation.addAssistantMessage(GREETING);

    socket.receive({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'invalid_value', message: 'Invalid content type', event_id: 'said-1' },
    });

    const notes = socket.sentOf('conversation.item.create').filter((event) => event.item.role === 'system');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.item.content).toEqual([
      { type: 'input_text', text: `You already greeted the caller with: "${GREETING}". Do not greet them again.` },
    ]);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused a line as the assistant\'s own (Invalid content type'));

    // Not pinned: the next state note does not remove it.
    conversation.addNote('CALL STATE\n- nothing saved yet', { pinned: true });
    expect(socket.sentOf('conversation.item.delete')).toEqual([]);

    // A refused shape is not tried again: a later line goes straight to a note.
    conversation.addAssistantMessage('Sorry about that.');
    const assistantItems = socket.sentOf('conversation.item.create').filter((event) => event.item.role === 'assistant');
    expect(assistantItems).toHaveLength(1);
    expect(socket.sent.at(-1)!.item.content[0].text).toBe('You already greeted the caller with: "Sorry about that.". Do not greet them again.');
  });

  it('still reports an error caused by any other event', () => {
    const { conversation, socket, callbacks } = startSession();
    socket.open();
    socket.receive({ type: 'session.updated' });
    conversation.addAssistantMessage(GREETING);
    const sentBefore = socket.sent.length;

    socket.receive({ type: 'error', error: { code: 'invalid_value', message: 'Bad tool choice', event_id: 'req-3' } });
    expect(callbacks.onError).toHaveBeenCalledWith(new Error('OpenAI realtime: Bad tool choice (invalid_value)'));
    expect(socket.sent).toHaveLength(sentBefore);
  });
});

describe('caller audio before the session is ready', () => {
  it('is held, then appended in the order it came, after the queued events, once the session is configured', () => {
    const { conversation, socket } = startSession();
    // Before OpenAI has even accepted the connection, and after it has but
    // before the settings are confirmed: both would be decoded wrongly.
    conversation.appendAudio(Buffer.alloc(160, 1));
    socket.open();
    conversation.addAssistantMessage(GREETING);
    conversation.appendAudio(Buffer.alloc(160, 2));
    expect(socket.sentOf('input_audio_buffer.append')).toEqual([]);

    socket.receive({ type: 'session.updated' });
    expect(socket.sent.map((event) => event.type)).toEqual(['session.update', 'conversation.item.create', 'input_audio_buffer.append']);
    expect(appended(socket)).toEqual(Buffer.concat([Buffer.alloc(160, 1), Buffer.alloc(160, 2)]));

    // From now on, audio goes straight through.
    conversation.appendAudio(Buffer.alloc(160, 3));
    expect(socket.sentOf('input_audio_buffer.append')).toHaveLength(2);
    expect(appended(socket).subarray(320)).toEqual(Buffer.alloc(160, 3));
  });

  it('keeps only the latest 3 s, so what is appended runs straight on into the live audio', () => {
    const { conversation, socket } = startSession();
    socket.open();
    // 28,000 bytes: 3.5 s of 8 kHz μ-law, in four 7,000-byte pieces.
    for (const fill of [1, 2, 3, 4]) conversation.appendAudio(Buffer.alloc(7_000, fill));

    socket.receive({ type: 'session.updated' });
    const audio = appended(socket);
    expect(audio).toHaveLength(24_000);
    // The oldest half-second is gone, cut mid-piece.
    expect(audio).toEqual(
      Buffer.concat([Buffer.alloc(3_000, 1), Buffer.alloc(7_000, 2), Buffer.alloc(7_000, 3), Buffer.alloc(7_000, 4)]),
    );
  });

  it('appends nothing at ready when the caller sent none, and nothing after the session is closed', () => {
    const { conversation, socket } = startSession();
    socket.open();
    socket.receive({ type: 'session.updated' });
    expect(socket.sentOf('input_audio_buffer.append')).toEqual([]);
    conversation.close();
    conversation.appendAudio(Buffer.alloc(160, 1));
    expect(socket.sentOf('input_audio_buffer.append')).toEqual([]);
  });
});

describe('playback speed', () => {
  const outputOf = (socket: InstanceType<typeof fake.FakeSocket>) => socket.sentOf('session.update')[0]!.session.audio.output;

  it('is sent in the session settings only when one is set', () => {
    const unset = startSession();
    unset.socket.open();
    expect(outputOf(unset.socket)).toEqual({ format: { type: 'audio/pcmu' }, voice: 'marin' });

    const set = startSession({ speed: 1.15 });
    set.socket.open();
    expect(outputOf(set.socket)).toEqual({ format: { type: 'audio/pcmu' }, voice: 'marin', speed: 1.15 });
  });

  it('is kept inside OpenAI\'s range, so a bad setting cannot stop the session from starting', () => {
    const fast = startSession({ speed: 3 });
    fast.socket.open();
    expect(outputOf(fast.socket).speed).toBe(1.5);

    const slow = startSession({ speed: 0.1 });
    slow.socket.open();
    expect(outputOf(slow.socket).speed).toBe(0.25);

    // An env var that is not a number.
    const garbled = startSession({ speed: Number('fast') });
    garbled.socket.open();
    expect(outputOf(garbled.socket)).not.toHaveProperty('speed');
  });
});

describe('reasoning effort', () => {
  const sessionOf = (socket: InstanceType<typeof fake.FakeSocket>) => socket.sentOf('session.update')[0]!.session;

  it('is for gpt-realtime-2 and its versions, and for no other model', () => {
    for (const model of ['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-realtime-2-2026-05-07', 'gpt-realtime-2.1-mini-2026-10-01']) {
      expect(isReasoningModel(model), model).toBe(true);
    }
    for (const model of ['gpt-realtime-mini', 'gpt-realtime', 'gpt-realtime-1.5', 'gpt-realtime-mini-2025-10-06', 'gpt-4o-realtime-preview', '']) {
      expect(isReasoningModel(model), model).toBe(false);
    }
    // A dated snapshot of the first gpt-realtime: it begins "gpt-realtime-2" and does not reason.
    expect(isReasoningModel('gpt-realtime-2025-08-28')).toBe(false);
  });

  it('is sent only when one is set and the model reasons', () => {
    expect(reasoningConfig('gpt-realtime-2.1-mini', 'low')).toEqual({ reasoning: { effort: 'low' } });
    expect(reasoningConfig('gpt-realtime-2.1', 'xhigh')).toEqual({ reasoning: { effort: 'xhigh' } });
    expect(reasoningConfig('gpt-realtime-2.1-mini', undefined)).toBeUndefined();
    expect(reasoningConfig('gpt-realtime-mini', 'low')).toBeUndefined();
    expect(reasoningConfig('gpt-realtime-2025-08-28', 'low')).toBeUndefined();
    // A value that got past the settings: OpenAI would refuse the session over it.
    expect(reasoningConfig('gpt-realtime-2.1-mini', 'maximum' as never)).toBeUndefined();
  });

  it('is read from a setting, with a blank one or anything else as unset', () => {
    expect(readReasoningEffort('low')).toBe('low');
    expect(readReasoningEffort(' XHigh ')).toBe('xhigh');
    for (const value of ['', '   ', 'none', 'maximum', undefined, null, 2]) expect(readReasoningEffort(value)).toBeUndefined();
  });

  it('is named in a script\'s header as it will be sent, or as not sent', () => {
    expect(reasoningLabel('gpt-realtime-2.1-mini', 'low')).toBe('reasoning low');
    expect(reasoningLabel('gpt-realtime-mini', 'low')).toBe('reasoning low not sent (not a reasoning model)');
    expect(reasoningLabel('gpt-realtime-2.1-mini', undefined)).toBe('');
  });

  it('leaves the session settings of the default model exactly as they were', () => {
    const { socket } = startSession();
    socket.open();
    expect(sessionOf(socket)).toEqual({
      type: 'realtime',
      model: 'gpt-realtime-mini',
      instructions: 'You are the receptionist.',
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          noise_reduction: { type: 'near_field' },
          transcription: { model: 'gpt-4o-transcribe', language: 'en' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 900,
            create_response: false,
            interrupt_response: false,
          },
        },
        output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
      },
      tools: JSON.parse(JSON.stringify(REALTIME_TOOLS)),
      tool_choice: 'auto',
    });
  });

  it('goes out in the session settings of a reasoning model', () => {
    const { socket } = startSession({ model: 'gpt-realtime-2.1-mini', reasoningEffort: 'low' });
    socket.open();
    expect(sessionOf(socket)).toMatchObject({ model: 'gpt-realtime-2.1-mini', reasoning: { effort: 'low' } });

    // No effort set: the model's own default is left alone.
    const unset = startSession({ model: 'gpt-realtime-2.1-mini' });
    unset.socket.open();
    expect(sessionOf(unset.socket)).not.toHaveProperty('reasoning');
  });

  it('is kept from a model that does not reason, with one warning, so the session still starts', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { socket } = startSession({ reasoningEffort: 'medium', label: 'CA123' });
    socket.open();
    expect(sessionOf(socket)).not.toHaveProperty('reasoning');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/for call CA123: reasoning effort medium was not sent: gpt-realtime-mini is not a reasoning model/));

    // Nothing to say when it is sent, or when none is set.
    warn.mockClear();
    startSession({ model: 'gpt-realtime-2.1', reasoningEffort: 'medium' }).socket.open();
    startSession().socket.open();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('models OpenAI is shutting down', () => {
  it('are the realtime models on 20 Jan 2027 and the transcribers on 26 Feb 2027, with what replaces each', () => {
    expect(modelShutdown('gpt-realtime-mini')).toEqual({
      model: 'gpt-realtime-mini',
      shutdown: '20 Jan 2027',
      replacements: ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1'],
    });
    expect(modelShutdown('gpt-realtime')).toMatchObject({ shutdown: '20 Jan 2027', replacements: ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini'] });
    for (const model of ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']) {
      expect(modelShutdown(model), model).toMatchObject({ shutdown: '26 Feb 2027', replacements: ['gpt-transcribe'] });
    }
  });

  it('include a dated snapshot of each', () => {
    expect(modelShutdown('gpt-realtime-2025-08-28')?.model).toBe('gpt-realtime');
    expect(modelShutdown('gpt-realtime-mini-2025-10-06')?.model).toBe('gpt-realtime-mini');
    expect(modelShutdown(' GPT-4o-mini-transcribe-2025-12-15 ')?.model).toBe('gpt-4o-mini-transcribe');
  });

  it('do not include the current models, nor any replacement named for one', () => {
    for (const model of ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1', 'gpt-realtime-2', 'gpt-realtime-1.5', 'gpt-realtime-2-2026-05-07', 'gpt-transcribe', 'gpt-live-transcribe', '']) {
      expect(modelShutdown(model), model).toBeUndefined();
    }
    for (const replacement of MODEL_SHUTDOWNS.flatMap((entry) => entry.replacements)) {
      expect(modelShutdown(replacement), replacement).toBeUndefined();
    }
  });

  it('are warned of at start-up with the setting, the day and what to set instead', () => {
    expect(shutdownWarning('AI_REALTIME_MODEL', 'gpt-realtime-mini')).toBe(
      'AI_REALTIME_MODEL=gpt-realtime-mini: OpenAI shuts this model down on 20 Jan 2027. ' +
        'Set AI_REALTIME_MODEL=gpt-realtime-2.1-mini (or gpt-realtime-2.1) before then, ' +
        'and try it with npm run realtime:check before taking calls on it.',
    );
    expect(shutdownWarning('AI_REALTIME_TRANSCRIPTION_MODEL', 'gpt-4o-transcribe')).toContain(
      'shuts this model down on 26 Feb 2027. Set AI_REALTIME_TRANSCRIPTION_MODEL=gpt-transcribe before then',
    );
    expect(shutdownWarning('AI_REALTIME_MODEL', 'gpt-realtime-2.1-mini')).toBeUndefined();
  });
});
