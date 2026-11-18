/**
 * Twilio Media Streams with gpt-realtime as the receptionist — VOICE_PIPELINE=chatgpt.
 *
 * One continuous realtime session per call holds the conversation: it hears
 * the caller, answers what they mean, and calls backend tools. The backend is
 * the authority on everything that must be true, including what to do next:
 *
 *   caller ⇄ Twilio ⇄ this gateway ⇄ gpt-realtime
 *                          │ state note before every reply; tool calls
 *                          ▼
 *                 CallSessionService → validation, priority engine, lead,
 *                                      callback, notifications (unchanged)
 *
 * The model never starts a reply on its own. When the caller finishes a turn,
 * the gateway asks the backend for the state and the one required action,
 * pins that to the conversation as a short note, and only then requests the
 * reply. That is what stops gpt-realtime-mini choosing its own priorities.
 *
 * The caller's words are transcribed 400 to 560 ms after their turn ends, so
 * the first reply to a turn waits for them, up to AI_REALTIME_WORDS_WAIT_MS
 * (500 ms) from the end of the turn, and the note it is asked for with
 * quotes them. Words that come after the wait still count: when they need a
 * reply (a question, a complaint, a check of the line) and the caller has
 * heard nothing yet, the note is pinned again quoting them and the reply
 * asked for again. The tool results' note always quotes them. The model is
 * told what the caller said, instead of being left to work it out from
 * conditional rules.
 *
 * This gateway also owns what only it can see:
 *
 *  - Playback. Twilio `mark`s report how much of each reply the caller has
 *    heard. On barge-in, Twilio's buffer is cleared and the model's memory of
 *    the reply is truncated to what was played.
 *  - Whether caller speech is an interruption. A short sound ("uh-huh", a
 *    cough, a burst of road noise) is talked straight through, as a person
 *    would: the reply keeps playing. If the sound goes on, playback pauses,
 *    and the reply is only abandoned if the caller keeps talking. After a
 *    word or two of acknowledgement ("okay", "yes, yes") the receptionist
 *    carries on where it left off, instead of starting the sentence again —
 *    which callers hear as "it repeats itself".
 *  - Live checks on the model's words: guardrails (prices, arrival times,
 *    dispatch, availability) and the required action (no asking for the phone
 *    number while the location is still vague). A failing reply is stopped
 *    before the caller hears it and the model is redirected, once per turn.
 *  - The caller turn counter, from the audio. Confirmations are checked
 *    against it, so the model cannot confirm on the caller's behalf.
 *  - Silence (counted by the backend), transcript order, token usage, and
 *    how long each reply took to reach the caller.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { CallEventType } from '@towai/shared';

import { CallSessionService, type IntakeOperationResult } from '../../../call-session/call-session.service';
import { checkReply } from '../../../conversation/guardrails';
import type { IntakeSnapshot } from '../../../conversation/intake';
import { ASKED_AS_ONE, type NextActionPlan, type Topic } from '../../../conversation/next-action';
import { checkReplyAgainstAction, questionsIn } from '../../../conversation/response-check';
import { BusinessConfigService } from '../../../modules/businesses/business-config.service';
import { SpeechGauge, VoiceLevel } from '../../audio/speech-gauge';
import { CALL_JUDGE, type CallJudge } from '../../judgment/judgment.interface';
import { OVERLAP_ACKNOWLEDGEMENT_CEILING, OVERLAP_ANSWER_FLOOR } from '../../judgment/typesafe-questions';
import { NEEDS_REPLY, classifyCallerWords, inLatinScript, type CallerWordsKind } from '../../realtime/caller-words';
import { RealtimeFillerBank, type Filler, type FillerKind, type FillerPicker } from '../../realtime/filler-bank';
import { LiveWords, REALTIME_LIVE_WORDS } from '../../realtime/live-words';
import { GreetingBank } from '../../realtime/greeting-bank';
import {
  REALTIME_CONVERSATION_FACTORY,
  alreadySaidNote,
  type RealtimeConversation,
  type RealtimeConversationFactory,
  type RealtimeResponseSummary,
  type ResponseRequest,
} from '../../realtime/openai-realtime-conversation';
import {
  ENDING_NOTE,
  SAFE_FALLBACK_LINE,
  SELF_TALK_RECOVERY_INSTRUCTIONS,
  SILENCE_CHECK_LINE,
  SILENCE_GOODBYE_INSTRUCTIONS,
  TURN_LIMIT_GOODBYE_INSTRUCTIONS,
  UNCONFIRMED_GOODBYE_INSTRUCTIONS,
  type ActionNoteOptions,
  type CallerJustSaid,
  buildActionNote,
  replyInstructions,
  buildReceptionistInstructions,
  confirmedGoodbyeLine,
  exactLineInstructions,
  greetingInstructions,
  guardrailRecoveryInstructions,
  isAskingForTime,
  isBackchannel,
  isHesitation,
  isPresenceCheck,
  redirectNote,
  remarkInstructions,
  renderReadBack,
} from '../../realtime/realtime-instructions';
import { TOOL, createToolExecutor, type ToolExecutor } from '../../realtime/realtime-tools';
import { addResponseUsage, addTranscriptionUsage, emptyUsage, type UsageTotals } from '../../realtime/usage';
import type { SttProvider } from '../../stt/stt-provider.interface';
import type { MediaSocket } from './media-stream.gateway';
import { StreamGate } from './stream-gate';

export const REALTIME_STREAM_PATH = '/api/telephony/twilio/realtime';

/** Twilio's frames are a few hundred bytes; anything approaching this is not Twilio. */
export const STREAM_MAX_PAYLOAD_BYTES = 64 * 1024;
/** A socket that has not said which call it carries by then is not Twilio's either. */
export const STREAM_START_TIMEOUT_MS = 10_000;

/** Twilio sends 20ms of μ-law per frame: 8000 samples/s × 0.02s = 160 bytes. */
const FRAME_BYTES = 160;
/** μ-law at 8 kHz: 8 bytes per millisecond. */
const BYTES_PER_MS = 8;
/** A playback mark at least this often (100 ms), so "heard" is known finely. */
const MARK_EVERY_BYTES = 800;
/** Silence after the receptionist finishes speaking before it checks in. */
const NO_INPUT_MS = 7_000;
/** The same, once the caller has asked for a moment: "hold on, let me find the exit". */
export const PATIENT_NO_INPUT_MS = 25_000;
/** How long a caller line may wait for its transcription before it is skipped. */
const TRANSCRIPT_WAIT_MS = 8_000;
/** Longest wait for the goodbye to be spoken and played once the call has ended. */
const GOODBYE_LIMIT_MS = 20_000;
/**
 * Voiced caller audio, after speech onset, that makes an interruption real.
 * "Yes, yes" is about 600 ms; a caller taking the floor keeps going past it.
 */
export const BARGE_IN_VOICED_MS = 650;
/**
 * Voiced caller audio, after speech onset, before playback is paused at all.
 * A person talks straight through a shorter sound: on a real call (5176f4be)
 * 200 ms of it put a 605 ms hole in the middle of the safety line. The pause
 * comes here, and not only at an interruption, because on a speakerphone the
 * receptionist's own voice can come back as caller speech: pausing stops the
 * echo, and the reply then carries on. Played through all the way to
 * BARGE_IN_VOICED_MS, the receptionist would cut itself off.
 */
export const PLAY_THROUGH_VOICED_MS = 300;
/** Quiet after a shorter burst that lets the receptionist carry on. */
export const HOLD_RESUME_SILENCE_MS = 300;
/** Longest the receptionist stays paused while the caller's speech is being judged. */
const HOLD_MAX_MS = 1_200;
/**
 * OpenAI's measure of caller speech, past which a reply that carried on is
 * recorded as having talked over them. It counts the padding before speech
 * and the silence after it, near 800 ms together: a "yes" measures about 1 s.
 */
const TALKED_OVER_MS = 1_500;
/** Silence after the caller's turn before a filler line ("Mm-hm.") covers the wait for the reply. */
const FILLER_AFTER_MS = 1_100;
/**
 * The least time a reply asked of the model is given to start before a
 * filler covers the wait. On a live run (8 calls, 18 Nov) a reply's first
 * audio came a median 657 ms after it was asked for (p90 1,105 ms), and it
 * was asked for about 430 ms after the turn ended: right at FILLER_AFTER_MS.
 * A filler played on 16 of 19 turns, each just ahead of the reply, which
 * then waited for the clip to finish: about 0.6 s added to the turns the
 * filler was meant to shorten.
 */
export const FILLER_AFTER_REQUEST_MS = 1_200;
/**
 * The longest a turn can take to be ended after the caller's last sound and
 * still be measured. Past this the last sound heard was not the end of this
 * turn's speech (a caller too quiet for the gauge), and the figure would be
 * wrong rather than large.
 */
const ENDPOINT_MAX_MS = 10_000;
/**
 * The longest the first reply to a turn waits for the caller's words, counted
 * from the end of the turn. On the real call of 12 October (6d1304af) they
 * were transcribed 400 to 560 ms after the reply was asked for, on every
 * turn, so every reply was planned without them. AI_REALTIME_WORDS_WAIT_MS;
 * 0 asks at once, as before.
 */
// 500, not 300: the words arrive 400 to 560 ms after the turn ends. At 300
// (real call 07fd8ed3) the wait gave up just before they landed on every
// turn, so each reply paid for the wait and for being asked for twice.
export const WORDS_WAIT_MS = 500;
/** Far longer than any transcript has taken, and well inside the stall limit. */
const WORDS_WAIT_MAX_MS = 2_000;
/** While the caller talks over a reply held for their words, how often to look whether they have stopped. */
const WORDS_WAIT_RECHECK_MS = 200;
/** The words wait, when a module provides it; without one, AI_REALTIME_WORDS_WAIT_MS is read. */
export const REALTIME_WORDS_WAIT_MS = Symbol('REALTIME_WORDS_WAIT_MS');

/** A words wait from a setting: unset or unreadable is the default; never negative, never past the cap. */
export function readWordsWait(value: unknown): number {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return WORDS_WAIT_MS;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(Math.round(ms), WORDS_WAIT_MAX_MS) : WORDS_WAIT_MS;
}
/** Once the caller has heard the rest, how long a brief overlap waits for its words before it is answered anyway. */
const OVERLAP_TRANSCRIPT_WAIT_MS = 1_500;
/** A caller line this long that matches the receptionist's own words is echo, or a transcriber's invention. */
const ECHO_MIN_WORDS = 4;
/**
 * A reply asked of the model that has not started after this long has
 * stalled. On a real call OpenAI took 16 s to start one; the caller waited in
 * silence, was counted as silent themselves, twice, and the call was closed.
 * A stalled reply is covered by a filler line and is never counted as the
 * caller's silence.
 */
export const REPLY_STALL_MS = 5_000;
/** Stalls after which the gateway stops waiting for that reply and treats the line as idle again. */
export const REPLY_STALL_LIMIT = 6;
/** A reply OpenAI reports as failed is asked for again, this many times per caller turn. */
const FAILED_REPLY_RETRIES = 2;
const FAILED_REPLY_RETRY_MS = 1_500;
/**
 * How far back the live transcriber is read when the turn detector gave no
 * start for the speech a turn holds: longer than any one answer, so nothing
 * said on the turn is left out.
 */
const LIVE_WORDS_LOOKBACK_MS = 15_000;
/**
 * How long a caller who broke off mid-sentence ("I am on the", "so what
 * happens if we try to") is given to go on before they are asked to. The turn
 * detector ends a turn on a pause; a pause in the middle of a sentence is
 * not the end of one, and a reply there talks over the rest of it.
 */
export const UNFINISHED_WAIT_MS = 1_200;
/** While the caller is talking again at the end of that wait, how often to look whether they have stopped. */
const UNFINISHED_RECHECK_MS = 300;
/** A reply this short, with no question in it, is an acknowledgement and nothing else ("Exit 12, got it."). */
const BARE_ACK_MAX_WORDS = 6;
/** Caller lines that may carry an answer: the kinds whose reply is told to save with a short ack. */
const MAY_BE_AN_ANSWER: readonly CallerWordsKind[] = ['detail', 'backchannel', 'unknown'];
/**
 * Plans whose answer only the model can save, so a reply that was an ack and
 * nothing else is followed up. Not the callback number: a yes to it that the
 * model did not save is the judge's to take (`judged`), and two recoveries
 * for one answer would cross.
 */
const ONLY_THE_MODEL_SAVES = /^(?:ASK_|CLARIFY_FIELD$)/;

/** A tool result without the call state, which the note sent with it already carries. */
function withoutState(result: { callId: string; output: unknown }): { callId: string; output: unknown } {
  if (!result.output || typeof result.output !== 'object' || !('state' in result.output)) return result;
  const { state: _state, ...rest } = result.output as Record<string, unknown>;
  return { callId: result.callId, output: rest };
}

/** Replies that end the call are requested with a reason ending in "goodbye". */
const isGoodbye = (reason: string | undefined) => Boolean(reason?.endsWith('goodbye'));

/** Plans whose asks are counted, and given up on after `MAX_ASKS`. */
const COUNTED_ASK = /^(?:ASK_|CONFIRM_CALLBACK_NUMBER$)/;

/** Plans that put a question to the caller, whose answer starts the next turn. */
const PUTS_A_QUESTION = /^(?:ASK_|CLARIFY_FIELD$|CONFIRM_CALLBACK_NUMBER$)/;

/**
 * A question the model asked in the same reply as a save, set against the
 * plan the save produced. With the next question given before the save
 * (`ifAnswered`) it is usually that plan's own question.
 *
 * `fits`: the caller is answering it, so nothing more is asked. It is the
 * plan's question, or about something the save has just settled (asked
 * whether it rolls after "it won't start", the caller may as well say), or a
 * question about nothing the intake tracks ("Sorry, try to what?").
 * `stray`: it is about something that has to wait, or the plan is not a
 * question at all (safety advice): `asked` is what it was about.
 * Null: no question was asked with the save.
 */
export function questionWithSave(
  alreadySaid: string,
  state: Pick<IntakeSnapshot, 'nextAction'> | undefined,
  plan: Pick<NextActionPlan, 'topic' | 'settled'> | null,
): { verdict: 'fits' } | { verdict: 'stray'; asked: Topic } | { verdict: 'unjudged' } | null {
  const questions = alreadySaid ? questionsIn(alreadySaid) : [];
  if (questions.length === 0 || !state) return null;
  const topics = questions.flatMap((question) => question.topics);
  const asks = PUTS_A_QUESTION.test(state.nextAction);
  // Nothing to set it against: left as it was, and the reply to the results carries on from it.
  if (topics.length === 0) return asks ? { verdict: 'fits' } : { verdict: 'unjudged' };
  const wanted = plan?.topic ? [plan.topic, ASKED_AS_ONE[plan.topic]] : [];
  const fits = asks && topics.some((topic) => wanted.includes(topic) || Boolean(plan?.settled.includes(topic)));
  if (fits) return { verdict: 'fits' };
  return { verdict: 'stray', asked: topics.find((topic) => !wanted.includes(topic)) ?? topics[0]! };
}

/** Comparable form of a line: case, punctuation and spacing ignored. */
const comparable =(text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** An error as one line for the log. */
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The words of a reply the caller heard, by the share of its audio that played. */
export function heardPortion(text: string, playedBytes: number, sentBytes: number): string {
  if (sentBytes <= 0 || playedBytes <= 0) return '';
  const words = text.trim().split(/\s+/).filter(Boolean);
  const count = Math.floor(words.length * Math.min(1, playedBytes / sentBytes));
  return words.slice(0, count).join(' ');
}

/** The audio of an item the caller has heard, by the playback marks Twilio has echoed. */
const heardMs = (item: Pick<AssistantItem, 'bytesPlayed'>) => Math.round(item.bytesPlayed / BYTES_PER_MS);

/** How a stopped line is marked in the transcript. A reply never played (`stale`) is not a line at all. */
const STOP_MARK: Record<Exclude<StopReason, 'stale'>, string> = {
  interrupted: 'interrupted',
  guardrail: 'stopped',
  redirected: 'stopped',
  hangup: 'call ended',
};

/**
 * The transcript line for a receptionist item, and how much of it the caller
 * heard. The line is everything the model said: audio reaches the caller
 * ahead of the playback marks that measure it, so a reply stopped with "no"
 * audio heard was often heard in part, and once left no line at all.
 * `heard` is the estimate, for judging the reply and for the event trail.
 */
export function transcriptLine(
  item: Pick<AssistantItem, 'text' | 'stopped' | 'bytesPlayed' | 'bytesReceived'>,
): { text: string | null; heard: string } {
  const full = item.text.trim();
  if (!full || item.stopped === 'stale') return { text: null, heard: '' };
  if (!item.stopped) return { text: full, heard: full };
  return { text: `${full} [${STOP_MARK[item.stopped]}]`, heard: heardPortion(full, item.bytesPlayed, item.bytesReceived) };
}

/** Median and maximum of a list of durations. */
export function summarise(values: number[]): { count: number; medianMs: number; maxMs: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)]!, maxMs: sorted[sorted.length - 1]! };
}

interface TwilioMessage {
  event: string;
  streamSid?: string;
  start?: { callSid: string; customParameters?: Record<string, string> };
  media?: { payload: string };
  mark?: { name: string };
}

/**
 * `stale`: a reply that only arrived once the call was ending; the caller never hears it.
 * `hangup`: still playing when the call closed.
 */
type StopReason = 'interrupted' | 'guardrail' | 'redirected' | 'stale' | 'hangup';

/** One assistant message: what was generated, sent to Twilio, and played. */
/** The response id of a greeting played from a recording: no model response made it. */
const RECORDED_GREETING = 'greeting';

interface AssistantItem {
  id: string;
  responseId: string | null;
  text: string;
  /** Audio received from the model, kept until the item settles so a pause can be resumed. */
  chunks: Buffer[];
  bytesReceived: number;
  bytesSent: number;
  bytesPlayed: number;
  /** The response that produced it has finished generating. */
  generated: boolean;
  /** Stopped before it finished playing. */
  stopped: StopReason | null;
  /** Its transcript line has been settled. */
  settled: boolean;
  /** Played by the gateway, not spoken by the model: a filler line. Nothing to truncate or check. */
  synthetic: boolean;
  /** A recorded ack played for a save the model made in silence: part of the reply the caller hears, not a cover for a late one. */
  saveAck?: boolean;
  /** For the first reply to a caller turn: how long the caller waited for it, for the trail. */
  wait?: { afterTurnMs: number; afterLastSoundMs?: number };
}

/** A transcript line held in speaking order until its text is known. */
interface PendingLine {
  speaker: 'customer' | 'ai';
  key: string;
  text: string | null;
  /** For a receptionist line: the words the caller heard, which may be fewer than `text`. */
  heard?: string;
  ready: boolean;
  timer?: NodeJS.Timeout;
  /** For a caller line: the caller turn it was spoken on, from the audio. */
  turn?: number;
}

/** Why a turn's reply is being asked for, and what comes with it. */
interface TurnOptions {
  /** What the caller said while the receptionist was still speaking, and heard the rest of. */
  overlap?: string;
  /** `judged-yes`: the backend took the caller's answer itself. `redirect`: a reply was stopped. */
  reason?: 'caller-turn' | 'judged-yes' | 'redirect';
  /** The caller's words, whose answer the backend has saved. */
  answered?: string;
  /** The stopped question, for the redirect note. */
  redirect?: { asked: Topic; heard: string };
}

/** What a reply was asked for with, for the trail. */
interface ReplyDetail {
  /** The caller's words, and what kind of line they are. */
  said?: string;
  kind?: CallerWordsKind;
  /**
   * What the reply replaces: one asked for and not started (`asked`), one
   * under way that the caller had heard none of (`started`), or one that
   * finished without a word (`empty`).
   */
  superseded?: 'asked' | 'started' | 'empty';
  /** The words are the live transcriber's: the session's own transcript had not arrived when the reply was asked for. */
  live?: boolean;
  /** How long the request was held for the caller's words once the backend's state was ready: what the wait cost. */
  waitedMs?: number;
  /** How long the turn took to be ended after the caller's last sound: the turn detector's share of the wait. */
  endpointMs?: number;
}

/** A turn's reply as the backend's state left it: what its note and request are built from. */
interface TurnReply {
  reason: NonNullable<TurnOptions['reason']>;
  options: TurnOptions;
  callerTurn: number;
  state: IntakeSnapshot | undefined;
  plan: NextActionPlan | null;
}

/** One reply asked of the model on a caller turn, timed. */
export interface ReplyTiming {
  reason: string;
  /** The request's number, which comes back when its reply starts. */
  tag: string;
  requestedAt: number;
  responseId?: string;
  /** When its first audio came from the model; never, for a reply that said nothing or was dropped. */
  audioAt?: number;
  /** How long its tool calls took to run, the judge included. */
  toolsMs?: number;
}

/**
 * Where one caller turn's wait went, for the trail (TURN_TIMING): without
 * it the total is known and its parts are not, so a change that should have
 * made replies faster cannot be seen to have.
 */
export interface TurnTiming {
  turn: number;
  endedAt: number;
  /** The caller's last sound before the turn ended; null when the gauge did not hear one. */
  lastSoundAt: number | null;
  /** The end of the turn to the backend's state being ready, the wait in the operations queue included. */
  stateMs?: number;
  /** How long the first request was then held for the caller's words. */
  wordsMs?: number;
  replies: ReplyTiming[];
  /** Fillers played to cover a late reply. The recorded ack for a silent save is not one. */
  fillers: number;
  /** When the recorded ack for a silent save was played. */
  ackAt?: number;
}

/** A turn's timing as it is recorded: every figure in milliseconds. */
export function turnTimingPayload(timing: TurnTiming): Record<string, unknown> {
  const from = timing.lastSoundAt ?? timing.endedAt;
  const spoken = timing.replies.filter((reply) => reply.audioAt !== undefined);
  return {
    turn: timing.turn,
    ...(timing.lastSoundAt !== null ? { endedMs: timing.endedAt - timing.lastSoundAt } : {}),
    ...(timing.stateMs !== undefined ? { stateMs: timing.stateMs } : {}),
    ...(timing.wordsMs !== undefined ? { wordsMs: timing.wordsMs } : {}),
    replies: timing.replies.map((reply) => ({
      reason: reply.reason,
      // From the end of the turn, so the gaps between the stages can be read off.
      askedMs: reply.requestedAt - timing.endedAt,
      ...(reply.audioAt !== undefined ? { audioMs: reply.audioAt - reply.requestedAt } : {}),
      ...(reply.toolsMs !== undefined ? { toolsMs: reply.toolsMs } : {}),
    })),
    // The receptionist's own voice, and the last thing it said on the turn:
    // on a turn that saves first, the first is the recorded ack and the
    // second the question. Counted from the audio being sent; a filler still
    // playing is heard first.
    ...(timing.ackAt !== undefined ? { ackMs: timing.ackAt - from } : {}),
    ...(spoken.length > 0
      ? { voiceMs: Math.min(timing.ackAt ?? Infinity, spoken[0]!.audioAt!) - from, lastReplyMs: spoken.at(-1)!.audioAt! - from }
      : timing.ackAt !== undefined
        ? { voiceMs: timing.ackAt - from }
        : {}),
    sinceLastSound: timing.lastSoundAt !== null,
    fillers: timing.fillers,
  };
}

/** The first reply to a caller turn, held until the caller's words are transcribed. */
interface WordsWait {
  /** The turn's audio item: its transcript ends the wait. */
  key: string;
  reply: TurnReply;
  /** When the backend's state was ready: without the wait, the reply would have been asked for then. */
  since: number;
  /** The end of the wait or, while the caller is talking again, the next look at whether they have stopped. */
  timer: NodeJS.Timeout | null;
}

/** A line that broke off mid-sentence, and the reply to it, held while the caller is given a moment to go on. */
interface UnfinishedLine {
  reply: TurnReply;
  words: CallerJustSaid;
  timer: NodeJS.Timeout | null;
}

/**
 * Caller speech began while the receptionist was talking. The reply plays on
 * through a short sound; once the sound has gone on, playback is paused until
 * it is judged.
 */
interface Hold {
  startedAt: number;
  gauge: SpeechGauge;
  timer: NodeJS.Timeout | null;
  /**
   * Playback was stopped for this speech: it went on past
   * PLAY_THROUGH_VOICED_MS, or the caller had heard nothing of the reply.
   * Until then the hold only watches, and the reply is sent as it arrives.
   */
  paused: boolean;
  /** When playback was stopped, so the trail gives the length of the gap the caller heard and not of the whole watch. */
  pausedAt: number | null;
  /** Judged brief and the reply carried on; the gauge now watches for the caller carrying on after all. */
  resumed: boolean;
  /**
   * The caller had heard nothing of the reply when they spoke: it was still
   * being generated. Then there is nothing to interrupt. Cancelling it would
   * only lengthen the silence they are already reacting to ("Hello?"), so the
   * reply is kept and played once they stop, and their words answered after.
   */
  nothingHeard: boolean;
}

class RealtimeCallSession {
  streamSid: string | null = null;
  businessId: string | null = null;
  callId: string | null = null;
  greeting: string | null = null;
  instructions = '';
  conversation: RealtimeConversation | null = null;
  execute: ToolExecutor | null = null;

  readonly items = new Map<string, AssistantItem>();
  readonly marks = new Map<string, { itemId: string; bytes: number }>();
  markCounter = 0;

  currentResponseId: string | null = null;
  greetingResponseId: string | null = null;
  awaitingGreeting = false;
  responding = false;
  toolsRunning = false;

  /** Caller turns so far, counted from committed audio. */
  callerTurn = 0;
  /** A caller turn ended while tools ran; the tool results' reply covers it. */
  turnDuringTools = false;
  /** The required action the current reply must follow. */
  activePlan: NextActionPlan | null = null;
  /**
   * What the pinned state note was built from, and the caller turn it was
   * pinned on, so it can be pinned again quoting the caller's words once
   * they are known. Cleared once the call is ending.
   */
  pinned: { state: IntakeSnapshot; options: ActionNoteOptions; turn: number } | null = null;
  /** One redirect per caller turn, so a stubborn model cannot loop. */
  redirectedThisTurn = false;
  /** The caller turn on which a reply that was only an ack was followed up, so it is once per turn. */
  ackFollowedTurn = 0;

  hold: Hold | null = null;
  /** OpenAI hears the caller speaking: from speech onset to the end of their speech. */
  callerSpeaking = false;
  /** How loudly this caller speaks, so a quiet voice still counts when they talk over a reply. */
  readonly voice = new VoiceLevel();
  /** The last hold ended with the reply carrying on, paused for or played through: the caller turn that commits next was that brief overlap. */
  overlapPending = false;
  /** Brief overlaps waiting for playback to end and their transcript to arrive, before deciding on a reply. */
  readonly deferredTurns: string[] = [];
  deferredTimer: NodeJS.Timeout | null = null;
  /** What the caller said, by item, once transcribed (null if transcription failed). */
  readonly callerText = new Map<string, string | null>();
  /** The streaming transcriber beside the session, when one is set up: the caller's words as they are said. */
  liveWords: LiveWords | null = null;
  /**
   * What the caller said on a turn as the streaming transcriber made it out,
   * by the turn's audio item: known as the turn ends, where the session's
   * own transcript (`callerText`) comes about half a second later.
   */
  readonly liveText = new Map<string, string>();
  /** When the caller began the speech their next turn will hold; null once that turn has ended. */
  speechBeganAt: number | null = null;
  /** From when the live transcriber's words belong to the caller's latest turn. */
  liveSince = 0;
  /** The audio item of the caller's latest turn: the line whose words the reply to it may still be waiting on. */
  turnKey: string | null = null;
  /**
   * The first reply to the caller's latest turn, held for their words. One at
   * a time, and dropped by whatever answers the turn instead: a new turn's
   * reply, tool results, a plan the backend changed, the end of the call.
   */
  wordsWait: WordsWait | null = null;
  /** The caller broke off mid-sentence on their latest turn, and is being given a moment to go on. */
  unfinished: UnfinishedLine | null = null;
  /**
   * The start of a sentence the caller broke off and then went on with, and
   * the audio item of the turn that finishes it: that turn is quoted whole.
   */
  carried: { key: string; text: string } | null = null;

  /** When the caller's latest turn ended, until the reply to it reaches Twilio. */
  turnEndedAt: number | null = null;
  fillerTimer: NodeJS.Timeout | null = null;
  fillerCounter = 0;
  /** When the armed filler is due to play. */
  fillerDueAt = 0;
  /** The recorded ack played for a reply that saves in silence, and which reply, so its results' note says it was said. */
  savedAck: { responseId: string; text: string } | null = null;
  /** This call's rotation through the filler lines, so two calls do not both open with "Mm-hm.". */
  fillers: FillerPicker | null = null;
  /** Caller turn end to first reply audio, per turn. */
  readonly latencies: number[] = [];
  /**
   * Listens to the caller for the whole call, so the wait can be measured
   * from their last sound. The turn's end is OpenAI's, and comes some time
   * after they stop: that time is part of what the caller waits.
   */
  readonly ear = new SpeechGauge();
  /** When the caller last made a sound while OpenAI heard them speaking. */
  lastVoicedAt: number | null = null;
  /** The last sound of the turn being answered, until its reply reaches Twilio. */
  lastSoundAt: number | null = null;
  /** The caller's last sound to the end of their turn, for the turn being answered and for every turn. */
  endpointMs: number | null = null;
  readonly endpoints: number[] = [];
  /** The caller's last sound to the moment the reply starts playing, per turn. */
  readonly heardAfter: number[] = [];
  /** Times the receptionist stopped mid-reply for a brief sound and carried on. */
  pauses = 0;
  /** Where the wait on the caller's latest turn is going, until the next turn or the end of the call records it. */
  timing: TurnTiming | null = null;
  /** Per turn: the end of the turn to the backend's state; per reply: asked for to first audio; per turn: to the last reply. */
  readonly stateTimes: number[] = [];
  readonly modelTimes: number[] = [];
  readonly lastReplyTimes: number[] = [];

  /**
   * A reply has been asked of the model and has not started. Until it does,
   * quiet on the line is the receptionist's, not the caller's.
   */
  replyOwed = false;
  stallTimer: NodeJS.Timeout | null = null;
  stalls = 0;
  /** Replies OpenAI reported as failed since the caller's last turn. */
  failedThisTurn = 0;
  retryTimer: NodeJS.Timeout | null = null;

  /** The backend has ended the call; hang up once the goodbye has played. */
  ending = false;
  responsesSinceEnding = 0;
  endTimer: NodeJS.Timeout | null = null;
  /** The model was lost, and this is why. The call ends as a technical failure, not a hang-up. */
  failure: string | null = null;
  /** Replies that started after the call began ending and are not the goodbye. */
  readonly staleResponses = new Set<string>();
  /** What the receptionist has said in reply to each caller turn, as the caller heard it. */
  readonly replies = new Map<number, string>();
  /** Replies that read the details back. If the caller cuts one short, the backend is told how much they heard. */
  readonly readBacks = new Set<string>();
  /** Replies made under a plan that asks for something, and the caller turn it was counted on. */
  readonly asks = new Map<string, { action: string; turn: number }>();
  /**
   * What the questions the caller heard on each caller turn were about.
   * `unplaced`: a question about nothing the word lists know, which may be
   * the required one in words they do not recognise.
   */
  readonly heardQuestions = new Map<number, Set<Topic | 'unplaced'>>();
  /** Asks taken back, as `action@turn`, so that none is taken back twice. */
  readonly takenBack = new Set<string>();
  /** Why each response was asked for, so the trail can say what a reply was in answer to. */
  readonly responseReasons = new Map<string, string>();
  /** Each reply asked for is numbered; the number comes back when it starts. */
  requestSeq = 0;
  /**
   * The latest reply asked for. One with one-off instructions (the read-back,
   * a goodbye, the fallback line, the silence check) is said word for word,
   * and is never replaced for the caller's words.
   */
  lastRequested: ResponseRequest | null = null;
  /** Replies asked for with a lower number were overtaken by a change of plan: dropped unheard when they start. */
  supersededBelow = 0;
  /** The number of a reply asked for because the backend took a yes itself, until it starts. */
  judgedYesSeq: number | null = null;
  /**
   * The backend took a yes the model had not saved while a reply was already
   * under way: the caller's words, so the fresh plan can follow that reply.
   */
  replanPending: string | null = null;
  /** The reply that ends the call has been asked for; tool results after it are returned without another. */
  goodbyeRequested = false;

  guardrailTrips = 0;
  /** A configured pricing fact was given to the model, so it may repeat it. */
  pricingAllowed = false;

  readonly usage: UsageTotals = emptyUsage();

  /** Every database operation for this call, strictly in order. */
  ops: Promise<unknown> = Promise.resolve();
  readonly lines: PendingLine[] = [];

  noInputTimer: NodeJS.Timeout | null = null;
  /** The caller's latest line asked for a moment; quiet is given longer before a check-in. */
  patient = false;
  /** Closes a socket that never says which call it carries. */
  startTimer: NodeJS.Timeout | null = null;
  /** Ends the call at the tenant's maximum length. */
  limitTimer: NodeJS.Timeout | null = null;
  closed = false;

  constructor(readonly socket: MediaSocket) {}

  /** Audio the caller has not heard yet: sent and unplayed, or held back. */
  get playing(): boolean {
    for (const item of this.items.values()) {
      if (!item.stopped && (item.bytesPlayed < item.bytesSent || item.bytesSent < item.bytesReceived)) return true;
    }
    return false;
  }

  /** The most recent reply the caller could hear, in full. */
  get lastReplyText(): string {
    let text = '';
    for (const item of this.items.values()) if (!item.stopped && item.text.trim()) text = item.text;
    return text;
  }
}

@Injectable()
export class RealtimeVoiceGateway {
  private readonly logger = new Logger('RealtimeVoice');
  private server: WebSocketServer | null = null;
  /** How long the first reply to a turn may wait for the caller's words; 0 asks at once. */
  private readonly wordsWaitMs: number;

  constructor(
    private readonly callSession: CallSessionService,
    private readonly businessConfig: BusinessConfigService,
    @Inject(REALTIME_CONVERSATION_FACTORY)
    private readonly createConversation: RealtimeConversationFactory,
    // Named explicitly: Nest cannot see a class through `Pick<>`, and without
    // the name it silently injected nothing, so no live call ever heard a filler.
    @Optional() @Inject(RealtimeFillerBank) private readonly fillers?: Pick<RealtimeFillerBank, 'next' | 'forCall'>,
    /** Judges words said over the receptionist; without it the word lists below decide. */
    @Optional() @Inject(CALL_JUDGE) private readonly judge?: Pick<CallJudge, 'judgeOverlap'>,
    /**
     * Decides which streams may carry a call. Always present on the running
     * API; the eval harness and the unit tests, which speak for Twilio
     * themselves, run without one.
     */
    @Optional() @Inject(StreamGate) private readonly gate?: Pick<StreamGate, 'admit'>,
    /** Greetings recorded in the call voice, played the instant a stream starts. */
    @Optional() @Inject(GreetingBank) private readonly greetings?: Pick<GreetingBank, 'get' | 'record'>,
    /**
     * How long the first reply to a turn may wait for the caller's words.
     * Not given (the running API, the eval harness): AI_REALTIME_WORDS_WAIT_MS,
     * which the config module has validated into the environment by then.
     */
    @Optional() @Inject(REALTIME_WORDS_WAIT_MS) wordsWaitMs?: number,
    /**
     * A streaming transcriber that listens beside the session, so the
     * caller's words are known as their turn ends (AI_REALTIME_LIVE_WORDS).
     * Without one the first reply to a turn waits for the session's own.
     */
    @Optional() @Inject(REALTIME_LIVE_WORDS) private readonly liveWordsProvider?: SttProvider | null,
  ) {
    this.wordsWaitMs = readWordsWait(wordsWaitMs ?? process.env.AI_REALTIME_WORDS_WAIT_MS);
  }

  /** Attached from `main.ts` only when VOICE_PIPELINE=chatgpt. */
  attach(httpServer: import('node:http').Server): void {
    this.server = new WebSocketServer({ server: httpServer, path: REALTIME_STREAM_PATH, maxPayload: STREAM_MAX_PAYLOAD_BYTES });
    this.server.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.logger.log(`Realtime voice gateway listening on ${REALTIME_STREAM_PATH}${this.gate ? '' : ' (no stream gate: streams are not checked)'}`);
  }

  handleConnection(socket: MediaSocket, _request?: IncomingMessage): void {
    const session = new RealtimeCallSession(socket);
    session.fillers = this.fillers?.forCall() ?? null;
    session.startTimer = setTimeout(() => {
      session.startTimer = null;
      if (!session.callId && !session.closed) {
        this.logger.warn('A stream said nothing about which call it carries; closing it.');
        socket.close();
      }
    }, STREAM_START_TIMEOUT_MS);

    // Whatever goes wrong with one call's stream costs that call alone. Left
    // uncaught, a rejection here ends the process, and every live call with
    // it: a start for a business that cannot be loaded did exactly that.
    socket.on('message', (raw: Buffer) => {
      this.handleMessage(socket, session, raw.toString()).catch((error: unknown) => this.abandon(session, 'a message', error));
    });
    socket.on('close', () => {
      this.teardown(session).catch((error: unknown) => this.logger.error(`Call ${session.callId}: teardown failed: ${describe(error)}`));
    });
    socket.on('error', (error: Error) => {
      this.logger.error(`Socket error on call ${session.callId}: ${error.message}`);
      this.abandon(session, 'the socket', error);
    });
  }

  /** Something failed that nothing else will recover from: the call's stream is closed, and only that. */
  private abandon(session: RealtimeCallSession, what: string, error: unknown): void {
    this.logger.error(`Call ${session.callId ?? '(not started)'}: ${what} failed, closing the stream: ${describe(error)}`);
    if (session.socket.readyState === session.socket.OPEN) session.socket.close();
    else this.teardown(session).catch(() => undefined);
  }

  private async handleMessage(socket: MediaSocket, session: RealtimeCallSession, raw: string): Promise<void> {
    let message: TwilioMessage;
    try {
      message = JSON.parse(raw) as TwilioMessage;
    } catch {
      return;
    }

    switch (message.event) {
      case 'start':
        await this.handleStart(socket, session, message);
        break;

      case 'media': {
        // Twilio sends the audio as base64 text. Anything else is not audio,
        // and turning it into a buffer throws.
        const payload = message.media?.payload;
        if (typeof payload === 'string' && payload) {
          const frame = Buffer.from(payload, 'base64');
          session.conversation?.appendAudio(frame);
          session.liveWords?.write(frame);
          // Every frame shapes the line's noise floor; only sound while OpenAI
          // hears speech is taken for the caller's.
          if (session.ear.feed(frame, session.voice.minVoicedRms) && session.callerSpeaking) session.lastVoicedAt = Date.now();
          if (session.hold) this.judgeHold(socket, session, frame);
          // Their own voice, with none of the receptionist's in the line.
          else if (session.callerSpeaking && !session.playing) session.voice.feed(frame);
        }
        break;
      }

      case 'mark':
        this.handleMark(socket, session, message.mark?.name);
        break;

      case 'stop':
        await this.teardown(session);
        break;

      default:
        break;
    }
  }

  private async handleStart(socket: MediaSocket, session: RealtimeCallSession, message: TwilioMessage): Promise<void> {
    // One realtime session per stream. A repeated start would open a second
    // OpenAI session for the same call.
    if (session.callId) {
      this.logger.warn(`Ignoring a repeated stream start on call ${session.callId}`);
      return;
    }
    session.streamSid = message.streamSid ?? null;
    const params = message.start?.customParameters ?? {};
    let businessId = params['businessId'] ?? null;
    let callId = params['callId'] ?? null;
    let greeting = params['greeting'] ?? null;
    let callerNumber = params['callerNumber'] || null;

    // Nothing the socket says about itself is taken on trust: the voice
    // webhook signed the ids, and the call record says what was said first.
    if (this.gate) {
      const verdict = await this.gate.admit({
        businessId: businessId ?? undefined,
        callId: callId ?? undefined,
        callSid: message.start?.callSid,
        token: params['token'],
      });
      if (!verdict.ok) {
        this.logger.warn(`Refused a stream for call ${callId ?? '?'}: ${verdict.reason}.`);
        socket.close();
        return;
      }
      ({ businessId, callId, greeting, callerNumber } = verdict.call);
    }

    if (!businessId || !callId) {
      this.logger.error('Realtime stream started without businessId/callId parameters; closing.');
      socket.close();
      return;
    }
    session.businessId = businessId;
    session.callId = callId;
    session.greeting = greeting;
    if (session.startTimer) {
      clearTimeout(session.startTimer);
      session.startTimer = null;
    }
    // The greeting, recorded in the call voice, plays the instant the stream
    // starts. Spoken by the model, it came 1.5 to 2.5 s after the caller was
    // connected, while the OpenAI session was set up: silence, to the caller.
    const recorded = session.greeting ? (this.greetings?.get(session.greeting) ?? null) : null;
    const greeted = recorded !== null && this.playGreeting(session, recorded);

    const config = await this.businessConfig.load(session.businessId);
    // Twilio can hang up while the config loads. A session opened after that
    // would never be closed, and would still ask OpenAI for the greeting.
    if (session.closed) {
      this.logger.warn(`Call ${session.callId} ended before its realtime session opened; not opening one.`);
      return;
    }
    session.instructions = buildReceptionistInstructions({
      facts: config.flow.facts,
      callerNumber,
    });
    // The tenant's maximum call length, set on the dashboard and, until now,
    // never applied by any pipeline.
    if (typeof config.maxCallSeconds === 'number' && config.maxCallSeconds > 0) {
      session.limitTimer = setTimeout(() => this.callTooLong(session, config.maxCallSeconds), config.maxCallSeconds * 1000);
    }
    // The tools act on this call and no other, and confirmations are checked
    // against the caller turns counted here; nothing the model says changes that.
    session.execute = createToolExecutor({
      callSession: this.callSession,
      businessId: session.businessId,
      callId: session.callId,
      callerTurn: () => session.callerTurn,
    });

    session.conversation = this.createConversation({
      label: session.callId,
      instructions: session.instructions,
      // No vocabulary prompt for the transcriber: on the first real call it
      // turned line noise into "Hello, this is Liberty Towing", twice.
      callbacks: {
        onSpeechStarted: () => {
          session.callerSpeaking = true;
          session.speechBeganAt ??= Date.now();
          this.interrupt(socket, session);
        },
        onSpeechStopped: (durationMs) => {
          session.callerSpeaking = false;
          this.speechStopped(socket, session, durationMs);
        },
        onCallerTurn: (itemId) => this.callerTurn(socket, session, itemId),
        onCallerTranscript: (itemId, text) => this.callerTranscript(session, itemId, text),
        onResponseStarted: (responseId, requested, reason, tag) => {
          session.responseReasons.set(responseId, reason ?? (requested ? 'requested' : 'not requested'));
          const seq = tag === undefined ? NaN : Number(tag);
          const timed = tag === undefined ? undefined : session.timing?.replies.find((reply) => reply.tag === tag);
          if (timed) timed.responseId = responseId;
          if (seq === session.judgedYesSeq) session.judgedYesSeq = null;
          session.responding = true;
          session.currentResponseId = responseId;
          this.replyStarted(session);
          if (requested && session.awaitingGreeting) {
            session.awaitingGreeting = false;
            session.greetingResponseId = responseId;
          }
          this.clearNoInputTimer(session);
          // Asked for under a plan that has since changed, and not heard: the
          // reply asked for under the new plan replaces it.
          if (!session.ending && seq < session.supersededBelow) {
            this.logger.log(`Call ${session.callId}: dropping a reply (${reason ?? 'not requested'}) asked for before the call state changed`);
            session.staleResponses.add(responseId);
            session.conversation?.cancelResponse({ keepQueued: true });
            this.owe(session);
            return;
          }
          if (reason === 'read-back' || session.activePlan?.action === 'CONFIRM_DETAILS') session.readBacks.add(responseId);
          else if (session.activePlan && COUNTED_ASK.test(session.activePlan.action)) {
            session.asks.set(responseId, { action: session.activePlan.action, turn: session.callerTurn });
          }
          // Asked for before the call began ending, answered only now: on a
          // real call this was a question, played just before the line closed.
          if (session.ending && !isGoodbye(reason)) {
            this.logger.warn(`Call ${session.callId}: dropping a reply (${reason ?? 'not requested'}) that arrived after the call began ending`);
            session.staleResponses.add(responseId);
            session.conversation?.cancelResponse({ keepQueued: true });
            // The goodbye behind it is still owed.
            this.owe(session);
          }
        },
        onToolCallStarted: (responseId, name) => this.toolCallStarted(session, responseId, name),
        onAudio: (itemId, chunk) => this.forwardAudio(socket, session, itemId, chunk),
        onSpokenText: (itemId, text) => this.monitorSpeech(socket, session, itemId, text),
        onResponseDone: (response) => this.responseDone(socket, session, response),
        onUsage: ({ kind, usage }) => {
          if (kind === 'response') addResponseUsage(session.usage, usage);
          else addTranscriptionUsage(session.usage, usage);
        },
        onError: (error) => {
          this.logger.error(`Realtime error on call ${session.callId}: ${error.message}`);
          void this.enqueue(session, () => this.recordProviderError(session, 'error', error.message));
        },
        onClose: () => {
          // Without the model the caller would hear only silence. Once the
          // goodbye is under way the loss costs nothing; before that, the call
          // ends as a technical failure: the caller hears an apology, and the
          // towing team gets a callback with the caller's number.
          if (!session.closed && !session.ending) this.fail(session, 'OpenAI realtime session closed mid-call');
          else if (!session.closed) socket.close();
        },
      },
    });

    if (this.liveWordsProvider) {
      session.liveWords = new LiveWords(this.liveWordsProvider, { label: session.callId, onWords: () => this.liveWordsHeard(session) });
    }

    // The greeting was chosen and stored by the voice webhook. Played from a
    // recording, it is put in the conversation as the model's own words, so
    // the model carries on from it; otherwise the model speaks it.
    if (session.greeting && greeted) {
      this.greetingSaid(session, session.greeting);
    } else if (session.greeting) {
      session.awaitingGreeting = true;
      this.respond(session, { instructions: greetingInstructions(session.greeting), toolChoice: 'none', reason: 'greeting' });
    }
  }

  /**
   * Plays the recorded greeting as a synthetic item, like a filler: nothing
   * to truncate or check, and not written to the transcript again, since the
   * voice webhook recorded the greeting it chose. True if it was sent.
   */
  private playGreeting(session: RealtimeCallSession, greeting: Filler): boolean {
    const socket = session.socket;
    if (session.closed || !session.streamSid || socket.readyState !== socket.OPEN) return false;
    const item: AssistantItem = {
      id: RECORDED_GREETING,
      responseId: RECORDED_GREETING,
      text: greeting.text,
      chunks: [greeting.audio],
      bytesReceived: greeting.audio.length,
      bytesSent: 0,
      bytesPlayed: 0,
      generated: true,
      stopped: null,
      settled: false,
      synthetic: true,
    };
    session.items.set(item.id, item);
    session.greetingResponseId = RECORDED_GREETING;
    this.expectLine(session, 'ai', item.id);
    this.sendAudio(socket, session, item, greeting.audio);
    return true;
  }

  /**
   * Tells the model the greeting has been said, so it carries on from it
   * instead of greeting the caller again: as its own message where the
   * conversation can carry one, in a note otherwise.
   */
  private greetingSaid(session: RealtimeCallSession, greeting: string): void {
    const conversation = session.conversation;
    if (conversation?.addAssistantMessage) conversation.addAssistantMessage(greeting);
    else this.note(session, 'greeting', alreadySaidNote(greeting));
  }

  /** Asks the model to respond with one-off instructions, keeping the receptionist's own. */
  private respond(session: RealtimeCallSession, request: ResponseRequest = {}): void {
    this.request(session, this.rightNow(session, request), request.instructions);
  }

  /**
   * Asks the model for a reply. From now until it starts, the reply is owed.
   * `oneOff`: the instructions for this reply alone, for the trail; the
   * receptionist's own instructions they are sent with are not logged.
   * `detail`: the caller's words it was asked for with, for the trail.
   */
  private request(session: RealtimeCallSession, request: ResponseRequest, oneOff?: string, detail?: ReplyDetail): void {
    this.owe(session);
    this.logEvent(session, CallEventType.REPLY_REQUESTED, {
      reason: request.reason ?? 'unspecified',
      ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
      ...(oneOff ? { instructions: oneOff } : {}),
      ...detail,
    });
    session.conversation?.requestResponse(this.numbered(session, request));
  }

  /**
   * The request with its number, which comes back when its reply starts.
   * Every request passes through here: it is remembered as the latest, and a
   * goodbye as asked for.
   */
  private numbered(session: RealtimeCallSession, request: ResponseRequest): ResponseRequest {
    if (isGoodbye(request.reason)) session.goodbyeRequested = true;
    const numbered = { ...request, tag: String(++session.requestSeq) };
    session.lastRequested = numbered;
    session.timing?.replies.push({ reason: request.reason ?? 'unspecified', tag: numbered.tag, requestedAt: Date.now() });
    // The reply just asked for is given time to start before a filler covers
    // the wait: played just ahead of it, the clip only makes the reply later.
    if (session.fillerTimer && session.fillerDueAt - Date.now() < FILLER_AFTER_REQUEST_MS) this.armFiller(session, FILLER_AFTER_REQUEST_MS);
    return numbered;
  }

  /**
   * Records where the wait on the turn before went, once: as the next turn
   * begins, or as the call ends. A turn nothing was asked of the model for
   * (an "Um", an acknowledgement) has nothing to record.
   */
  private closeTiming(session: RealtimeCallSession): void {
    const timing = session.timing;
    session.timing = null;
    if (timing) this.recordTiming(session, timing);
  }

  private recordTiming(session: RealtimeCallSession, timing: TurnTiming): void {
    if (timing.replies.length === 0) return;
    const payload = turnTimingPayload(timing);
    if (timing.stateMs !== undefined) session.stateTimes.push(timing.stateMs);
    for (const reply of timing.replies) if (reply.audioAt !== undefined) session.modelTimes.push(reply.audioAt - reply.requestedAt);
    if (typeof payload.lastReplyMs === 'number' && timing.lastSoundAt !== null) session.lastReplyTimes.push(payload.lastReplyMs);
    this.logEvent(session, CallEventType.TURN_TIMING, payload);
  }

  /** Adds a note to the model's conversation, and to the call's trail. */
  private note(
    session: RealtimeCallSession,
    kind: 'state' | 'redirect' | 'guardrail_recovery' | 'self_talk_recovery' | 'greeting',
    text: string,
    options: { pinned?: boolean; action?: string } = {},
  ): void {
    if (options.pinned) session.conversation?.addNote(text, { pinned: true });
    else session.conversation?.addNote(text);
    this.logEvent(session, CallEventType.MODEL_NOTE, {
      kind,
      pinned: Boolean(options.pinned),
      ...(options.action ? { action: options.action } : {}),
      text,
    });
  }

  /* ------------------------------------------------------------------------ */
  /*  A reply that is owed                                                    */
  /* ------------------------------------------------------------------------ */

  private owe(session: RealtimeCallSession): void {
    if (session.closed) return;
    this.clearNoInputTimer(session);
    if (session.replyOwed) {
      // Owed already. Its clock is stopped only while a reply held for the
      // caller's words waits for them to stop talking (wordsWaitOver).
      if (!session.stallTimer) this.armStallTimer(session);
      return;
    }
    session.replyOwed = true;
    session.stalls = 0;
    this.armStallTimer(session);
  }

  private replyStarted(session: RealtimeCallSession): void {
    session.replyOwed = false;
    session.stalls = 0;
    if (session.stallTimer) {
      clearTimeout(session.stallTimer);
      session.stallTimer = null;
    }
  }

  private armStallTimer(session: RealtimeCallSession): void {
    if (session.stallTimer) clearTimeout(session.stallTimer);
    session.stallTimer = setTimeout(() => this.replyStalled(session), REPLY_STALL_MS);
  }

  /** The reply has still not started. Cover the wait; give up on it only after a long time. */
  private replyStalled(session: RealtimeCallSession): void {
    session.stallTimer = null;
    if (session.closed || !session.replyOwed) return;
    session.stalls += 1;
    const waited = session.stalls * REPLY_STALL_MS;
    this.logger.warn(`Call ${session.callId}: the reply has not started ${waited}ms after it was asked for`);
    if (session.stalls === 1) {
      void this.enqueue(session, () => this.recordProviderError(session, 'reply_stalled', `No reply had started ${waited}ms after it was requested`));
    }

    if (session.stalls >= REPLY_STALL_LIMIT) {
      // Nothing is coming. A receptionist that cannot speak hands the caller
      // to a person: the call ends as a failure, with an apology and a callback.
      session.replyOwed = false;
      this.fail(session, `No reply from the model ${waited / 1000}s after it was asked for`);
      return;
    }
    this.playFiller(session, true);
    this.armStallTimer(session);
  }

  /** OpenAI gave up on a reply. Ask again, a limited number of times per caller turn. */
  private replyFailed(socket: MediaSocket, session: RealtimeCallSession, response: RealtimeResponseSummary): void {
    session.failedThisTurn += 1;
    const detail = response.failure ?? 'no reason given';
    this.logger.error(`Call ${session.callId}: OpenAI failed a reply (${detail})`);
    void this.enqueue(session, () => this.recordProviderError(session, 'response_failed', detail));

    if (session.closed) return;
    if (session.failedThisTurn > FAILED_REPLY_RETRIES) {
      this.fail(session, `OpenAI failed the reply ${session.failedThisTurn} times (${detail})`);
      return;
    }
    this.owe(session);
    if (session.retryTimer) clearTimeout(session.retryTimer);
    session.retryTimer = setTimeout(() => {
      session.retryTimer = null;
      if (session.closed) return;
      // The plan changed while the failed reply was under way: ask under the fresh one.
      if (session.replanPending !== null && !session.ending) {
        const answered = session.replanPending;
        session.replanPending = null;
        this.startTurn(session, { reason: 'judged-yes', answered });
        return;
      }
      const reason = session.ending ? 'retry-goodbye' : 'retry';
      this.logEvent(session, CallEventType.REPLY_REQUESTED, { reason });
      session.conversation?.requestResponse(this.numbered(session, { reason }));
    }, FAILED_REPLY_RETRY_MS);
  }

  /** One-off instructions for a single reply, on top of the receptionist's own. */
  private rightNow(session: RealtimeCallSession, request: ResponseRequest): ResponseRequest {
    return {
      ...request,
      instructions: request.instructions ? `${session.instructions}\n\nRIGHT NOW\n${request.instructions}` : undefined,
    };
  }

  /* ------------------------------------------------------------------------ */
  /*  Turns: the backend decides, then the model replies                      */
  /* ------------------------------------------------------------------------ */

  /** The caller's turn ended and its audio is in the conversation. */
  private callerTurn(socket: MediaSocket, session: RealtimeCallSession, itemId: string): void {
    this.expectLine(session, 'customer', itemId);
    session.turnKey = itemId;
    // The speech this turn holds began at the first onset since the last turn.
    session.liveSince = session.speechBeganAt ?? Date.now() - LIVE_WORDS_LOOKBACK_MS;
    session.speechBeganAt = null;
    this.takeLiveWords(session, itemId);
    // They went on with a sentence they had broken off: this turn finishes it.
    if (session.unfinished) session.carried = { key: itemId, text: session.unfinished.words.text };
    this.takeBackUnputQuestion(session);
    session.callerTurn += 1;
    const line = session.lines.find((l) => l.key === itemId);
    if (line) line.turn = session.callerTurn;
    session.redirectedThisTurn = false;
    session.failedThisTurn = 0;
    session.patient = false;
    session.turnEndedAt = Date.now();
    this.measureEndpoint(session, session.turnEndedAt);
    // The turn before is recorded once this one's state has been asked for:
    // written first, its event would sit in the operations queue ahead of
    // the state read, and the record of the wait would add to the wait.
    const finished = session.timing;
    session.timing = { turn: session.callerTurn, endedAt: session.turnEndedAt, lastSoundAt: session.lastSoundAt, replies: [], fillers: 0 };
    if (finished) queueMicrotask(() => this.recordTiming(session, finished));
    if (session.closed || !session.businessId || !session.callId) return;

    // Speech that ended before the receptionist was cut off was brief.
    if (session.hold) {
      if (!session.hold.resumed) this.endHold(socket, session, 'resume', 'turn_ended');
      session.hold = null;
    }
    if (session.overlapPending) {
      // A reply still held for the last turn's words stays held, and is still
      // asked for: this line may need no reply at all, and is judged after it.
      session.overlapPending = false;
      session.deferredTurns.push(itemId);
      this.answerDeferred(socket, session);
      return;
    }
    this.startTurn(session);
  }

  /**
   * An ask is counted when its plan is delivered, once per caller turn, and
   * after three the question is given up. But a turn on which the caller
   * never heard the question is not an ask. On a real call (09ba2f2a) the
   * location was asked twice; the caller said "I have a truck", then "Um",
   * then began the address, and by then the location had been "asked three
   * times" and dropped, so they were asked what was wrong with the truck
   * instead. Called as the next turn begins, for the turn just ended.
   */
  private takeBackUnputQuestion(session: RealtimeCallSession): void {
    const turn = session.callerTurn;
    const plan = session.activePlan;
    if (turn < 1 || session.ending || !plan?.topic || !COUNTED_ASK.test(plan.action)) return;
    // Still being said: whether they hear the question is not known yet.
    for (const item of session.items.values()) {
      if (!item.synthetic && !item.settled && !item.stopped) return;
    }
    const heard = session.heardQuestions.get(turn);
    const wanted = [plan.topic, ASKED_AS_ONE[plan.topic]];
    // A question in words the lists do not know counts as put: left out, a
    // model that keeps asking that way would never run out of asks.
    if (heard && (heard.has('unplaced') || wanted.some((topic) => topic !== undefined && heard.has(topic)))) return;
    this.takeBack(session, plan.action, turn);
  }

  /** Takes back the ask counted for `action` on `turn`, once. */
  private takeBack(session: RealtimeCallSession, action: string, turn: number): void {
    if (!session.businessId || !session.callId) return;
    const key = `${action}@${turn}`;
    if (session.takenBack.has(key)) return;
    session.takenBack.add(key);
    const { businessId, callId } = session;
    void this.enqueue(session, () => this.callSession.applyIntakeOperation(businessId, callId, { kind: 'ask_unheard', action }, { callerTurn: turn }));
  }

  /**
   * How long the turn took to be ended after the caller's last sound. The
   * reply's own latency is counted from the end of the turn, so without this
   * the turn detector's share of the caller's wait is in no figure at all.
   */
  private measureEndpoint(session: RealtimeCallSession, turnEndedAt: number): void {
    const last = session.lastVoicedAt;
    session.lastVoicedAt = null;
    const measured = last !== null && turnEndedAt - last <= ENDPOINT_MAX_MS;
    session.lastSoundAt = measured ? last : null;
    session.endpointMs = measured ? turnEndedAt - last : null;
    if (session.endpointMs !== null) session.endpoints.push(session.endpointMs);
  }

  /**
   * Pin the backend's state and required action to the conversation, then
   * ask for the reply. `overlap` is what the caller said over the receptionist.
   */
  private startTurn(session: RealtimeCallSession, options: TurnOptions = {}): void {
    if (session.closed || !session.businessId || !session.callId) return;
    const { overlap } = options;
    const reason = options.reason ?? 'caller-turn';

    // A reply still held for an earlier turn's words is answered by this one:
    // a new turn's reply answers both, and a plan the backend has changed
    // since is fresher than the state the held reply was built from.
    this.dropWordsWait(session);

    // Tool results are about to go back with fresh state; that reply covers this turn.
    if (session.toolsRunning) {
      if (reason === 'caller-turn') session.turnDuringTools = true;
      return;
    }
    if (reason === 'caller-turn') {
      // A fresh state for this turn covers any change of plan still to deliver.
      session.replanPending = null;
      // The caller spoke again before hearing the reply to their yes: this turn's reply replaces it.
      if (session.judgedYesSeq !== null) {
        session.supersededBelow = Math.max(session.supersededBelow, session.judgedYesSeq + 1);
        session.judgedYesSeq = null;
      }
    }

    // Once the call is ending, only the goodbye is wanted. Owed and never
    // asked for, a reply here held the line open after the goodbye.
    if (session.ending) return;

    const { businessId, callId } = session;
    const callerTurn = session.callerTurn;
    // Owed from the moment the caller stops: the backend's state comes first,
    // and the wait for it is the receptionist's silence too.
    this.owe(session);
    // The caller's turn has just ended: a sound of listening covers the wait.
    // Timed from now, not from the request, so it covers the wait for their
    // words as well. Not twice for one turn.
    if (reason === 'caller-turn') this.armFiller(session);
    this.enqueue(session, () =>
      this.callSession.applyIntakeOperation(businessId, callId, { kind: 'state' }, { callerTurn }),
    )
      .then((result) => {
        // The backend's share of the wait, the queue ahead of it included.
        const timing = session.timing;
        if (reason === 'caller-turn' && timing && timing.turn === callerTurn && timing.stateMs === undefined) timing.stateMs = Date.now() - timing.endedAt;
        // Once the call is ending, only the goodbye is wanted.
        if (session.closed || session.ending) return;
        if (result?.ended) {
          // The backend gave up waiting for a yes to the read-back: the
          // details have gone to the towing team unconfirmed.
          this.beginEnding(session.socket, session);
          this.respond(session, { instructions: UNCONFIRMED_GOODBYE_INSTRUCTIONS, toolChoice: 'none', reason: 'unconfirmed-goodbye' });
          return;
        }
        if (result?.plan) session.activePlan = result.plan;
        const reply: TurnReply = { reason, options, callerTurn, state: result?.output.state as IntakeSnapshot | undefined, plan: result?.plan ?? null };
        // The caller's own words on their latest turn. Words said over the
        // receptionist are the overlap's to quote.
        const ordinary = reason === 'caller-turn' && !overlap && session.callerTurn === callerTurn;
        if (ordinary && this.holdForWords(session, reply)) return;
        // Transcribed before the state came back (the operations queue was
        // busy, or the wait is off): the first note quotes them, at no cost.
        this.askForReply(session, reply, ordinary ? this.turnWords(session) : undefined);
      })
      .catch((error: unknown) => this.abandon(session, 'the caller turn', error));
  }

  /**
   * Pins the backend's state for a turn and asks for the reply. `words`: the
   * caller's words on the turn, when known, quoted in the note. Still before
   * the save: a "yes" or a detail in them is saved first. `waitedMs`: how
   * long the request was held for them, for the trail.
   */
  private askForReply(session: RealtimeCallSession, reply: TurnReply, words: CallerJustSaid | undefined, waitedMs?: number, givenTime = false): void {
    const { reason, options, callerTurn, state, plan } = reply;
    const { overlap, answered } = options;
    const quoted = state ? words : undefined;
    if (waitedMs !== undefined && session.timing?.turn === callerTurn) session.timing.wordsMs = waitedMs;
    // A sound of thinking and nothing else: they have not finished. A reply
    // now would ask again on top of what they are about to say. On a real
    // call (09ba2f2a) "Um" and then "5532" were two turns. Advice and lines
    // said word for word are never held back for it.
    const waitingOnThem = state !== undefined && (PUTS_A_QUESTION.test(state.nextAction) || state.nextAction === 'AWAIT_CONFIRMATION');
    if (reason === 'caller-turn' && !overlap && !answered && quoted && waitingOnThem && isHesitation(quoted.text)) {
      this.stillThinking(session, quoted.text);
      return;
    }
    // A sentence broken off: they are given a moment to finish it before
    // being asked to. Once: when the moment has passed, the reply goes.
    if (reason === 'caller-turn' && !overlap && !answered && quoted?.kind === 'unfinished' && !givenTime) {
      this.waitForMore(session, reply, quoted);
      return;
    }
    if (state) {
      const noteOptions: ActionNoteOptions = answered ? { answered, overlap } : quoted ? { beforeSave: true, callerJustSaid: quoted } : { beforeSave: true, overlap };
      this.note(session, 'state', buildActionNote(state, noteOptions), { pinned: true, action: state.nextAction });
      session.pinned = { state, options: noteOptions, turn: callerTurn };
    }
    if (options.redirect && plan) {
      this.note(session, 'redirect', redirectNote(options.redirect.asked, plan, options.redirect.heard));
    }
    // A line that needs a reply carries no detail: there is nothing to save,
    // and a tool call would only cost the caller a round trip.
    const toolChoice = quoted && NEEDS_REPLY.includes(quoted.kind) ? ({ toolChoice: 'none' } as const) : {};
    // Words from the live transcriber, used before the session's own transcript was here.
    const live = quoted !== undefined && session.turnKey !== null && !session.callerText.has(session.turnKey) && session.liveText.has(session.turnKey);
    const detail = {
      ...(quoted ? { said: quoted.text, kind: quoted.kind } : {}),
      ...(live ? { live: true } : {}),
      ...(waitedMs !== undefined ? { waitedMs } : {}),
      ...(reason === 'caller-turn' && session.callerTurn === callerTurn && session.endpointMs !== null ? { endpointMs: session.endpointMs } : {}),
    };
    // What to do about the caller's words also goes with the reply itself
    // (see replyInstructions): the note alone was not followed.
    const oneOff = state && quoted && !answered ? replyInstructions(state, quoted) : null;
    // A line the word lists could not place, long enough to be someone
    // talking: answered like a person too, with tools still allowed.
    const remark = !oneOff && state && quoted && !answered ? remarkInstructions(state, quoted) : null;
    if (oneOff) this.request(session, this.rightNow(session, { reason, toolChoice: 'none', instructions: oneOff }), oneOff, detail);
    else if (remark) this.request(session, this.rightNow(session, { reason, instructions: remark }), remark, detail);
    else this.request(session, { reason, ...toolChoice }, undefined, detail);
    if (reason === 'judged-yes') session.judgedYesSeq = session.requestSeq;
  }

  /**
   * The caller broke off mid-sentence. The reply ("Sorry, try to what?") is
   * held for UNFINISHED_WAIT_MS: if they go on, their next turn finishes the
   * sentence and is answered whole (callerTurn carries the first part over);
   * if they do not, the reply is asked for as it would have been. No filler
   * covers the wait: the pause is theirs, and a sound from the receptionist
   * would land on the rest of their sentence.
   */
  private waitForMore(session: RealtimeCallSession, reply: TurnReply, words: CallerJustSaid): void {
    this.dropUnfinished(session);
    this.logger.log(`Call ${session.callId}: the caller broke off at "${words.text}"; giving them ${UNFINISHED_WAIT_MS}ms to go on`);
    this.logEvent(session, CallEventType.OVERLAP_DECIDED, { said: words.text, by: 'word lists', decision: 'wait', why: 'broke off mid-sentence: given a moment to go on', unfinished: true, waitMs: UNFINISHED_WAIT_MS });
    if (session.fillerTimer) {
      clearTimeout(session.fillerTimer);
      session.fillerTimer = null;
    }
    const line: UnfinishedLine = { reply, words, timer: null };
    line.timer = setTimeout(() => this.moreNeverCame(session, line), UNFINISHED_WAIT_MS);
    session.unfinished = line;
  }

  /** The moment given to finish the sentence has passed: unless they are talking again, they are asked to finish it. */
  private moreNeverCame(session: RealtimeCallSession, line: UnfinishedLine): void {
    if (session.unfinished !== line) return;
    line.timer = null;
    if (session.closed || session.ending) {
      session.unfinished = null;
      return;
    }
    // Talking again: what they say becomes a turn when they stop, and that
    // turn takes this line with it. If no turn comes of it, they are asked.
    if (session.callerSpeaking || session.hold) {
      line.timer = setTimeout(() => this.moreNeverCame(session, line), UNFINISHED_RECHECK_MS);
      return;
    }
    session.unfinished = null;
    this.owe(session);
    this.askForReply(session, line.reply, line.words, undefined, true);
  }

  /** The line broken off will not be answered on its own: a new turn, tool results or the end of the call takes it. */
  private dropUnfinished(session: RealtimeCallSession): void {
    const line = session.unfinished;
    if (!line) return;
    if (line.timer) clearTimeout(line.timer);
    session.unfinished = null;
  }

  /** The caller made a sound of thinking: no reply is asked for, and the line waits for them to go on. */
  private stillThinking(session: RealtimeCallSession, said: string): void {
    this.logger.log(`Call ${session.callId}: the caller said "${said}", still thinking; no reply`);
    this.logEvent(session, CallEventType.OVERLAP_DECIDED, { said, by: 'word lists', decision: 'no reply', why: 'a sound of thinking: they have not finished', hesitation: true });
    // Nothing is owed for this turn, and no filler covers a wait that is theirs.
    this.replyStarted(session);
    if (session.fillerTimer) {
      clearTimeout(session.fillerTimer);
      session.fillerTimer = null;
    }
    session.turnEndedAt = null;
    session.lastSoundAt = null;
    this.checkIdle(session.socket, session);
  }

  /**
   * Holds the first reply to an ordinary turn until the caller's words are
   * transcribed, so the note it is asked for with quotes them. On the real
   * call of 12 October (6d1304af) they came 400 to 560 ms after the reply was
   * asked for, on every turn: the reply was planned without them, and a
   * question was answered only by cancelling it and asking again. The wait is
   * counted from the end of the turn and capped (AI_REALTIME_WORDS_WAIT_MS);
   * at the cap the reply is asked for as before, and words that come later
   * are the caller-words path's (wordsKnown). True if the reply is held.
   */
  private holdForWords(session: RealtimeCallSession, reply: TurnReply): boolean {
    const key = session.turnKey;
    if (this.wordsWaitMs <= 0 || !reply.state || !key || session.turnEndedAt === null) return false;
    // With no filler recorded there is nothing to cover the wait: on a real
    // call (fe228d39) the recordings had failed at start-up, and every reply
    // came about 400 ms later into plain silence.
    if ((this.fillers as { size?: number } | undefined)?.size === 0) return false;
    // Transcribed already, or failed: nothing to wait for.
    if (session.callerText.has(key) || session.liveText.has(key)) return false;
    // Tools started while the state was read: their results' reply follows
    // at once. Asked for now, as before, so the two cannot cross.
    if (session.toolsRunning) return false;
    const left = this.wordsWaitMs - (Date.now() - session.turnEndedAt);
    if (left <= 0) return false;
    this.dropWordsWait(session);
    const wait: WordsWait = { key, reply, since: Date.now(), timer: null };
    wait.timer = setTimeout(() => this.wordsWaitOver(session, wait), left);
    session.wordsWait = wait;
    return true;
  }

  /**
   * The caller's words are known, or the wait for them is over: the held
   * reply is asked for. Not while the caller is talking again, though. Asked
   * for now, it would start while they talk, and since nothing was playing
   * when they began, nothing would hold it back. What they are saying becomes
   * a turn of its own when they stop (OpenAI commits every stretch of
   * speech), and that turn's reply answers this one too; if no turn comes,
   * the held reply is asked for once they have stopped.
   */
  private wordsWaitOver(session: RealtimeCallSession, wait: WordsWait): void {
    if (session.wordsWait !== wait) return;
    if (wait.timer) clearTimeout(wait.timer);
    wait.timer = null;
    if (session.callerSpeaking || session.hold) {
      // Quiet while they talk is not a stalled reply: its clock waits too, and owe() starts it again.
      if (session.stallTimer) {
        clearTimeout(session.stallTimer);
        session.stallTimer = null;
      }
      wait.timer = setTimeout(() => this.wordsWaitOver(session, wait), WORDS_WAIT_RECHECK_MS);
      return;
    }
    session.wordsWait = null;
    // Owed until a reply starts, whichever path ends up asking for it.
    this.owe(session);
    this.askHeldReply(session, wait);
  }

  /**
   * Asks for a reply held for the caller's words, quoting them if they came.
   * Whatever answered the turn meanwhile has dropped the wait already (a new
   * turn, tool results, a yes the backend took, the end of the call); these
   * checks cover what can still have changed underneath it.
   */
  private askHeldReply(session: RealtimeCallSession, wait: WordsWait): void {
    if (session.closed || session.ending) return;
    // As for a turn that ends while tools run: the results' reply covers it.
    if (session.toolsRunning) {
      session.turnDuringTools = true;
      return;
    }
    // The backend took a yes while an earlier reply was under way: the fresh
    // plan follows that reply (responseDone) or its retry, and answers this
    // turn as well. With neither left to carry it, it goes now.
    if (session.replanPending !== null) {
      if (session.responding || session.retryTimer) return;
      const answered = session.replanPending;
      session.replanPending = null;
      this.startTurn(session, { reason: 'judged-yes', answered });
      return;
    }
    this.askForReply(session, wait.reply, this.wordsOf(session, wait.key), Date.now() - wait.since);
  }

  /** The held reply will not be asked for: something else answers the turn, or the call is ending. */
  private dropWordsWait(session: RealtimeCallSession): void {
    this.dropUnfinished(session);
    const wait = session.wordsWait;
    if (!wait) return;
    if (wait.timer) clearTimeout(wait.timer);
    session.wordsWait = null;
  }

  /**
   * The caller's words on their latest turn, and what kind of line they are,
   * once transcribed. Not the words of a line said over the receptionist,
   * which the overlap path quotes and answers itself.
   */
  private turnWords(session: RealtimeCallSession): CallerJustSaid | undefined {
    const key = session.turnKey;
    if (!key || session.deferredTurns.includes(key)) return undefined;
    return this.wordsOf(session, key);
  }

  /**
   * What the caller said on the turn whose audio item is `key`: the
   * session's own transcript once it is here and, until then, the live
   * transcriber's. With the start of the sentence in front, when this turn
   * finishes one they had broken off.
   */
  private wordsOf(session: RealtimeCallSession, key: string): CallerJustSaid | undefined {
    const own = (session.callerText.get(key) ?? session.liveText.get(key))?.trim();
    if (!own) return undefined;
    const text = session.carried?.key === key ? `${session.carried.text} ${own}` : own;
    return { text, kind: classifyCallerWords(text) };
  }

  /**
   * Takes what the live transcriber has made out of the caller's latest
   * turn as that turn's words, if it has anything and the session's own
   * transcript is not here yet. Checked like any caller line: text in
   * another script is taken out, and the receptionist's own words heard
   * back are no line at all. True if the turn now has words.
   */
  private takeLiveWords(session: RealtimeCallSession, key: string): boolean {
    const live = session.liveWords;
    if (!live || session.liveText.has(key) || session.callerText.has(key)) return false;
    const heard = live.words(session.liveSince);
    const text = heard ? inLatinScript(heard) : null;
    if (!text || this.isEcho(session, text)) return false;
    session.liveText.set(key, text);
    // Used: what is said from here on belongs to the next turn.
    live.clear();
    return true;
  }

  /**
   * The live transcriber made out more of what the caller said. Its words
   * are usually here when the turn ends (callerTurn); when they come a
   * moment after, a reply held for the turn's words goes as soon as they do.
   * Not while the caller is talking again: those words are their next turn's.
   */
  private liveWordsHeard(session: RealtimeCallSession): void {
    const wait = session.wordsWait;
    if (!wait || session.closed || session.ending || session.callerSpeaking || session.hold) return;
    if (this.takeLiveWords(session, wait.key)) this.wordsWaitOver(session, wait);
  }

  /**
   * The caller's words for the current turn have been transcribed. On every
   * turn of the real call of 12 October they arrived about 400 ms before the
   * model's first audio, and nothing used them: the reply was planned before
   * they were known, and "I asked you something else." and "What kind of
   * information have I already given you?" were met with the next intake
   * question until the caller hung up.
   *
   * The first reply now waits for the words (holdForWords), so on most turns
   * it quotes them already and there is nothing to do here. This is for
   * words that come after the wait, or with the wait turned off.
   *
   * When the words need a reply (a question, a complaint, a check of the
   * line, small talk, a sentence cut off) and the caller has heard nothing of
   * the reply yet, the state note is pinned again quoting them, and the reply
   * is asked for again without tools: such a line carries no detail to save.
   * Everything is checked before anything is changed; any doubt leaves the
   * reply as it was, and the next turn's note still carries what went
   * unanswered.
   *
   * `deferred`: the line was said over the receptionist, read before the
   * overlap path ran, which can start the turn's reply at once.
   */
  private wordsKnown(session: RealtimeCallSession, heard: string, deferred: boolean): void {
    if (session.closed || session.ending) return;
    // The tool results go back with a note that quotes these words (runTools).
    if (session.toolsRunning) return;
    // The caller is talking again: their next turn is the one to answer.
    if (session.hold || session.callerSpeaking) return;
    // Said over the receptionist: the overlap path quotes and answers it.
    if (deferred) return;
    // The turn's words, with the start of the sentence in front when this turn finishes one they had broken off.
    const said = this.turnWords(session) ?? { text: heard.trim(), kind: classifyCallerWords(heard) };
    const { text, kind } = said;
    // Held because the live transcriber's words broke off mid-sentence. If
    // the session's transcript has the sentence whole, there is nothing to
    // wait for; if it breaks off too, the wait goes on.
    const broken = session.unfinished;
    if (broken) {
      if (kind === 'unfinished') return;
      this.dropUnfinished(session);
      this.owe(session);
      this.askForReply(session, broken.reply, said, undefined, true);
      return;
    }
    // A change of plan waits on the reply under way, and will follow it.
    if (session.replanPending !== null) return;
    // The reply has begun reaching the caller, or none was needed: too late to replace it.
    if (session.turnEndedAt === null) return;
    // The state for this turn is not back yet; when it is, its note quotes the words (startTurn).
    const pinned = session.pinned;
    if (!pinned || pinned.turn !== session.callerTurn) return;
    // The backend took these words as the answer to its question, and the note says so.
    if (pinned.options.answered) return;
    // The reply was asked for with these very words: it waited for them.
    const before = pinned.options.callerJustSaid;
    if (before?.text === text) return;
    // A line said word for word (read-back, goodbye, fallback, silence check)
    // is never replaced. Instructions about the caller's own words, sent with
    // the reply to their turn, are not such a line: they came from the live
    // transcriber's reading, which the session's transcript may correct.
    if (session.lastRequested?.instructions && !(before && session.lastRequested.reason === 'caller-turn')) return;

    // Asked for with the live transcriber's words, and they read the line the same way: nothing to put right.
    if (before && before.kind === kind) return;
    // A line that needs no reply of its own changes nothing, unless the reply
    // under way was asked for as if it did: that one was told to save nothing,
    // and a detail in the line would be lost.
    const needsReply = NEEDS_REPLY.includes(kind);
    if (!needsReply && !(before && NEEDS_REPLY.includes(before.kind))) return;

    // Under way and unheard: dropped now. Asked for and not started: dropped
    // when it starts, by its number. Finished without a word: nothing to drop.
    // Anything else is being heard, and is left alone.
    let superseded: NonNullable<ReplyDetail['superseded']>;
    if (this.dropUnheardReply(session)) superseded = 'started';
    else if (session.replyOwed) superseded = 'asked';
    else if (!session.responding && !session.playing) superseded = 'empty';
    else return;

    // As when the backend takes a yes: every reply asked for so far was asked
    // without these words. If the old reply's `response.created` has not
    // arrived yet, the cancel above did nothing and the request below queues
    // in the conversation behind it: the old reply is cancelled by number
    // when it starts (onResponseStarted), and the queued request goes out
    // once it is done. One extra round trip at worst, covered by the filler,
    // which stays armed for the turn.
    session.supersededBelow = session.requestSeq + 1;
    // A failed reply waiting to be asked for again is replaced as well.
    if (session.retryTimer) {
      clearTimeout(session.retryTimer);
      session.retryTimer = null;
    }
    const options: ActionNoteOptions = { ...pinned.options, callerJustSaid: { text, kind } };
    this.note(session, 'state', buildActionNote(pinned.state, options), { pinned: true, action: pinned.state.nextAction });
    session.pinned = { ...pinned, options };
    this.logger.log(`Call ${session.callId}: the caller said "${text}" (${kind}); asking for the reply again with their words`);
    const oneOff = replyInstructions(pinned.state, { text, kind });
    // Without tools for a line that only needs a reply; with them for one that may hold a detail after all.
    const asked: ResponseRequest = needsReply ? { reason: 'caller-words', toolChoice: 'none' } : { reason: 'caller-words' };
    if (oneOff) this.request(session, this.rightNow(session, { ...asked, instructions: oneOff }), oneOff, { said: text, kind, superseded });
    else this.request(session, asked, undefined, { said: text, kind, superseded });
  }

  /** The tenant's maximum call length has passed: whatever is saved goes to the towing team, and the call ends. */
  private callTooLong(session: RealtimeCallSession, seconds: number): void {
    session.limitTimer = null;
    if (session.closed || session.ending || !session.businessId || !session.callId) return;
    const { businessId, callId } = session;
    this.logger.warn(`Call ${callId}: reached the limit of ${seconds}s; ending it.`);
    void this.enqueue(session, () =>
      this.callSession.applyIntakeOperation(businessId, callId, { kind: 'end', reason: 'Call reached the maximum length before intake finished.' }),
    ).then((result) => {
      if (!result || session.closed || session.ending) return;
      this.beginEnding(session.socket, session);
      this.respond(session, { instructions: TURN_LIMIT_GOODBYE_INSTRUCTIONS, toolChoice: 'none', reason: 'time-limit-goodbye' });
    });
  }

  /**
   * If the reply has not reached the caller soon after their turn, a short
   * line in the receptionist's voice covers the wait — the way a person says
   * "mm-hm" while writing something down, rather than going silent.
   */
  private armFiller(session: RealtimeCallSession, after = FILLER_AFTER_MS): void {
    if (!session.fillers) return;
    if (session.fillerTimer) clearTimeout(session.fillerTimer);
    session.fillerDueAt = Date.now() + after;
    session.fillerTimer = setTimeout(() => {
      session.fillerTimer = null;
      this.playFiller(session);
    }, after);
  }


  /**
   * `stalled`: the reply is long overdue, so a filler is played whether or
   * not a caller turn is waiting on it. `kind`: the line to play, where the
   * caller's words do not decide it. Returns what was said, or null if
   * nothing was played.
   */
  private playFiller(session: RealtimeCallSession, stalled = false, kind?: FillerKind): string | null {
    const socket = session.socket;
    if (session.closed || session.ending || session.playing || session.hold) return null;
    if (!stalled && session.turnEndedAt === null) return null;
    if (!session.streamSid || socket.readyState !== socket.OPEN) return null;
    const filler = session.fillers?.next(stalled ? 'stall' : (kind ?? this.fillerKind(session)));
    if (!filler) return null;
    if (session.timing && kind === undefined) session.timing.fillers += 1;

    const item: AssistantItem = {
      id: `filler-${++session.fillerCounter}`,
      responseId: 'filler',
      text: filler.text,
      chunks: [filler.audio],
      bytesReceived: filler.audio.length,
      bytesSent: 0,
      bytesPlayed: 0,
      generated: true,
      stopped: null,
      settled: false,
      synthetic: true,
      ...(kind === 'detail' && !stalled ? { saveAck: true } : {}),
    };
    session.items.set(item.id, item);
    this.expectLine(session, 'ai', item.id);
    this.sendAudio(socket, session, item, filler.audio);
    return filler.text;
  }

  /**
   * The model saved what the caller said and said nothing: the words the
   * caller is waiting for are a second reply away. A recorded "Got it." is
   * played now, in the gap that reply takes to start, and the note with the
   * results says it was said, so the reply does not open with another.
   *
   * The model was first told to say the ack itself, in the reply that saves.
   * On live runs (18 Nov) it did one or the other: told to say "a short
   * ack" it said nothing, and given the words ("Sorry about that.") it said
   * them, asked its question and saved nothing, so an address was lost. A
   * reply of this model either speaks or saves; the gateway does the other.
   *
   * Only while the caller has heard nothing on this turn and is not talking,
   * and never ahead of a goodbye. Returns what was said, or null.
   */
  private ackSilentSave(session: RealtimeCallSession): string | null {
    if (session.turnEndedAt === null || session.callerSpeaking || session.deferredTurns.length > 0) return null;
    const said = this.playFiller(session, false, 'detail');
    if (said === null) return null;
    if (session.timing) session.timing.ackAt = Date.now();
    // The wait is covered: no second filler before the reply.
    if (session.fillerTimer) {
      clearTimeout(session.fillerTimer);
      session.fillerTimer = null;
    }
    return said;
  }

  /**
   * The model has begun a tool call. For a save with nothing said before it,
   * the recorded ack is played now: the earliest moment it is known that
   * this reply will say nothing. On a live run the call was not finished
   * until some 600 ms later, and the caller waited that out in silence.
   */
  private toolCallStarted(session: RealtimeCallSession, responseId: string, name: string | null): void {
    if (name !== TOOL.UPDATE || session.closed || session.ending || session.staleResponses.has(responseId)) return;
    if (session.savedAck?.responseId === responseId) return;
    // The model spoke first in this reply: the caller has their ack.
    for (const item of session.items.values()) if (item.responseId === responseId && item.bytesReceived > 0) return;
    const text = this.ackSilentSave(session);
    if (text !== null) session.savedAck = { responseId, text };
  }

  /**
   * A filler that fits what the caller just said, when their words are
   * known: on the real call of 12 October "Can you help me?" was met with
   * "Mm-hm.", as if it had not been heard.
   */
  private fillerKind(session: RealtimeCallSession): FillerKind {
    const kind = this.turnWords(session)?.kind;
    if (kind === 'question' || kind === 'small_talk') return 'question';
    if (kind === 'detail') return 'detail';
    return 'turn';
  }

  /**
   * Something brief was said while the receptionist was talking. Once the
   * caller has heard the rest and the words are known: an acknowledgement
   * ("okay", "uh-huh") gets no reply, since replying would repeat the
   * question; anything else — or anything after a question — is answered.
   */
  private answerDeferred(socket: MediaSocket, session: RealtimeCallSession, waited = false): void {
    if (session.deferredTurns.length === 0 || session.closed) return;
    if (session.hold || session.playing || session.responding || session.toolsRunning) return;
    if (!waited && !session.deferredTurns.every((id) => session.callerText.has(id))) {
      // Transcription can lag by seconds. The caller is waiting: answer
      // without the words rather than leave a long silence.
      session.deferredTimer ??= setTimeout(() => {
        session.deferredTimer = null;
        this.answerDeferred(socket, session, true);
      }, OVERLAP_TRANSCRIPT_WAIT_MS);
      return;
    }
    if (session.deferredTimer) {
      clearTimeout(session.deferredTimer);
      session.deferredTimer = null;
    }

    const known = session.deferredTurns.every((id) => session.callerText.has(id));
    const ids = session.deferredTurns.splice(0);
    const said = ids
      .map((id) => session.callerText.get(id))
      .filter((text): text is string => Boolean(text))
      .join(' ')
      .trim();
    if (known && said && this.judge) {
      void this.judgeOverlap(socket, session, said);
      return;
    }
    this.settleOverlap(socket, session, said, known);
  }

  /**
   * The judge reads the words against what the receptionist was saying. A
   * clear answer is answered, a clear acknowledgement is left alone, and
   * anything in between goes to the word lists. If the caller speaks again
   * while the judge is thinking, that turn is the one that gets answered.
   */
  private async judgeOverlap(socket: MediaSocket, session: RealtimeCallSession, said: string): Promise<void> {
    const turnBefore = session.callerTurn;
    const started = Date.now();
    let answers: number | null = null;
    try {
      answers = (await this.judge!.judgeOverlap(said, session.lastReplyText))?.overlap?.answers ?? null;
    } catch {
      answers = null;
    }
    if (session.closed || session.callerTurn !== turnBefore) return;

    const decision =
      answers === null
        ? 'no judgment: word lists decide'
        : answers >= OVERLAP_ANSWER_FLOOR
          ? 'answer'
          : answers <= OVERLAP_ACKNOWLEDGEMENT_CEILING
            ? 'no reply'
            : 'unsure: word lists decide';
    this.logEvent(session, CallEventType.OVERLAP_DECIDED, { said, by: 'judge', answers, ms: Date.now() - started, decision });
    if (answers !== null && answers >= OVERLAP_ANSWER_FLOOR) {
      this.startTurn(session, { overlap: said });
    } else if (answers !== null && answers <= OVERLAP_ACKNOWLEDGEMENT_CEILING) {
      this.noReplyNeeded(socket, session, said);
    } else {
      this.settleOverlap(socket, session, said, true);
    }
  }

  /** The word lists: "hello?" and "uh-huh" were settled by hearing the reply; anything else is answered. */
  private settleOverlap(socket: MediaSocket, session: RealtimeCallSession, said: string, known: boolean): void {
    const askedQuestion = /\?\s*$/.test(session.lastReplyText.trim());
    // "Hello?" while the reply was on its way: hearing the reply answered it.
    const settledByReply = isPresenceCheck(said) || (isBackchannel(said) && !askedQuestion);
    const noReply = known && (!said || settledByReply);
    this.logEvent(session, CallEventType.OVERLAP_DECIDED, {
      said,
      by: 'word lists',
      decision: noReply ? 'no reply' : 'answer',
      why: !known
        ? 'words not transcribed in time'
        : !said
          ? 'no words'
          : isPresenceCheck(said)
            ? 'a check of the line, answered by hearing the reply'
            : settledByReply
              ? 'an acknowledgement'
              : askedQuestion && isBackchannel(said)
                ? 'an acknowledgement after a question, which may be the answer'
                : 'not an acknowledgement',
    });

    if (noReply) {
      this.noReplyNeeded(socket, session, said);
      return;
    }
    this.startTurn(session, { overlap: said || undefined });
  }

  private noReplyNeeded(socket: MediaSocket, session: RealtimeCallSession, said: string): void {
    this.logger.log(`Call ${session.callId}: caller said "${said || '(nothing clear)'}" over the receptionist; no reply needed`);
    session.turnEndedAt = null;
    this.checkIdle(socket, session);
  }

  /**
   * The receptionist's own words arriving as caller speech: the phone fed its
   * speaker back into its microphone, or the transcriber invented a line. Not
   * something the caller said, so not recorded and not answered.
   */
  private isEcho(session: RealtimeCallSession, text: string): boolean {
    const heard = comparable(text);
    if (heard.split(' ').length < ECHO_MIN_WORDS) return false;
    const own = [session.greeting ?? '', ...[...session.items.values()].map((item) => item.text)]
      .map(comparable)
      .filter(Boolean);
    return own.some((line) => line === heard || line.includes(heard));
  }

  /* ------------------------------------------------------------------------ */
  /*  Assistant audio and playback                                            */
  /* ------------------------------------------------------------------------ */

  private item(session: RealtimeCallSession, itemId: string): AssistantItem {
    let item = session.items.get(itemId);
    if (!item) {
      item = {
        id: itemId,
        responseId: session.currentResponseId,
        text: '',
        chunks: [],
        bytesReceived: 0,
        bytesSent: 0,
        bytesPlayed: 0,
        generated: false,
        stopped: null,
        settled: false,
        synthetic: false,
      };
      session.items.set(itemId, item);
      this.expectLine(session, 'ai', itemId);
      // The caller turn this is said in reply to, so the reply can be judged against that turn's line.
      const line = session.lines.find((l) => l.key === itemId);
      if (line && session.callerTurn > 0) line.turn = session.callerTurn;
    }
    return item;
  }

  /** Part of a reply that arrived after the call began ending. It is dropped unheard. */
  private dropIfStale(session: RealtimeCallSession, item: AssistantItem): boolean {
    if (!item.responseId || !session.staleResponses.has(item.responseId)) return false;
    item.stopped ??= 'stale';
    return true;
  }

  private forwardAudio(socket: MediaSocket, session: RealtimeCallSession, itemId: string, audio: Buffer): void {
    const item = this.item(session, itemId);
    if (this.dropIfStale(session, item)) return;
    // The first audio of a reply asked for on this turn: the model's share of the wait.
    if (item.bytesReceived === 0 && item.responseId) {
      const timed = session.timing?.replies.find((reply) => reply.responseId === item.responseId);
      if (timed && timed.audioAt === undefined) timed.audioAt = Date.now();
    }
    item.chunks.push(audio);
    item.bytesReceived += audio.length;
    // Audio still arriving for a stopped reply must not reach the caller.
    if (item.stopped || session.closed || !session.streamSid || socket.readyState !== socket.OPEN) return;
    // Held back while playback is paused for the caller's speech; sent when
    // the hold ends. A hold that is only watching a short sound holds nothing.
    if (session.hold?.paused && !session.hold.resumed) return;
    this.sendAudio(socket, session, item, audio);
  }

  /** Sends audio for `item` to Twilio, with marks so playback can be tracked. */
  private sendAudio(socket: MediaSocket, session: RealtimeCallSession, item: AssistantItem, audio: Buffer): void {
    if (audio.length === 0) return;
    if (!item.synthetic && session.turnEndedAt !== null) {
      const now = Date.now();
      const afterTurnMs = now - session.turnEndedAt;
      session.latencies.push(afterTurnMs);
      item.wait = { afterTurnMs };
      if (session.lastSoundAt !== null) {
        // Twilio plays in order: a filler still playing is heard out first.
        const afterLastSoundMs = now - session.lastSoundAt + this.unplayedMs(session);
        session.heardAfter.push(afterLastSoundMs);
        item.wait.afterLastSoundMs = afterLastSoundMs;
        session.lastSoundAt = null;
      }
      session.turnEndedAt = null;
      // The reply is here: no filler needed for this turn.
      if (session.fillerTimer) {
        clearTimeout(session.fillerTimer);
        session.fillerTimer = null;
      }
    }

    let sinceMark = 0;
    for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
      const frame = audio.subarray(offset, offset + FRAME_BYTES);
      socket.send(
        JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: frame.toString('base64') } }),
      );
      item.bytesSent += frame.length;
      sinceMark += frame.length;
      if (sinceMark >= MARK_EVERY_BYTES) {
        this.mark(socket, session, item);
        sinceMark = 0;
      }
    }
    if (sinceMark > 0) this.mark(socket, session, item);
  }

  /** Audio sent to Twilio and not yet played, by the marks echoed so far. */
  private unplayedMs(session: RealtimeCallSession): number {
    let bytes = 0;
    for (const item of session.items.values()) {
      if (!item.stopped && !item.settled) bytes += Math.max(0, item.bytesSent - item.bytesPlayed);
    }
    return Math.round(bytes / BYTES_PER_MS);
  }

  /** Twilio echoes each mark when playback reaches it: that is what "heard" means. */
  private mark(socket: MediaSocket, session: RealtimeCallSession, item: AssistantItem): void {
    const name = `p${++session.markCounter}`;
    session.marks.set(name, { itemId: item.id, bytes: item.bytesSent });
    socket.send(JSON.stringify({ event: 'mark', streamSid: session.streamSid, mark: { name } }));
  }

  /** Sends what the caller has not heard yet of `item`, after a pause. */
  private sendUnheard(socket: MediaSocket, session: RealtimeCallSession, item: AssistantItem): void {
    if (item.bytesSent >= item.bytesReceived) return;
    const all = Buffer.concat(item.chunks);
    this.sendAudio(socket, session, item, all.subarray(item.bytesSent));
  }

  private handleMark(socket: MediaSocket, session: RealtimeCallSession, name: string | undefined): void {
    const mark = name ? session.marks.get(name) : undefined;
    if (!name || !mark) return;
    session.marks.delete(name);

    const item = session.items.get(mark.itemId);
    // Twilio also echoes marks for audio discarded by `clear`; those were not heard.
    if (!item || item.stopped) return;
    item.bytesPlayed = Math.max(item.bytesPlayed, mark.bytes);
    this.settleItem(session, item);
    this.checkIdle(socket, session);
  }

  private responseDone(socket: MediaSocket, session: RealtimeCallSession, response: RealtimeResponseSummary): void {
    const stale = session.staleResponses.has(response.id);
    // A greeting the model had to speak is recorded now, after it, for the next call.
    if (response.id === session.greetingResponseId && session.greeting && this.greetings) void this.greetings.record(session.greeting);
    session.responding = false;
    if (session.currentResponseId === response.id) session.currentResponseId = null;
    // Only a reply the caller could hear counts as the goodbye having been said.
    if (session.ending && !stale && response.status !== 'failed') session.responsesSinceEnding += 1;

    for (const item of session.items.values()) {
      if (item.responseId === response.id || item.responseId === null) {
        item.generated = true;
        this.settleItem(session, item);
      }
    }

    if (stale) {
      // Whatever it wanted to save or ask belongs to a call that is over.
      this.checkIdle(socket, session);
      return;
    }
    if (response.status === 'failed') {
      this.replyFailed(socket, session, response);
      return;
    }
    if (response.toolCalls.length === 0 && response.status === 'completed') this.recordUnsavedFollowUp(session, response.id);
    if (response.toolCalls.length > 0) {
      this.runTools(socket, session, response).catch((error: unknown) => this.abandon(session, 'a tool call', error));
    } else if (session.replanPending !== null && response.status === 'completed' && !session.ending) {
      // The reply under way when the backend took the caller's yes has
      // finished: the fresh plan now, so the call moves on.
      const answered = session.replanPending;
      session.replanPending = null;
      this.startTurn(session, { reason: 'judged-yes', answered });
    } else if (response.status === 'completed') {
      this.followBareAck(session, response.id);
    }
    this.checkIdle(socket, session);
  }

  /* ------------------------------------------------------------------------ */
  /*  Tools                                                                   */
  /* ------------------------------------------------------------------------ */

  private async runTools(socket: MediaSocket, session: RealtimeCallSession, response: RealtimeResponseSummary): Promise<void> {
    const execute = session.execute;
    if (!execute) return;
    session.toolsRunning = true;
    // A reply held for the caller's words is not asked for: these results go
    // back with the fresh state and a note quoting the words, and that reply
    // answers the turn, as for a turn that ends while tools run.
    if (session.wordsWait) {
      this.dropWordsWait(session);
      session.turnDuringTools = true;
    }

    try {
      const results: Array<{ callId: string; output: unknown }> = [];
      let ended = false;
      let latestState: IntakeSnapshot | undefined;
      const toolsStartedAt = Date.now();
      const timed = session.timing?.replies.find((reply) => reply.responseId === response.id);

      for (const call of response.toolCalls) {
        const result = await this.enqueue(session, () => execute(call.name, call.arguments));
        // A call the intake understood is in the trail already, with its result.
        if (!result || (result.plan === null && 'error' in result.output)) {
          this.logEvent(session, CallEventType.TOOL_CALL, {
            kind: call.name,
            args: call.arguments,
            understood: false,
            output: result?.output ?? { error: 'could not be saved' },
          });
        }
        if (!result) {
          results.push({ callId: call.callId, output: { error: 'That could not be saved. Carry on with the caller.' } });
          continue;
        }
        results.push({ callId: call.callId, output: result.output });
        ended ||= result.ended;
        if (result.plan) session.activePlan = result.plan;
        latestState = (result.output.state as IntakeSnapshot | undefined) ?? latestState;
        if (call.name === TOOL.BUSINESS && typeof result.output.fact === 'string' && result.output.fact.startsWith('Pricing')) {
          session.pricingAllowed = true;
        }
      }

      if (timed) timed.toolsMs = Date.now() - toolsStartedAt;
      if (ended) this.beginEnding(socket, session);
      const callerSpokeMeanwhile = session.turnDuringTools;
      session.turnDuringTools = false;
      if (!session.closed) {
        // Anything the model said in the same breath as the tool call, so the
        // reply to the results carries on from it instead of saying it again.
        const spoken = [...session.items.values()]
          .filter((item) => item.responseId === response.id && !item.stopped && item.text.trim())
          .map((item) => item.text.trim())
          .join(' ');
        // Saved in silence: a recorded ack covers the reply still to come. It
        // was played as the tool call began, if OpenAI named the tool then.
        const acked = session.savedAck?.responseId === response.id ? session.savedAck.text : null;
        const saved = response.toolCalls.some((call) => call.name === TOOL.UPDATE);
        const alreadySaid = [acked, spoken].filter(Boolean).join(' ') || (saved && !ended ? (this.ackSilentSave(session) ?? '') : '');
        // The read-back is spoken word for word from the backend's summary:
        // it is what the caller is confirming, so the model may not rephrase it.
        const readBackLine =
          latestState && !ended && latestState.nextAction === 'CONFIRM_DETAILS' && latestState.readBack
            ? exactLineInstructions(renderReadBack(latestState.readBack))
            : undefined;
        const readBack = readBackLine ? this.rightNow(session, { instructions: readBackLine, toolChoice: 'none', reason: 'read-back' }) : undefined;
        // The caller said yes and the model completed the request: the
        // goodbye is said word for word, as when the backend takes the yes.
        const goodbyeLine =
          ended && response.toolCalls.some((call) => call.name === TOOL.COMPLETE) ? exactLineInstructions(confirmedGoodbyeLine(latestState)) : undefined;
        // The model asked a question in the same breath as the save, and the
        // caller heard it: they are answering it. Another question now is two
        // in a row, as on a real call ("what exactly happened?" then "where is
        // the vehicle?"). Their answer starts the next turn, under the fresh
        // plan. Safety advice and the read-back are never left for later, and
        // a caller who spoke while the tools ran is answered.
        const question = !ended && !readBack && !callerSpokeMeanwhile ? questionWithSave(alreadySaid, latestState, session.activePlan) : null;
        // A stray question the caller has heard to the end is theirs to
        // answer: stopping it now stops nothing, and another after it is two in a row.
        const heardOut =
          question?.verdict === 'stray' &&
          latestState !== undefined &&
          PUTS_A_QUESTION.test(latestState.nextAction) &&
          this.playedInFull(session, response.id);
        const caller = question?.verdict === 'fits' || heardOut;
        if (caller) {
          this.logger.log(`Call ${session.callId}: the caller is answering "${alreadySaid}"; no second question`);
          // Asked under the plan before the save; it is the fresh plan's question that was put.
          if (latestState && COUNTED_ASK.test(latestState.nextAction)) session.asks.set(response.id, { action: latestState.nextAction, turn: session.callerTurn });
        }
        // The save changed what comes next (a value refused, a danger found),
        // and the question asked with it has to give way: what is left of it
        // is stopped, and the reply to the results follows the fresh plan.
        const stray =
          question?.verdict === 'stray' && !heardOut && session.activePlan
            ? this.stopStrayQuestion(socket, session, response.id, question.asked, session.activePlan)
            : false;
        // The caller's words, transcribed by now on any ordinary turn. This is
        // how a line that gives a detail and also asks something ("I'm at exit
        // 42, how long will it take?") has its question answered after the save.
        const words = this.turnWords(session);
        const noteOptions: ActionNoteOptions = {
          // A stray question is covered by its own note: it was stopped, not left for the caller to answer.
          ...(alreadySaid && !stray ? { alreadySaid } : {}),
          ...(words ? { callerJustSaid: words } : {}),
        };
        const note = latestState && !ended ? buildActionNote(latestState, noteOptions) : undefined;
        if (note && latestState) session.pinned = { state: latestState, options: noteOptions, turn: session.callerTurn };
        // The reply to a tool that ended the call is the goodbye, unless it has been asked for already.
        const asked = ended
          ? session.goodbyeRequested
            ? null
            : goodbyeLine
              ? this.rightNow(session, { instructions: goodbyeLine, toolChoice: 'none', reason: 'tool-results-goodbye' })
              : { reason: 'tool-results-goodbye' }
          : caller
            ? null
            : (readBack ?? { reason: 'tool-results' });
        const request = asked ? this.numbered(session, asked) : null;
        // The fresh state goes with these results: no change of plan is left to deliver.
        if (note) session.replanPending = null;
        // The note carries the state, and is replaced each turn; a copy in
        // every tool result would stay in the conversation for the whole call.
        const lean = note ? results.map((result, i) => (response.toolCalls[i]?.name === TOOL.STATE ? result : withoutState(result))) : results;
        session.conversation?.submitToolResults(lean, note, request);
        if (note) {
          this.logEvent(session, CallEventType.MODEL_NOTE, {
            kind: 'state',
            pinned: true,
            action: latestState?.nextAction,
            text: note,
            toolOutputs: lean.map((result) => result.output),
          });
        }
        if (request) {
          const oneOff = ended ? goodbyeLine : readBackLine;
          this.logEvent(session, CallEventType.REPLY_REQUESTED, {
            reason: request.reason ?? 'tool-results',
            ...(oneOff ? { toolChoice: 'none', instructions: oneOff } : {}),
          });
          this.owe(session);
        }
      }
    } finally {
      session.toolsRunning = false;
    }
  }

  /**
   * The first reply to a turn was an ack and nothing else: no save, no
   * question. The caller, who has just answered a question, would then hear
   * nothing more until the silence check seven seconds later. The reply is asked for again, once per caller turn, with
   * the ack quoted as already said. Tools stay allowed: the detail can still
   * be saved. Only for a line that may carry an answer, and only when a
   * question is what comes next: after "hold on" or a sentence cut off, an
   * ack and a wait is the right reply. True if a reply was asked for.
   */
  private followBareAck(session: RealtimeCallSession, responseId: string): boolean {
    if (session.closed || session.ending || session.ackFollowedTurn === session.callerTurn) return false;
    if (session.responseReasons.get(responseId) !== 'caller-turn') return false;
    const pinned = session.pinned;
    if (!pinned || pinned.turn !== session.callerTurn || !ONLY_THE_MODEL_SAVES.test(pinned.state.nextAction)) return false;
    // The caller is talking again, has asked for a moment, or something else is about to answer the turn.
    if (session.hold || session.callerSpeaking || session.patient || session.wordsWait || session.replanPending !== null || session.deferredTurns.length > 0) return false;
    const said = [...session.items.values()]
      .filter((item) => item.responseId === responseId && !item.stopped && item.text.trim())
      .map((item) => item.text.trim())
      .join(' ');
    if (!said || said.includes('?') || said.split(/\s+/).length > BARE_ACK_MAX_WORDS) return false;
    const words = this.turnWords(session);
    if (!words || !MAY_BE_AN_ANSWER.includes(words.kind)) return false;

    session.ackFollowedTurn = session.callerTurn;
    this.logger.warn(`Call ${session.callId}: the reply was only "${said}", with nothing saved or asked; asking for the rest`);
    const options: ActionNoteOptions = { ...pinned.options, alreadySaid: said };
    this.note(session, 'state', buildActionNote(pinned.state, options), { pinned: true, action: pinned.state.nextAction });
    session.pinned = { ...pinned, options };
    this.request(session, { reason: 'after-ack' }, undefined, { said: words.text, kind: words.kind });
    return true;
  }

  /**
   * The next question was asked in a reply that saved nothing. The live check
   * lets that question through, since it is the one to ask with the save, so
   * a reply that asks it and skips the save is not stopped. It is recorded,
   * so a call or an eval run shows how often the answer went unsaved.
   */
  private recordUnsavedFollowUp(session: RealtimeCallSession, responseId: string): void {
    const plan = session.activePlan;
    const next = plan?.ifAnswered;
    if (!plan || !next || session.ending) return;
    const said = [...session.items.values()]
      .filter((item) => item.responseId === responseId && !item.stopped && item.text.trim())
      .map((item) => item.text.trim())
      .join(' ');
    const question = questionsIn(said).find((q) => q.topics.includes(next.topic) && !(plan.topic && q.topics.includes(plan.topic)));
    if (!question) return;
    this.logger.warn(`Call ${session.callId}: asked the question after ${plan.action} without saving an answer to it: "${question.text}"`);
    this.logEvent(session, CallEventType.ACTION_DEVIATION, { asked: next.topic, question: question.text, required: plan.action, redirected: false, unsaved: true });
  }

  /** Everything a reply said has been played to the caller, to the end. */
  private playedInFull(session: RealtimeCallSession, responseId: string): boolean {
    const items = [...session.items.values()].filter((item) => item.responseId === responseId && item.text.trim());
    return items.length > 0 && items.every((item) => item.settled && !item.stopped);
  }

  /**
   * Stops what is left of a question asked in the same reply as a save, when
   * the save changed what comes next, and tells the model so. Once per caller
   * turn, like any other redirect. True if the question was stopped.
   */
  private stopStrayQuestion(socket: MediaSocket, session: RealtimeCallSession, responseId: string, asked: Topic, plan: NextActionPlan): boolean {
    if (session.redirectedThisTurn) return false;
    session.redirectedThisTurn = true;
    const items = [...session.items.values()].filter((item) => item.responseId === responseId && item.text.trim());
    for (const item of items) {
      if (!item.stopped && !item.settled) this.stopSpeaking(socket, session, 'redirected', item);
    }
    // Read once stopped: marks for audio discarded by the stop no longer count.
    const heard = items.map((item) => (item.stopped ? heardPortion(item.text, item.bytesPlayed, item.bytesReceived) : item.text.trim())).filter(Boolean).join(' ');
    const question = items.map((item) => item.text.trim()).join(' ');
    this.logger.warn(`Call ${session.callId}: asked about ${asked} with a save that made ${plan.action} the next step: "${question}"`);
    this.logEvent(session, CallEventType.ACTION_DEVIATION, { asked, question, required: plan.action, redirected: true, heard, afterSave: true });
    this.note(session, 'redirect', redirectNote(asked, plan, heard));
    return true;
  }

  /**
   * The model is lost: it never connected, went away, or has stopped
   * replying. Recorded before the stream closes, so that the webhook Twilio
   * calls next can tell this ending from any other and apologise; then the
   * call is finalised as a technical failure, which always leaves the towing
   * team a callback with the caller's number.
   */
  private fail(session: RealtimeCallSession, why: string): void {
    if (session.closed || session.failure) return;
    session.failure = why;
    this.logger.error(`Call ${session.callId}: ${why}; ending the call.`);
    void this.enqueue(session, () => this.recordProviderError(session, 'fatal', why)).finally(() => {
      if (session.socket.readyState === session.socket.OPEN) session.socket.close();
      else this.teardown(session).catch(() => undefined);
    });
  }

  /** The backend has ended the call. Let the model say goodbye, then hang up. */
  private beginEnding(socket: MediaSocket, session: RealtimeCallSession): void {
    if (session.ending) return;
    session.ending = true;
    session.responsesSinceEnding = 0;
    // Replaces the last action note, which may still say to ask something.
    this.note(session, 'state', ENDING_NOTE, { pinned: true, action: 'CLOSE' });
    session.pinned = null;
    // Only the goodbye is wanted now.
    this.dropWordsWait(session);
    this.clearNoInputTimer(session);
    session.endTimer = setTimeout(() => socket.close(), GOODBYE_LIMIT_MS);
  }

  /* ------------------------------------------------------------------------ */
  /*  Barge-in and live checks                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * The caller started talking. A reply they are hearing plays on: the hold
   * only watches, and playback is paused once the sound has gone on past
   * PLAY_THROUGH_VOICED_MS (judgeHold). Stopped at every onset, a 200 ms
   * sound put a 605 ms hole in the safety line on a real call (5176f4be).
   * The reply is kept either way until it is clear whether they are taking
   * the floor or just acknowledging. Fires on every speech onset, so it must
   * be cheap.
   */
  private interrupt(socket: MediaSocket, session: RealtimeCallSession): void {
    this.clearNoInputTimer(session);
    if (session.closed || (session.hold && !session.hold.resumed)) return;
    if (!session.playing && !session.responding) return;

    if (session.hold?.timer) clearTimeout(session.hold.timer);
    const nothingHeard = !session.playing;
    // A reply the caller has heard none of has no sentence to cut a hole in,
    // and must not start on top of them: it is held back from the first sound.
    if (nothingHeard) this.pausePlayback(socket, session);
    const startedAt = Date.now();
    session.hold = {
      startedAt,
      gauge: new SpeechGauge(undefined, session.voice.minVoicedRms),
      timer: setTimeout(() => this.holdExpired(socket, session), HOLD_MAX_MS),
      paused: nothingHeard,
      pausedAt: nothingHeard ? startedAt : null,
      resumed: false,
      nothingHeard,
    };
  }

  /** Stops playback where the caller has heard it to. What they have not heard is kept, to be sent again or dropped. */
  private pausePlayback(socket: MediaSocket, session: RealtimeCallSession): void {
    if (session.streamSid && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    // Twilio echoes the marks of cleared audio; they must not count as heard.
    session.marks.clear();
    for (const item of session.items.values()) {
      if (!item.stopped && !item.settled) item.bytesSent = item.bytesPlayed;
    }
  }

  /** The caller is still talking after the longest pause allowed: decide now. */
  private holdExpired(socket: MediaSocket, session: RealtimeCallSession): void {
    const hold = session.hold;
    if (!hold) return;
    hold.timer = null;
    // Paused for them, and they are still making sound a second later, with
    // OpenAI still hearing speech: they have the floor, however much of that
    // second counted as voice. On a real call (8b6ae0a9) a caller's sentence
    // measured 540 ms voiced when the timer ran out; the reply carried on and
    // talked over the other three seconds of it.
    const stillTalking = hold.paused && session.callerSpeaking && hold.gauge.trailingSilenceMs < HOLD_RESUME_SILENCE_MS;
    if (hold.gauge.voicedMs < BARGE_IN_VOICED_MS && !(stillTalking && !hold.nothingHeard)) this.endHold(socket, session, 'resume', 'timer');
    else if (!hold.nothingHeard) this.endHold(socket, session, 'interrupt', 'timer');
    // else: keep holding an unheard reply until the caller's turn ends.
  }

  /** Every frame of caller audio while a hold is on: is this more than a short sound, and is it an interruption yet? */
  private judgeHold(socket: MediaSocket, session: RealtimeCallSession, frame: Buffer): void {
    const hold = session.hold;
    if (!hold) return;
    hold.gauge.feed(frame);

    if (hold.gauge.voicedMs >= BARGE_IN_VOICED_MS) {
      if (!hold.nothingHeard) this.endHold(socket, session, 'interrupt', 'gauge');
    } else if (hold.gauge.trailingSilenceMs >= HOLD_RESUME_SILENCE_MS) {
      if (!hold.resumed) this.endHold(socket, session, 'resume', 'gauge');
      // Watching after a resume: a new burst starts from zero, so "Hello.
      // ... Hello." never adds up to an interruption.
      else if (hold.gauge.voicedMs > 0) hold.gauge = new SpeechGauge(hold.gauge.floor, hold.gauge.minVoicedRms);
    } else if (!hold.paused && !hold.resumed && hold.gauge.voicedMs >= PLAY_THROUGH_VOICED_MS) {
      // More than a short sound: stop talking over it while it is judged.
      hold.paused = true;
      hold.pausedAt = Date.now();
      this.pausePlayback(socket, session);
    } else if (hold.resumed && hold.gauge.voicedMs >= PLAY_THROUGH_VOICED_MS && session.playing) {
      // They carried on after all, and the reply is playing over them: it is
      // paused again and judged afresh. Left to reach an interruption in one
      // unbroken burst, a slow speaker's sentence never did: on a real call
      // (09ba2f2a) the reply talked over four of them, each two seconds long.
      if (hold.timer) clearTimeout(hold.timer);
      hold.resumed = false;
      hold.paused = true;
      hold.nothingHeard = false;
      hold.startedAt = Date.now();
      hold.pausedAt = hold.startedAt;
      hold.timer = setTimeout(() => this.holdExpired(socket, session), HOLD_MAX_MS);
      this.pausePlayback(socket, session);
    }
  }

  /** OpenAI's own verdict on how long the caller spoke, once their turn ends. */
  private speechStopped(socket: MediaSocket, session: RealtimeCallSession, durationMs: number): void {
    const hold = session.hold;
    if (!hold) return;
    if (!hold.resumed) {
      const interrupt = durationMs >= BARGE_IN_VOICED_MS && !hold.nothingHeard;
      this.endHold(socket, session, interrupt ? 'interrupt' : 'resume', 'speech_stopped', durationMs);
    } else if (durationMs >= TALKED_OVER_MS) {
      // The reply carried on, and OpenAI heard the caller speaking all along:
      // the receptionist talked over them. Recorded, so a call shows it.
      this.logger.warn(`Call ${session.callId}: talked over ${durationMs}ms of caller speech after judging it brief`);
      this.logEvent(session, CallEventType.TALKED_OVER, {
        spokenMs: durationMs,
        voicedMs: Math.round(hold.gauge.voicedMs),
        loudestRms: Math.round(hold.gauge.loudestRms),
        minVoicedRms: hold.gauge.minVoicedRms,
      });
    }
    session.hold = null;
  }

  /**
   * `via`: what decided: the caller's voiced audio so far (`gauge`), the
   * longest pause allowed (`timer`), OpenAI's measure of the turn
   * (`speech_stopped`, with `spokenMs`), or the turn ending first.
   */
  private endHold(
    socket: MediaSocket,
    session: RealtimeCallSession,
    outcome: 'interrupt' | 'resume',
    via: 'gauge' | 'timer' | 'speech_stopped' | 'turn_ended',
    spokenMs?: number,
  ): void {
    const hold = session.hold;
    if (!hold) return;
    if (hold.timer) clearTimeout(hold.timer);
    const holdMs = Date.now() - hold.startedAt;
    const decided = {
      holdMs,
      voicedMs: Math.round(hold.gauge.voicedMs),
      ...(spokenMs !== undefined ? { spokenMs } : {}),
      via,
      // How loud the caller came through, against what counted as their voice.
      loudestRms: Math.round(hold.gauge.loudestRms),
      minVoicedRms: hold.gauge.minVoicedRms,
    };

    if (outcome === 'interrupt') {
      session.hold = null;
      const stopped = this.stopSpeaking(socket, session, 'interrupted');
      if (stopped.length > 0) {
        const cut = stopped[0]!;
        this.logEvent(session, CallEventType.AI_INTERRUPTED, {
          heardMs: heardMs(cut),
          text: cut.text,
          heard: heardPortion(cut.text, cut.bytesPlayed, cut.bytesReceived),
          ...decided,
        });
      }
      // A read-back the caller spoke over has not been heard. The backend has
      // it finished once, after what they said is answered; without this it
      // would wait for a yes to details the caller never heard.
      const readBack = stopped.find((item) => item.responseId && session.readBacks.has(item.responseId));
      if (readBack && session.businessId && session.callId) {
        const { businessId, callId } = session;
        const heard = heardPortion(readBack.text, readBack.bytesPlayed, readBack.bytesReceived);
        void this.enqueue(session, () => this.callSession.applyIntakeOperation(businessId, callId, { kind: 'read_back_cut', heard }));
      }
      // A question stopped before the caller heard it was not asked. On a
      // real call "Where is the vehicle right now?", cut with nothing heard,
      // was one of the three asks after which the location was given up.
      const ask = stopped.find((item) => item.responseId && session.asks.has(item.responseId));
      if (ask && session.businessId && session.callId && ask.text.includes('?')) {
        const heard = heardPortion(ask.text, ask.bytesPlayed, ask.bytesReceived);
        const { action, turn } = session.asks.get(ask.responseId!)!;
        if (!heard.includes('?')) this.takeBack(session, action, turn);
      }
      return;
    }

    // Brief: carry on from where the caller stopped hearing, and keep watching
    // in case they were only drawing breath before taking the floor. A sound
    // too short to pause for stopped nothing, so nothing is sent again; it is
    // still a turn of the caller's, and one that may need no reply.
    hold.timer = null;
    hold.resumed = true;
    hold.gauge = new SpeechGauge(hold.gauge.floor, hold.gauge.minVoicedRms);
    session.overlapPending = true;
    if (hold.paused && !hold.nothingHeard) session.pauses += 1;
    let resumedMs = 0;
    for (const item of session.items.values()) {
      if (item.stopped || item.settled) continue;
      resumedMs += (item.bytesReceived - item.bytesSent) / BYTES_PER_MS;
      this.sendUnheard(socket, session, item);
    }
    // `holdMs` runs from the onset of the sound; the gap the caller heard in
    // the reply began only when playback stopped.
    const pausedMs = hold.pausedAt === null ? null : Date.now() - hold.pausedAt;
    if (pausedMs !== null) {
      this.logger.log(`Call ${session.callId}: paused ${pausedMs}ms for brief caller speech, resumed ${Math.round(resumedMs)}ms of reply`);
    } else {
      this.logger.log(`Call ${session.callId}: played through ${decided.voicedMs}ms of brief caller speech`);
    }
    this.logEvent(session, CallEventType.HOLD_RESUMED, {
      ...decided,
      resumedMs: Math.round(resumedMs),
      nothingHeard: hold.nothingHeard,
      ...(pausedMs !== null ? { pausedMs } : { playedThrough: true }),
    });
    this.checkIdle(socket, session);
  }

  /**
   * Stops everything not yet heard: the response being generated, Twilio's
   * buffer, and the model's memory of the unheard part.
   */
  private stopSpeaking(socket: MediaSocket, session: RealtimeCallSession, reason: StopReason, only?: AssistantItem): AssistantItem[] {
    if (session.responding) session.conversation?.cancelResponse();

    const stopped: AssistantItem[] = [];
    for (const item of only ? [only] : [...session.items.values()]) {
      if (item.stopped || item.settled) continue;
      item.stopped = reason;
      if (!item.synthetic) session.conversation?.truncate(item.id, item.bytesPlayed / BYTES_PER_MS);
      stopped.push(item);
    }

    if (session.streamSid && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    for (const item of stopped) this.settleItem(session, item);
    return stopped;
  }

  /** The model's words, checked as they are produced. */
  private monitorSpeech(socket: MediaSocket, session: RealtimeCallSession, itemId: string, text: string): void {
    const item = this.item(session, itemId);
    if (this.dropIfStale(session, item)) return;
    if (item.stopped) return;
    item.text = text;

    if (this.checkGuardrails(socket, session, item, text)) return;
    this.checkRequiredAction(socket, session, item, text);
  }

  /** Prices, arrival times, dispatch, availability. True if the reply was stopped. */
  private checkGuardrails(socket: MediaSocket, session: RealtimeCallSession, item: AssistantItem, text: string): boolean {
    const verdict = checkReply(text, { allowPricing: session.pricingAllowed });
    if (verdict.ok) return false;
    // Length is not a safety matter for a free conversation.
    const violations = verdict.violations.filter((v) => v.code !== 'too_long');
    if (violations.length === 0) return false;

    this.stopSpeaking(socket, session, 'guardrail', item);
    session.guardrailTrips += 1;
    const attempt = session.guardrailTrips;
    // Read once stopped: marks for audio discarded by the stop no longer count.
    const heard = heardPortion(text, item.bytesPlayed, item.bytesReceived);

    this.logger.warn(`Call ${session.callId}: stopped a reply that ${violations.map((v) => v.detail).join(', ')}: "${text}"`);
    this.logEvent(session, CallEventType.GUARDRAIL_TRIPPED, {
      pipeline: 'chatgpt',
      violations: violations.map((v) => v.code),
      suppressed: text,
      heard,
      heardMs: heardMs(item),
      attempt,
    });

    // First time, the model recovers in its own words. After that, a fixed line.
    // A goodbye that broke a rule is still the goodbye when it is said again.
    const suffix = session.ending ? '-goodbye' : '';
    if (violations[0]!.code === 'self_talk' && attempt <= 2) {
      // Nothing to retract: the model is told again, and carries on.
      this.note(session, 'self_talk_recovery', SELF_TALK_RECOVERY_INSTRUCTIONS);
      this.request(session, { reason: `self-talk-recovery${suffix}` });
    } else if (attempt === 1) {
      this.note(session, 'guardrail_recovery', guardrailRecoveryInstructions(violations[0]!.detail, heard));
      this.request(session, { reason: `guardrail-recovery${suffix}` });
    } else if (attempt === 2) {
      this.respond(session, {
        instructions: exactLineInstructions(SAFE_FALLBACK_LINE),
        toolChoice: 'none',
        reason: `guardrail-fallback${suffix}`,
      });
    }
    return true;
  }

  /**
   * A question about something the priority engine said must wait — the
   * callback number while the location is still "I-95" — is stopped and the
   * model redirected. Once per caller turn: a second deviation is logged only,
   * so a stubborn model costs a clumsy turn, never a loop.
   */
  private checkRequiredAction(socket: MediaSocket, session: RealtimeCallSession, item: AssistantItem, text: string): void {
    const plan = session.activePlan;
    if (!plan || session.ending) return;

    const check = checkReplyAgainstAction(text, plan);
    if (!check.deviation) return;

    const deviation = check.deviation;
    const redirect = !session.redirectedThisTurn;
    // Stopped first, so what the caller heard is read once nothing more can play.
    if (redirect) {
      session.redirectedThisTurn = true;
      this.stopSpeaking(socket, session, 'redirected', item);
    }
    const heard = redirect ? heardPortion(text, item.bytesPlayed, item.bytesReceived) : null;
    this.logger.warn(`Call ${session.callId}: asked about ${deviation.asked} while ${plan.action} was required: "${deviation.question}"`);
    this.logEvent(session, CallEventType.ACTION_DEVIATION, {
      asked: deviation.asked,
      question: deviation.question,
      required: plan.action,
      redirected: redirect,
      ...(redirect ? { heard, heardMs: heardMs(item) } : {}),
    });
    if (!redirect) return;

    // The backend took the caller's answer itself while this reply was under
    // way: the fresh plan is issued first, then the redirect.
    if (session.replanPending !== null) {
      const answered = session.replanPending;
      session.replanPending = null;
      this.startTurn(session, { reason: 'redirect', answered, redirect: { asked: deviation.asked, heard: heard ?? '' } });
      return;
    }
    this.note(session, 'redirect', redirectNote(deviation.asked, plan, heard ?? ''));
    this.request(session, { reason: 'redirect' });
  }

  /* ------------------------------------------------------------------------ */
  /*  Silence and ending                                                      */
  /* ------------------------------------------------------------------------ */

  /** Nothing is being said or prepared. Wait for the caller, or hang up. */
  private checkIdle(socket: MediaSocket, session: RealtimeCallSession): void {
    if (session.closed || session.responding || session.toolsRunning || session.playing) return;
    // The receptionist owes the caller a reply: the line is not idle, it is waiting on us.
    if (session.replyOwed) return;
    if (session.hold && !session.hold.resumed) return;

    if (session.ending) {
      if (session.responsesSinceEnding > 0) socket.close();
      return;
    }
    if (session.deferredTurns.length > 0) {
      this.answerDeferred(socket, session);
      return;
    }
    this.armNoInputTimer(socket, session);
  }

  private armNoInputTimer(socket: MediaSocket, session: RealtimeCallSession): void {
    this.clearNoInputTimer(session);
    if (session.closed) return;
    // A caller who asked for a moment is doing what they were asked: give
    // them one. Two checks seven seconds apart ended such calls before.
    const wait = session.patient ? PATIENT_NO_INPUT_MS : NO_INPUT_MS;
    session.noInputTimer = setTimeout(() => void this.handleSilence(socket, session), wait);
  }

  private clearNoInputTimer(session: RealtimeCallSession): void {
    if (session.noInputTimer) {
      clearTimeout(session.noInputTimer);
      session.noInputTimer = null;
    }
  }

  private async handleSilence(socket: MediaSocket, session: RealtimeCallSession): Promise<void> {
    if (session.closed || session.responding || session.replyOwed || session.ending || !session.businessId || !session.callId) return;
    const { businessId, callId } = session;
    const turnBefore = session.callerTurn;

    const result = await this.enqueue(session, () =>
      this.callSession.applyIntakeOperation(businessId, callId, { kind: 'silence' }),
    );
    if (!result || session.closed) return;
    // The caller spoke up while the silence was being counted: a check-in now
    // would land on top of their words, or just after the reply to them.
    if (session.callerTurn !== turnBefore || session.hold || session.responding || session.replyOwed || session.playing) return;

    if (result.ended) {
      this.beginEnding(socket, session);
      this.respond(session, { instructions: SILENCE_GOODBYE_INSTRUCTIONS, toolChoice: 'none', reason: 'silence-goodbye' });
    } else {
      this.respond(session, { instructions: exactLineInstructions(SILENCE_CHECK_LINE), toolChoice: 'none', reason: 'silence-check' });
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Transcript                                                              */
  /* ------------------------------------------------------------------------ */

  /** Reserves a transcript position at the moment the line is spoken. */
  private expectLine(session: RealtimeCallSession, speaker: PendingLine['speaker'], key: string): void {
    if (session.lines.some((line) => line.key === key)) return;
    const line: PendingLine = { speaker, key, text: null, ready: false };
    if (speaker === 'customer') {
      // A transcription that never arrives must not hold up every later line.
      line.timer = setTimeout(() => this.resolveLine(session, key, null, { drop: 'timeout' }), TRANSCRIPT_WAIT_MS);
    }
    session.lines.push(line);
  }

  /**
   * `drop`: why a caller line has no text, recorded so a line missing from
   * the transcript can be accounted for.
   */
  private resolveLine(
    session: RealtimeCallSession,
    key: string,
    text: string | null,
    extra: { heard?: string; drop?: 'timeout' | 'failed' | 'teardown' } = {},
  ): void {
    const line = session.lines.find((l) => l.key === key);
    if (!line || line.ready) return;
    if (line.timer) clearTimeout(line.timer);
    if (line.speaker === 'customer') {
      // What the transcriber wrote in another script is not what was said:
      // quoted to the model, it was saved as a location on a real call.
      const latin = text ? inLatinScript(text) : text;
      const otherScript = Boolean(text) && latin !== text;
      if (text && otherScript) {
        this.logger.warn(`Call ${session.callId}: the transcriber wrote "${text}" in another script; kept "${latin ?? ''}"`);
        this.logEvent(session, CallEventType.TRANSCRIPT_DROPPED, { speaker: 'customer', reason: 'script', text, kept: latin ?? '', turn: line.turn });
        text = latin;
      }
      if (text && this.isEcho(session, text)) {
        this.logger.warn(`Call ${session.callId}: ignoring the receptionist's own words heard back as caller speech: "${text}"`);
        this.logEvent(session, CallEventType.TRANSCRIPT_DROPPED, { speaker: 'customer', reason: 'echo', text, turn: line.turn });
        text = null;
      } else if (!text && !otherScript) {
        this.logEvent(session, CallEventType.TRANSCRIPT_DROPPED, { speaker: 'customer', reason: extra.drop ?? 'failed', turn: line.turn });
      }
    }
    line.text = text;
    if (extra.heard !== undefined) line.heard = extra.heard;
    line.ready = true;
    if (line.speaker === 'customer') {
      session.callerText.set(key, text);
      // The reply held for these words goes now, quoting them (without them, if they failed).
      if (session.wordsWait?.key === key) this.wordsWaitOver(session, session.wordsWait);
      // Read first: the overlap path can start the turn's reply at once.
      const deferred = session.deferredTurns.includes(key);
      if (deferred) this.answerDeferred(session.socket, session);
      if (text && line.turn !== undefined && line.turn === session.callerTurn) this.wordsKnown(session, text, deferred);
      // Their words arrive after their turn, sometimes after the reply has
      // played and the quiet is already being timed: then it is timed again.
      if (text && isAskingForTime(text)) {
        session.patient = true;
        if (session.noInputTimer) this.armNoInputTimer(session.socket, session);
      }
    }
    this.flushLines(session);
  }

  private callerTranscript(session: RealtimeCallSession, itemId: string, text: string | null): void {
    this.expectLine(session, 'customer', itemId);
    this.resolveLine(session, itemId, text);
  }

  /** An assistant line is final once played in full, or once stopped. */
  private settleItem(session: RealtimeCallSession, item: AssistantItem): void {
    if (item.settled) return;
    const playedInFull = item.generated && item.bytesSent >= item.bytesReceived && item.bytesPlayed >= item.bytesSent;
    if (!item.stopped && !playedInFull) return;
    item.settled = true;
    item.chunks.length = 0;

    let { text, heard } = transcriptLine(item);

    // The voice webhook already recorded the greeting it chose, so it is not
    // written again, even when the caller spoke over it: its words, which stop
    // being transcribed when it is cut off, are the greeting or the start of
    // it. A greeting the model reworded is still written.
    const isGreeting = item.responseId !== null && item.responseId === session.greetingResponseId;
    if (isGreeting && text && session.greeting && comparable(session.greeting).startsWith(comparable(item.text))) {
      text = null;
    }
    // Everything the receptionist said, played or not, and what asked for it.
    if (item.text.trim() || item.bytesReceived > 0) {
      const turn = session.lines.find((line) => line.key === item.id)?.turn;
      // What the caller heard asked on this turn: an ask they did not hear is taken back.
      if (!item.synthetic && turn !== undefined && heard) {
        const topics = questionsIn(heard).flatMap((question) => (question.topics.length > 0 ? question.topics : (['unplaced'] as const)));
        if (topics.length > 0) session.heardQuestions.set(turn, new Set([...(session.heardQuestions.get(turn) ?? []), ...topics]));
      }
      this.logEvent(session, CallEventType.AI_RESPONSE, {
        text: item.text.trim(),
        stopped: item.stopped,
        ...(item.stopped ? { heard } : {}),
        heardMs: heardMs(item),
        audioMs: Math.round(item.bytesReceived / BYTES_PER_MS),
        inReplyTo: isGreeting ? 'greeting' : item.synthetic ? 'filler' : ((item.responseId && session.responseReasons.get(item.responseId)) ?? null),
        ...(item.synthetic && !isGreeting ? { filler: true } : {}),
        ...(item.saveAck ? { ack: true } : {}),
        ...(isGreeting ? { greeting: true } : {}),
        ...(item.wait ?? {}),
        ...(turn !== undefined ? { turn } : {}),
      });
    }
    this.resolveLine(session, item.id, text, { heard });
  }

  /** Writes ready lines in speaking order. */
  private flushLines(session: RealtimeCallSession): void {
    while (session.lines[0]?.ready) {
      const line = session.lines.shift()!;
      if (!line.text || !session.businessId || !session.callId) continue;
      const { businessId, callId } = session;
      const text = line.text;

      if (line.speaker === 'ai') {
        void this.enqueue(session, () => this.callSession.appendAiTranscriptLine(businessId, callId, text));
        // Judged by what the caller heard: a reply stopped before its answer did not answer them.
        const heard = line.heard ?? text;
        if (line.turn !== undefined && heard) {
          // Everything said in reply to that turn so far: a few words, a lookup, then the answer.
          const said = [session.replies.get(line.turn), heard].filter(Boolean).join(' ');
          session.replies.set(line.turn, said);
          void this.judgeReply(session, said, line.turn);
        }
      } else {
        // The line's own turn, so the backend knows whether it is the caller's latest word.
        const turn = line.turn !== undefined ? { callerTurn: line.turn } : {};
        // Judged beside the call: every operation for a call runs in order,
        // and the next reply must not queue behind a judgment of the last line.
        void this.judgeLine(session, text, turn);
        void this.enqueue(session, async () => {
          const result = await this.callSession.applyIntakeOperation(businessId, callId, { kind: 'caller_speech', text }, { ...turn, judge: false });
          // The call has run past its turn limit: close it politely, and
          // hang up in any case once the goodbye has had its chance.
          if (result.ended && !session.ending && !session.closed) {
            this.beginEnding(session.socket, session);
            this.respond(session, {
              instructions: TURN_LIMIT_GOODBYE_INSTRUCTIONS,
              toolChoice: 'none',
              reason: 'turn-limit-goodbye',
            });
          }
        });
      }
    }
  }

  /**
   * Has the judge say whether what was said on a turn answered the caller,
   * where they had asked or complained. The backend reminds the model only of
   * what is known to have gone unanswered.
   */
  private async judgeReply(session: RealtimeCallSession, said: string, callerTurn: number): Promise<void> {
    if (!session.businessId || !session.callId) return;
    const { businessId, callId } = session;
    let judgment: Awaited<ReturnType<CallSessionService['judgeReply']>> = null;
    try {
      judgment = await this.callSession.judgeReply(businessId, callId, said, callerTurn);
    } catch {
      return;
    }
    if (!judgment || session.closed || session.ending) return;
    const op = judgment;
    void this.enqueue(session, () => this.callSession.applyIntakeOperation(businessId, callId, op, { callerTurn }));
  }

  /** Has the judge read a caller line, and folds what it found into the call once it has. */
  private async judgeLine(session: RealtimeCallSession, text: string, turn: { callerTurn?: number }): Promise<void> {
    if (!session.businessId || !session.callId) return;
    const { businessId, callId } = session;
    let judgment: Awaited<ReturnType<CallSessionService['judgeCallerLine']>> = null;
    try {
      judgment = await this.callSession.judgeCallerLine(businessId, callId, text);
    } catch {
      return;
    }
    if (!judgment || session.closed || session.ending) return;
    const op = judgment;
    const result = await this.enqueue(session, () => this.callSession.applyIntakeOperation(businessId, callId, op, turn));
    if (result) this.judged(session, result, text);
  }

  /**
   * The judgment of a caller line may have moved the call on: the backend
   * took a clear yes, to the number or to the read-back, that the model had
   * not saved. On two real calls the model asked again after each "yes".
   * The fresh plan reaches the model as soon as the caller can be spared a
   * reply made under the old one.
   */
  private judged(session: RealtimeCallSession, result: IntakeOperationResult, said: string): void {
    if (session.closed || session.ending) return;
    if (result.ended) {
      this.endOnConfirmation(session, result.output.state as IntakeSnapshot | undefined);
      return;
    }
    const plan = result.plan;
    if (!plan || !session.activePlan || plan.action === session.activePlan.action) return;
    // The tool results' reply carries the fresh state; a caller still talking will start a turn of their own.
    if (session.toolsRunning || session.hold) return;

    if (session.responding) {
      // Under way, perhaps already playing, perhaps the tool call that saves
      // this very answer. It runs on under the fresh plan's checks, so a
      // question about what is now settled is stopped; the plan follows it.
      session.activePlan = plan;
      session.replanPending = said;
      return;
    }
    if (session.replyOwed) {
      // Asked for and not started: the caller has heard none of it.
      session.supersededBelow = session.requestSeq + 1;
    } else if (/\?\s*$/.test(session.lastReplyText.trim())) {
      // The reply has been given, and asked something: the caller's answer
      // to it starts the next turn, under the fresh plan.
      return;
    }
    this.startTurn(session, { reason: 'judged-yes', answered: said });
  }

  /** The caller said yes to the read-back and the backend completed the request on it: the goodbye, once. */
  private endOnConfirmation(session: RealtimeCallSession, state: IntakeSnapshot | undefined): void {
    this.beginEnding(session.socket, session);
    // A reply under way that the caller has not heard is not needed now. One
    // asked for and not started is dropped when it starts, as for any ending.
    this.dropUnheardReply(session);
    if (!session.goodbyeRequested) {
      this.respond(session, { instructions: exactLineInstructions(confirmedGoodbyeLine(state)), toolChoice: 'none', reason: 'confirmed-goodbye' });
    }
  }

  /**
   * Drops the reply under way if the caller has heard none of it, keeping the
   * request queued behind it, which replaces it. True if a reply was dropped.
   * Its words so far are settled as never said: left alone, a reply cancelled
   * before its first audio was written to the transcript as if played in
   * full, and audio held back during a pause was sent when the pause ended.
   */
  private dropUnheardReply(session: RealtimeCallSession): boolean {
    const current = session.currentResponseId;
    if (!session.responding || current === null || session.staleResponses.has(current)) return false;
    const items = [...session.items.values()].filter((item) => item.responseId === current);
    if (items.some((item) => item.bytesSent > 0)) return false;
    // Stopped already (redirected, or by a guardrail): its cancel has been sent.
    if (items.length > 0 && items.every((item) => item.stopped)) return false;
    session.staleResponses.add(current);
    session.conversation?.cancelResponse({ keepQueued: true });
    for (const item of items) {
      item.stopped ??= 'stale';
      this.settleItem(session, item);
    }
    return true;
  }

  /* ------------------------------------------------------------------------ */
  /*  Plumbing                                                                */
  /* ------------------------------------------------------------------------ */

  /** Runs database work for this call in order. Resolves null if it failed. */
  private enqueue<T>(session: RealtimeCallSession, work: () => Promise<T>): Promise<T | null> {
    const run = session.ops.then(work).catch((error: unknown) => {
      this.logger.error(`Call ${session.callId}: ${error instanceof Error ? error.message : error}`);
      return null;
    });
    session.ops = run;
    return run;
  }

  private logEvent(session: RealtimeCallSession, type: CallEventType, payload: Record<string, unknown>): void {
    if (!session.businessId || !session.callId) return;
    const { businessId, callId } = session;
    // The caller turn it happened on, so the trail reads turn by turn.
    const stamped = payload.turn !== undefined ? payload : { ...payload, turn: session.callerTurn };
    void this.enqueue(session, () => this.callSession.logCallEvent(businessId, callId, type, stamped));
  }

  /** Leaves a trace in the call's event history, which outlives the API log. */
  private async recordProviderError(session: RealtimeCallSession, stage: string, message: string): Promise<void> {
    if (!session.businessId || !session.callId) return;
    await this.callSession.logCallEvent(session.businessId, session.callId, CallEventType.PROVIDER_ERROR, {
      provider: 'openai-realtime',
      stage,
      message,
    });
  }

  private async teardown(session: RealtimeCallSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;

    this.clearNoInputTimer(session);
    if (session.startTimer) clearTimeout(session.startTimer);
    if (session.limitTimer) clearTimeout(session.limitTimer);
    if (session.endTimer) clearTimeout(session.endTimer);
    if (session.deferredTimer) clearTimeout(session.deferredTimer);
    if (session.fillerTimer) clearTimeout(session.fillerTimer);
    if (session.stallTimer) clearTimeout(session.stallTimer);
    if (session.retryTimer) clearTimeout(session.retryTimer);
    if (session.hold?.timer) clearTimeout(session.hold.timer);
    session.hold = null;
    this.dropWordsWait(session);
    session.conversation?.close();
    session.liveWords?.close();
    session.liveWords = null;

    // Record what was said, as far as it was heard, before finalising.
    for (const item of session.items.values()) {
      if (!item.settled && !item.stopped) {
        item.stopped = 'hangup';
        this.settleItem(session, item);
      }
    }
    for (const line of [...session.lines]) {
      if (!line.ready) this.resolveLine(session, line.key, line.text, { drop: 'teardown' });
    }

    if (session.businessId && session.callId) {
      const { businessId, callId } = session;
      this.closeTiming(session);
      const latency = summarise(session.latencies);
      if (latency) {
        this.logger.log(
          `Call ${callId}: reply reached the caller ${latency.medianMs}ms after their turn ended (median of ${latency.count}, max ${latency.maxMs}ms)`,
        );
      }
      // What the caller waited, from their last sound: the turn detector's
      // share, then the whole wait until the reply began to play.
      const endpoint = summarise(session.endpoints);
      const heardAfter = summarise(session.heardAfter);
      if (heardAfter) {
        this.logger.log(
          `Call ${callId}: reply began playing ${heardAfter.medianMs}ms after the caller's last sound (median of ${heardAfter.count}, max ${heardAfter.maxMs}ms)` +
            `${endpoint ? `; their turn was ended ${endpoint.medianMs}ms after it` : ''}; ${session.fillerCounter} fillers and ${session.pauses} pauses in ${session.callerTurn} caller turns`,
        );
      }
      if (session.usage.responses > 0) {
        this.logEvent(session, CallEventType.AI_USAGE, {
          model: 'realtime',
          ...session.usage,
          ...(latency ? { replyLatencyMs: latency } : {}),
          ...(endpoint ? { endpointMs: endpoint } : {}),
          ...(heardAfter ? { lastSoundToReplyMs: heardAfter } : {}),
          // The parts of that wait, from each turn's TURN_TIMING.
          ...(summarise(session.stateTimes) ? { stateMs: summarise(session.stateTimes) } : {}),
          ...(summarise(session.modelTimes) ? { modelMs: summarise(session.modelTimes) } : {}),
          ...(summarise(session.lastReplyTimes) ? { lastSoundToLastReplyMs: summarise(session.lastReplyTimes) } : {}),
          callerTurns: session.callerTurn,
          fillers: session.fillerCounter,
          pauses: session.pauses,
        });
      }
      // A call that lost its model is a technical failure, and the backend
      // raises a callback for one however little was collected. A hang-up
      // with nothing collected is only an abandoned call.
      const message = session.failure;
      const input = message && !session.ending ? ({ kind: 'PROVIDER_ERROR', message } as const) : ({ kind: 'HANGUP' } as const);
      const trace = {
        endedBy: session.failure ? 'failure' : session.ending ? 'receptionist' : 'caller hung up',
        ...(session.ending ? { goodbyeHeard: session.responsesSinceEnding > 0 } : {}),
      };
      await this.enqueue(session, () => this.callSession.handleEvent(businessId, callId, input, { phrase: false, trace }));
    }
  }
}
