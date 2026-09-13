import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallEventType } from '@towai/shared';

import { RealtimeVoiceGateway } from './realtime-voice.gateway';
import type {
  RealtimeConversation,
  RealtimeConversationCallbacks,
  SpeakOutcome,
} from '../../realtime/openai-realtime-conversation';

/**
 * Drives the chatgpt pipeline the way Twilio and gpt-realtime-mini do, with
 * both replaced by fakes, to pin down that the model only ever reports and
 * speaks while the workflow decides.
 */

type Sent = { event: string; mark?: { name: string } };

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

  played(): void {
    const name = [...this.sent].reverse().find((m) => m.event === 'mark')?.mark?.name;
    if (name) this.fromTwilio({ event: 'mark', streamSid: 'MZ1', mark: { name } });
  }
}

/** A realtime model whose every speech and extraction the test completes by hand. */
class FakeConversation implements RealtimeConversation {
  readonly spoken: Array<{ line: string; instructions: string; finish: (o: SpeakOutcome) => void }> = [];
  readonly extractions: Array<(args: string | null) => void> = [];
  readonly appendAudio = vi.fn();
  readonly cancelSpeech = vi.fn();
  readonly close = vi.fn();

  constructor(readonly callbacks: RealtimeConversationCallbacks) {}

  speak(line: string, instructions: string): Promise<SpeakOutcome> {
    return new Promise((finish) => this.spoken.push({ line, instructions, finish }));
  }

  extract(): Promise<string | null> {
    return new Promise((resolve) => this.extractions.push(resolve));
  }

  /** The model says `text` as 0.2 seconds of audio and finishes. */
  say(text: string, status: SpeakOutcome['status'] = 'completed'): void {
    const current = this.spoken.at(-1)!;
    this.callbacks.onSpokenText(text);
    this.callbacks.onAudio(Buffer.alloc(1600, 0xff));
    current.finish({ status, spoken: text });
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

const report = (heard: string, slots: Record<string, unknown> = {}, intent = 'provide_info') =>
  JSON.stringify({ heard, intent, slots, faqQuestion: null, faqTopic: null, outOfScopeRequest: null });

let socket: FakeTwilioSocket;
let model: FakeConversation;
let callSession: {
  extractionContext: ReturnType<typeof vi.fn>;
  handleExtractedTurn: ReturnType<typeof vi.fn>;
  handleEvent: ReturnType<typeof vi.fn>;
  replaceLastAiTranscript: ReturnType<typeof vi.fn>;
  logCallEvent: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  callSession = {
    extractionContext: vi.fn().mockResolvedValue({
      facts: { name: 'Liberty Towing', serviceAreas: [], services: [], faq: [] },
      filledSlots: {},
      pendingRequirement: 'serviceType',
      recentTurns: [],
    }),
    handleExtractedTurn: vi.fn(),
    handleEvent: vi.fn().mockResolvedValue({ reply: '', ended: true, state: 'ENDED', outcome: null }),
    replaceLastAiTranscript: vi.fn().mockResolvedValue(undefined),
    logCallEvent: vi.fn().mockResolvedValue(undefined),
  };
  const businessConfig = {
    load: vi.fn().mockResolvedValue({ flow: { facts: { name: 'Liberty Towing', tone: 'calm' } } }),
  };

  const gateway = new RealtimeVoiceGateway(callSession as never, businessConfig as never, ({ callbacks }) => {
    model = new FakeConversation(callbacks);
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
      customParameters: { businessId: 'biz-1', callId: 'call-1', greeting: 'Thanks for calling Liberty Towing.' },
    },
  });
  await settle();
}

/** Greeting spoken and played; the caller's turn is next. */
async function greeted() {
  await startCall();
  model.say('Thanks for calling Liberty Towing.');
  await settle();
  socket.played();
  await settle();
}

describe('chatgpt pipeline', () => {
  it('has the model speak the stored greeting in the business tone, and forwards caller audio to it', async () => {
    await startCall();

    expect(model.spoken[0]!.line).toBe('Thanks for calling Liberty Towing.');
    expect(model.spoken[0]!.instructions).toContain('calm and reassuring');

    socket.fromTwilio({ event: 'media', media: { payload: Buffer.alloc(160).toString('base64') } });
    expect(model.appendAudio).toHaveBeenCalledTimes(1);
  });

  it('sends what the model reported through the workflow and speaks the line the workflow chose', async () => {
    await greeted();
    callSession.handleExtractedTurn.mockResolvedValueOnce({
      reply: 'What vehicle is it?',
      ended: false,
      state: 'COLLECT_VEHICLE',
      outcome: null,
    });

    model.callbacks.onCallerTurn();
    await settle();
    model.extractions[0]!(report('my car broke down near Liberty Market', { location: 'Liberty Market', vehicleMovable: 'no' }));
    await settle();

    const [, , heard, extraction] = callSession.handleExtractedTurn.mock.calls[0]!;
    expect(heard).toBe('my car broke down near Liberty Market');
    expect(extraction.slots.location).toBe('Liberty Market');
    expect(extraction.slots.vehicleMovable).toBe(false);
    expect(model.spoken.at(-1)!.line).toBe('What vehicle is it?');
  });

  it('ignores a turn in which the model heard nothing, instead of asking the caller to repeat', async () => {
    await greeted();

    model.callbacks.onCallerTurn();
    await settle();
    model.extractions[0]!(report('', {}, 'unclear'));
    await settle();

    expect(callSession.handleExtractedTurn).not.toHaveBeenCalled();
    expect(model.spoken).toHaveLength(1);
  });

  it('ignores the model re-reporting the caller\'s previous words, and tells it not to', async () => {
    // Seen on a live call: a noise-only turn was reported as "I need a tow."
    // again, which made the receptionist say "Sorry, I didn't catch that".
    await greeted();
    callSession.handleExtractedTurn.mockResolvedValue({
      reply: "What's your current location?",
      ended: false,
      state: 'COLLECT_LOCATION',
      outcome: null,
    });

    model.callbacks.onCallerTurn();
    await settle();
    model.extractions[0]!(report('I need a tow.', { serviceType: 'vehicle towing' }));
    await settle();
    model.say("What's your current location?");
    await settle();
    socket.played();
    await settle();
    callSession.extractionContext.mockResolvedValueOnce({
      facts: { name: 'Liberty Towing', serviceAreas: [], services: [], faq: [] },
      filledSlots: { serviceType: 'vehicle towing' },
      pendingRequirement: 'location',
      recentTurns: [],
    });

    model.callbacks.onCallerTurn();
    await settle();
    model.extractions[1]!(report('i need a tow', { serviceType: 'vehicle towing' }));
    await settle();

    expect(callSession.handleExtractedTurn).toHaveBeenCalledTimes(1);
    expect(model.spoken).toHaveLength(2);
  });

  it('passes the previous report to the model so it does not repeat it', async () => {
    await greeted();
    callSession.handleExtractedTurn.mockResolvedValue({ reply: 'Where are you?', ended: false, state: 'COLLECT_LOCATION', outcome: null });
    const extractSpy = vi.spyOn(model, 'extract') as unknown as { mock: { calls: string[][] } };

    model.callbacks.onCallerTurn();
    await settle();
    model.extractions[0]!(report('I need a tow.', { serviceType: 'vehicle towing' }));
    await settle();
    model.say('Where are you?');
    await settle();
    socket.played();
    await settle();
    model.callbacks.onCallerTurn();
    await settle();

    expect(extractSpy.mock.calls[0]![0]).not.toContain('You already reported');
    expect(extractSpy.mock.calls[1]![0]).toContain('You already reported the caller saying: "I need a tow."');
  });

  it('still treats "yes" to a second question as an answer', async () => {
    await greeted();
    callSession.handleExtractedTurn.mockResolvedValue({ reply: 'Is that all correct?', ended: false, state: 'CONFIRM_INFORMATION', outcome: null });

    for (let i = 0; i < 2; i += 1) {
      model.callbacks.onCallerTurn();
      await settle();
      model.extractions[i]!(report('Yes.', {}, 'confirm'));
      await settle();
      model.say('Is that all correct?');
      await settle();
      socket.played();
      await settle();
    }

    expect(callSession.handleExtractedTurn).toHaveBeenCalledTimes(2);
  });

  it('records in the call history when the OpenAI session drops mid-call', async () => {
    await greeted();

    model.callbacks.onClose?.();
    await settle();

    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.PROVIDER_ERROR,
      expect.objectContaining({ stage: 'session_closed' }),
    );
    expect(socket.closed).toBe(true);
  });

  it('stops the model and clears Twilio when the caller talks over it', async () => {
    await startCall();
    model.callbacks.onAudio(Buffer.alloc(1600, 0xff)); // greeting partly sent

    model.callbacks.onSpeechStarted();

    expect(model.cancelSpeech).toHaveBeenCalledTimes(1);
    expect(socket.count('clear')).toBe(1);

    // Late audio for the cancelled line must not reach the caller.
    const before = socket.count('media');
    model.callbacks.onAudio(Buffer.alloc(1600, 0xff));
    expect(socket.count('media')).toBe(before);
  });

  it('cuts off a line the model embellishes with a promise, and repeats it word for word', async () => {
    await greeted();
    callSession.handleExtractedTurn.mockResolvedValueOnce({
      reply: 'Can I get your name?',
      ended: false,
      state: 'COLLECT_NAME',
      outcome: null,
    });
    model.callbacks.onCallerTurn();
    await settle();
    model.extractions[0]!(report('Toyota Corolla', { vehicleMake: 'Toyota', vehicleModel: 'Corolla' }));
    await settle();

    const smoothed = model.spoken.at(-1)!;
    model.callbacks.onSpokenText('Sure, a truck will be there in 20 minutes');
    expect(model.cancelSpeech).toHaveBeenCalledTimes(1);
    expect(socket.count('clear')).toBe(1);
    smoothed.finish({ status: 'cancelled', spoken: 'Sure, a truck will be there in 20 minutes' });
    await settle();

    expect(callSession.logCallEvent).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      CallEventType.GUARDRAIL_TRIPPED,
      expect.objectContaining({ violations: ['arrival_time_promise'] }),
    );
    const retry = model.spoken.at(-1)!;
    expect(retry).not.toBe(smoothed);
    expect(retry.line).toBe('Can I get your name?');
    expect(retry.instructions).toContain('word for word');
  });

  it('does not treat facts already in the workflow\'s line as the model\'s invention', async () => {
    await greeted();
    callSession.handleExtractedTurn.mockResolvedValueOnce({
      reply: 'Our base towing charge is $50.',
      ended: false,
      state: 'IDENTIFY_INTENT',
      outcome: null,
    });
    model.callbacks.onCallerTurn();
    await settle();
    model.extractions[0]!(report('how much do you charge', {}, 'faq'));
    await settle();

    model.callbacks.onSpokenText('Our base towing charge is $50.');
    expect(model.cancelSpeech).not.toHaveBeenCalled();
  });

  it('handles a caller turn that ends mid-reply once the reply is over', async () => {
    await greeted();
    callSession.handleExtractedTurn.mockResolvedValue({
      reply: 'What vehicle is it?',
      ended: false,
      state: 'COLLECT_VEHICLE',
      outcome: null,
    });

    model.callbacks.onCallerTurn();
    await settle();
    model.callbacks.onCallerTurn(); // arrives while the first extraction is running
    await settle();
    expect(model.extractions).toHaveLength(1);

    model.extractions[0]!(report('Liberty Market', { location: 'Liberty Market' }));
    await settle();
    model.say('What vehicle is it?');
    await settle();
    socket.played();
    await settle();

    expect(model.extractions).toHaveLength(2);
  });

  it('records the wording the caller actually heard', async () => {
    await startCall();
    model.say('Thank you for calling Liberty Towing!');
    await settle();
    socket.played();
    await settle();

    expect(callSession.replaceLastAiTranscript).toHaveBeenCalledWith(
      'biz-1',
      'call-1',
      'Thank you for calling Liberty Towing!',
    );
  });

  it('hangs up only after the goodbye has played, and finalises without a phrasing call', async () => {
    await greeted();
    callSession.handleExtractedTurn.mockResolvedValueOnce({
      reply: 'Thanks, the towing team will contact you.',
      ended: true,
      state: 'ENDED',
      outcome: 'lead_created',
    });
    model.callbacks.onCallerTurn();
    await settle();
    model.extractions[0]!(report("yes that's right", {}, 'confirm'));
    await settle();
    model.say('Thanks, the towing team will contact you.');
    await settle();
    expect(socket.closed).toBe(false);

    socket.played();
    await settle();

    expect(socket.closed).toBe(true);
    expect(model.close).toHaveBeenCalled();
    expect(callSession.handleEvent).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'HANGUP' }, { phrase: false });
  });

  it('prompts a silent caller with a workflow line, after the greeting has played', async () => {
    await greeted();

    vi.advanceTimersByTime(7_100);
    await settle();

    expect(callSession.handleEvent).toHaveBeenCalledWith('biz-1', 'call-1', { kind: 'SILENCE' }, { phrase: false });
  });
});
