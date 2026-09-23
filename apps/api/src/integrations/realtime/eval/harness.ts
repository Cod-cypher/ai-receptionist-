/**
 * Runs one scripted call through the production realtime gateway.
 *
 * Only the edges are simulated: Twilio is a socket that plays audio back at
 * (sped-up) real time and echoes playback marks, and the database is an
 * in-memory store running the real intake rules. The gateway, prompt, tools
 * and gpt-realtime session are the ones a real call uses — so the benchmark
 * measures what ships, not a re-implementation of it.
 */

import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import type { BusinessFacts } from '@towai/shared';

import { applyIntake, type IntakeOperation } from '../../../conversation/intake';
import { DEFAULT_FLOW_LIMITS, initialContext, type ConversationContext, type FlowConfig } from '../../../conversation/types';
import { RealtimeVoiceGateway } from '../../telephony/twilio/realtime-voice.gateway';
import {
  OpenAiRealtimeConversation,
  type NoiseReduction,
  type RealtimeConversationCallbacks,
  type RealtimeConversationFactory,
  type TurnDetectionMode,
  type TurnEagerness,
} from '../openai-realtime-conversation';
import { addResponseUsage, addTranscriptionUsage, emptyUsage, type UsageTotals } from '../usage';

export const EVAL_FACTS: BusinessFacts = {
  name: 'Liberty Towing',
  phone: null,
  website: null,
  address: null,
  serviceAreas: ['Dallas', 'Fort Worth', 'Arlington'],
  services: ['Local towing', 'Heavy-duty towing', 'Jump starts', 'Lockouts'],
  businessHoursText: 'Open 24 hours, 7 days a week',
  isOpenNow: true,
  pricingInfo: null,
  emergencyContact: null,
  faq: [],
  tone: 'friendly',
  businessInstructions: null,
};
export const EVAL_CONFIG: FlowConfig = { facts: EVAL_FACTS, greeting: null, fallbackBehavior: 'callback', ...DEFAULT_FLOW_LIMITS };
export const EVAL_CALLER = '+18174098408';
export const EVAL_GREETING = 'Thanks for calling Liberty Towing. How can I help?';

type IntakeMeta = Parameters<typeof applyIntake>[3];

export interface OpRecord {
  turn: number;
  op: IntakeOperation;
  output: Record<string, unknown>;
}

export interface TurnRecord {
  caller: string;
  /** What the receptionist generated in reply, in order. */
  replies: string[];
  /** Backend state once the receptionist had finished replying. */
  stateAfter: ConversationContext;
}

export interface RunRecord {
  turns: TurnRecord[];
  ops: OpRecord[];
  events: Array<{ type: string; payload?: unknown; turn: number }>;
  finalContext: ConversationContext;
  /** The caller turn during which the lead was created, or null. */
  leadCreatedAtTurn: number | null;
  usage: UsageTotals;
  errors: string[];
  /** OpenAI's rate limit cut the session short: a fact about the account, not the receptionist. */
  rateLimited: boolean;
  durationMs: number;
  /** Caller turn end (audio committed) to the first audio of the reply, per turn. */
  replyLatencyMs: number[];
}

/** CallSessionService for one call, in memory, running the real intake rules. */
class InMemoryCallSession {
  context: ConversationContext = initialContext({ customerPhone: EVAL_CALLER });
  readonly ops: OpRecord[] = [];
  readonly events: RunRecord['events'] = [];
  ended = false;
  leadCreatedAtTurn: number | null = null;

  constructor(private readonly turn: () => number) {}

  private apply(op: IntakeOperation, meta?: IntakeMeta) {
    const result = applyIntake(this.context, op, EVAL_CONFIG, {
      defaultRegionPrefix: '+1',
      emergencyNumber: '911',
      knownAreas: EVAL_FACTS.serviceAreas,
      ...meta,
    });
    this.context = result.context;
    for (const effect of result.effects) {
      if (effect.type === 'LOG_EVENT') this.events.push({ type: effect.event, payload: effect.payload, turn: this.turn() });
      if (effect.type === 'CREATE_LEAD' && this.leadCreatedAtTurn === null) this.leadCreatedAtTurn = this.turn();
    }
    if (result.ended) this.ended = true;
    return result;
  }

  async applyIntakeOperation(_businessId: string, _callId: string, op: IntakeOperation, meta?: IntakeMeta) {
    if (this.ended) return { output: { callEnded: true }, ended: true, outcome: null, plan: null };
    const result = this.apply(op, meta);
    this.ops.push({ turn: this.turn(), op, output: result.output });
    return { output: result.output, ended: result.ended, outcome: null, plan: result.plan };
  }

  async appendAiTranscriptLine(): Promise<void> {}

  async logCallEvent(_b: string, _c: string, type: string, payload?: unknown): Promise<void> {
    this.events.push({ type, payload, turn: this.turn() });
  }

  async handleEvent() {
    if (!this.ended) this.apply({ kind: 'end' });
    return { callId: 'eval', reply: '', ended: true, state: 'ENDED', outcome: null };
  }
}

/** Twilio's side of the media stream: plays audio at `speed`× real time. */
class PlaybackSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  closed = false;
  private playhead = 0;
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(private readonly speed: number) {
    super();
  }

  get playing(): boolean {
    return this.pending.size > 0;
  }

  send(data: string): void {
    const message = JSON.parse(data) as { event: string; media?: { payload: string }; mark?: { name: string } };
    if (message.event === 'media' && message.media) {
      const bytes = Buffer.from(message.media.payload, 'base64').length;
      this.playhead = Math.max(this.playhead, Date.now()) + bytes / 8 / this.speed;
    } else if (message.event === 'mark' && message.mark) {
      const name = message.mark.name;
      const delay = Math.max(0, this.playhead - Date.now());
      this.pending.set(
        name,
        setTimeout(() => {
          this.pending.delete(name);
          this.fromTwilio({ event: 'mark', mark: { name } });
        }, delay),
      );
    } else if (message.event === 'clear') {
      this.playhead = Date.now();
      const cleared = [...this.pending.entries()];
      this.pending.clear();
      for (const [name, timer] of cleared) {
        clearTimeout(timer);
        this.fromTwilio({ event: 'mark', mark: { name } });
      }
    }
  }

  fromTwilio(message: unknown): void {
    if (!this.closed) this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.emit('close');
  }
}

export interface HarnessOptions {
  apiKey: string;
  model: string;
  voice: string;
  silenceMs: number;
  turnDetection: TurnDetectionMode;
  eagerness: TurnEagerness;
  noiseReduction: NoiseReduction;
  transcriptionModel: string;
  /** Playback and caller-audio speed; 1 is real time. */
  speed: number;
  callerAudio: (line: string) => Promise<Buffer>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(condition: () => boolean, limitMs: number): Promise<boolean> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > limitMs) return false;
    await sleep(50);
  }
  return true;
}

const SILENCE = Buffer.alloc(160, 0xff);

export async function runCall(options: HarnessOptions, callerLines: string[]): Promise<RunRecord> {
  const started = Date.now();
  let turn = 0;
  const session = new InMemoryCallSession(() => turn);
  const usage = emptyUsage();
  const errors: string[] = [];
  const itemTurn = new Map<string, number>();
  const itemText = new Map<string, string>();
  let active = 0;
  let responsesDone = 0;
  let callerCommits = 0;
  let lastEvent = Date.now();
  let turnEndedAt: number | null = null;
  const replyLatencyMs: number[] = [];
  const touch = () => (lastEvent = Date.now());

  const tap = (cb: RealtimeConversationCallbacks): RealtimeConversationCallbacks => ({
    ...cb,
    onSpeechStarted: () => (touch(), cb.onSpeechStarted()),
    onCallerTurn: (id) => (touch(), (callerCommits += 1), (turnEndedAt = Date.now()), cb.onCallerTurn(id)),
    onCallerTranscript: (id, text) => (touch(), cb.onCallerTranscript(id, text)),
    onResponseStarted: (id, requested) => (touch(), (active += 1), cb.onResponseStarted(id, requested)),
    onAudio: (id, chunk) => {
      touch();
      if (turnEndedAt !== null) {
        replyLatencyMs.push(Date.now() - turnEndedAt);
        turnEndedAt = null;
      }
      cb.onAudio(id, chunk);
    },
    onSpokenText: (id, text) => {
      touch();
      if (!itemTurn.has(id)) itemTurn.set(id, turn);
      itemText.set(id, text);
      cb.onSpokenText(id, text);
    },
    onResponseDone: (response) => {
      touch();
      active = Math.max(0, active - 1);
      responsesDone += 1;
      cb.onResponseDone(response);
    },
    onUsage: (u) => {
      if (u.kind === 'response') addResponseUsage(usage, u.usage);
      else addTranscriptionUsage(usage, u.usage);
      cb.onUsage?.(u);
    },
    onError: (error) => (errors.push(error.message), cb.onError(error)),
  });

  const businessConfig = { load: async () => ({ flow: EVAL_CONFIG, defaultRegionPrefix: '+1' }) };
  const factory = ({ instructions, callbacks, label, transcriptionPrompt }: Parameters<RealtimeConversationFactory>[0]) =>
    new OpenAiRealtimeConversation({
      apiKey: options.apiKey,
      model: options.model,
      voice: options.voice,
      silenceMs: options.silenceMs,
      turnDetection: options.turnDetection,
      eagerness: options.eagerness,
      noiseReduction: options.noiseReduction,
      transcriptionModel: options.transcriptionModel,
      transcriptionPrompt,
      instructions,
      callbacks: tap(callbacks),
      label,
    });

  const gateway = new RealtimeVoiceGateway(session as never, businessConfig as never, factory as never);
  const socket = new PlaybackSocket(options.speed);
  gateway.handleConnection(socket as never);

  /** Nothing generating, nothing still playing, and a moment of quiet. */
  const quiet = () => waitFor(() => active === 0 && !socket.playing && Date.now() - lastEvent > 1_200, 30_000);
  /** Streams audio as Twilio would, `speed` frames per 20ms tick. */
  const stream = async (audio: Buffer) => {
    const perTick = Math.max(1, Math.round(options.speed));
    for (let offset = 0; offset < audio.length; ) {
      for (let i = 0; i < perTick && offset < audio.length; i += 1, offset += 160) {
        socket.fromTwilio({ event: 'media', media: { payload: audio.subarray(offset, offset + 160).toString('base64') } });
      }
      await sleep(20);
    }
  };

  const turns: TurnRecord[] = [];
  try {
    socket.fromTwilio({
      event: 'start',
      streamSid: 'MZeval',
      start: {
        callSid: 'CAeval',
        customParameters: { businessId: 'eval', callId: 'eval', greeting: EVAL_GREETING, callerNumber: EVAL_CALLER },
      },
    });
    await waitFor(() => responsesDone >= 1, 20_000);
    await quiet();

    for (const [index, line] of callerLines.entries()) {
      if (socket.closed) break;
      turn = index + 1;
      const audio = await options.callerAudio(line);
      const commitsBefore = callerCommits;
      const doneBefore = responsesDone;

      await stream(audio);
      const stoppedAt = Date.now();
      while (callerCommits === commitsBefore && Date.now() - stoppedAt < 5_000 && !socket.closed) {
        await stream(Buffer.concat(Array.from({ length: 5 }, () => SILENCE)));
      }
      await waitFor(() => responsesDone > doneBefore || socket.closed, 20_000);
      await quiet();

      turns.push({
        caller: line,
        replies: [...itemTurn.entries()]
          .filter(([, t]) => t === turn)
          .map(([id]) => itemText.get(id) ?? '')
          .filter(Boolean),
        stateAfter: structuredClone(session.context),
      });
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const finalContext = structuredClone(session.context);
  socket.close();
  await sleep(100);

  return {
    turns,
    ops: session.ops,
    events: session.events,
    finalContext,
    leadCreatedAtTurn: session.leadCreatedAtTurn,
    usage,
    errors,
    rateLimited: errors.some((e) => /rate.?limit/i.test(e)),
    durationMs: Date.now() - started,
    replyLatencyMs,
  };
}
