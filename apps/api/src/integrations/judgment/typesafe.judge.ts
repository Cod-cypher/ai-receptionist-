/**
 * TypeSafe's Jev model as the call's judge.
 *
 * One HTTP request per event, carrying every question that applies to it,
 * since TypeSafe answers them in parallel at no extra latency. A call cannot
 * wait for a retry backoff, so there are no retries and a short timeout;
 * any failure returns `null` and the rules decide, exactly as before Jev
 * existed. The first failure is logged, later ones are not, so an outage
 * does not fill the log once per caller turn.
 *
 * What is saved is judged while the model waits for the tool result, so
 * those requests get a tighter timeout than a line of speech, which is judged
 * beside the call and folded in when the answer arrives.
 */

import { TypeSafeClient, type Fetch, type Questions } from '@typesafe-ai/sdk';

import type {
  CallJudge,
  CallJudgments,
  CallerMove,
  HazardChoice,
  LocationJudgment,
  QuestionTopic,
  RiskJudgment,
  ServiceChoice,
  ServiceJudgment,
  SpeechContext,
} from './judgment.interface';
import {
  ANSWERED,
  ANSWERS,
  CALLER_MOVE,
  QUESTION_TOPIC,
  TOPIC_CONFIDENCE_FLOOR,
  replyState,
  CONFIRMS,
  CORRECTS,
  HAZARD,
  LOCATION_PRECISION,
  SERVICE,
  SERVICE_ALTERNATIVE_FLOOR,
  URGENT,
  locationState,
  overlapState,
  serviceState,
  speechState,
} from './typesafe-questions';

export interface TypeSafeJudgeOptions {
  apiKey: string;
  /** Default `jev-latest`. */
  model?: string;
  /** Per request; default 1500 ms. */
  timeoutMs?: number;
  /** For what is judged while the model waits on a tool result; default 800 ms, never more than `timeoutMs`. */
  savedTimeoutMs?: number;
  onWarning?: (message: string) => void;
  /** Each judgment made, for logs. */
  onJudgment?: (summary: string) => void;
  /** For tests. */
  fetch?: Fetch;
}

export const DEFAULT_TIMEOUT_MS = 1500;
export const DEFAULT_SAVED_TIMEOUT_MS = 800;

interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
interface ScoreAnswer {
  confidence: number;
  probabilities: Record<string, number>;
}
interface NoulAnswer {
  noul: number;
}
type Answers = Record<string, unknown>;

/** The precision level Jev put the most probability on. */
function topLevel(probabilities: Record<string, number>): number {
  let best = 0;
  let bestProbability = -1;
  for (const [level, probability] of Object.entries(probabilities)) {
    if (probability > bestProbability) {
      best = Number(level);
      bestProbability = probability;
    }
  }
  return best;
}

/** Danger as a whole, and the most likely kind of it. */
function riskFrom(text: string, probabilities: Record<string, number>, urgent: number | null): RiskJudgment {
  let hazard: HazardChoice = 'none';
  let hazardProbability = 0;
  for (const [label, probability] of Object.entries(probabilities)) {
    if (label !== 'none' && probability > hazardProbability) {
      hazard = label as HazardChoice;
      hazardProbability = probability;
    }
  }
  return { text, danger: 1 - (probabilities.none ?? 0), hazard, hazardProbability, urgent };
}

/** The kind of help chosen, and the kinds worth offering the caller if that choice is not a sure one. */
function serviceFrom(text: string, answer: ChoiceAnswer): ServiceJudgment {
  const alternatives = Object.entries(answer.probabilities)
    .filter(([label, probability]) => label !== 'unclear' && probability >= SERVICE_ALTERNATIVE_FLOOR)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label]) => label as Exclude<ServiceChoice, 'unclear'>);
  return { text, service: answer.choice as ServiceChoice, confidence: answer.confidence, alternatives };
}

const two = (n: number) => n.toFixed(2);

export class TypeSafeJudge implements CallJudge {
  private readonly client: TypeSafeClient;
  private readonly savedTimeoutMs: number;
  private readonly onWarning?: (message: string) => void;
  private readonly onJudgment?: (summary: string) => void;
  private warned = false;

  constructor(options: TypeSafeJudgeOptions) {
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.savedTimeoutMs = Math.min(timeout, options.savedTimeoutMs ?? DEFAULT_SAVED_TIMEOUT_MS);
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      defaultModel: options.model ?? 'jev-latest',
      timeout,
      retry: { maxRetries: 0 },
      logLevel: 'off',
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.onWarning = options.onWarning;
    this.onJudgment = options.onJudgment;
  }

  async judgeLocation(text: string, knownAreas: readonly string[]): Promise<CallJudgments | null> {
    const answers = await this.ask(
      `location "${text}"`,
      locationState(text, knownAreas),
      { precision: LOCATION_PRECISION, hazard: HAZARD },
      this.savedTimeoutMs,
    );
    if (!answers) return null;

    const precision = answers.precision as ScoreAnswer;
    const probabilities = { ...precision.probabilities };
    const location: LocationJudgment = {
      text,
      status: topLevel(probabilities) >= 2 ? 'complete' : 'partial',
      confidence: precision.confidence,
      probabilities,
    };
    const risk = riskFrom(text, (answers.hazard as ChoiceAnswer).probabilities, null);
    this.onJudgment?.(`location "${text}": ${location.status} (${two(location.confidence)}), danger ${two(risk.danger)} ${risk.hazard}`);
    return { location, risk };
  }

  async judgeService(said: string, about: { problem?: string; location?: string }): Promise<CallJudgments | null> {
    const answers = await this.ask(`service "${said}"`, serviceState(said, about), { service: SERVICE }, this.savedTimeoutMs);
    if (!answers) return null;

    const service = serviceFrom(said, answers.service as ChoiceAnswer);
    this.onJudgment?.(`service "${said}": ${service.service} (${two(service.confidence)}), could be ${service.alternatives.join(' or ') || 'nothing'}`);
    return { service };
  }

  async judgeSpeech(spoken: string, about: SpeechContext): Promise<CallJudgments | null> {
    const questions: Questions = {
      hazard: HAZARD,
      urgent: URGENT,
      move: CALLER_MOVE,
      topic: QUESTION_TOPIC,
      ...(about.pending ? { confirms: CONFIRMS, corrects: CORRECTS } : {}),
      ...(about.serviceMissing ? { service: SERVICE } : {}),
    };
    const answers = await this.ask(`speech "${spoken}"`, speechState(spoken, about), questions);
    if (!answers) return null;

    const urgent = (answers.urgent as NoulAnswer).noul;
    const move = answers.move as ChoiceAnswer;
    const topic = answers.topic as ChoiceAnswer;
    // Turn numbers are the caller's to stamp: the judge does not know which turn this line belongs to.
    const judgments: CallJudgments = {
      risk: riskFrom(spoken, (answers.hazard as ChoiceAnswer).probabilities, urgent),
      move: {
        text: spoken,
        callerTurn: -1,
        move: move.choice as CallerMove,
        confidence: move.confidence,
        ...(topic.confidence >= TOPIC_CONFIDENCE_FLOOR && topic.choice !== 'none' ? { topic: topic.choice as QuestionTopic } : {}),
      },
    };
    if (about.pending) {
      judgments.confirmation = {
        text: spoken,
        callerTurn: -1,
        confirms: (answers.confirms as NoulAnswer).noul,
        corrects: (answers.corrects as NoulAnswer).noul,
      };
    }
    if (about.serviceMissing) judgments.service = serviceFrom(spoken, answers.service as ChoiceAnswer);

    this.onJudgment?.(
      [
        `speech "${spoken}": ${move.choice} (${two(move.confidence)})`,
        `danger ${two(judgments.risk!.danger)} ${judgments.risk!.hazard}`,
        `urgent ${two(urgent)}`,
        ...(judgments.confirmation
          ? [`confirms ${two(judgments.confirmation.confirms)}, corrects ${two(judgments.confirmation.corrects)} (${about.pending!.kind})`]
          : []),
        ...(judgments.service ? [`needs ${judgments.service.service} (${two(judgments.service.confidence)})`] : []),
      ].join(', '),
    );
    return judgments;
  }

  async judgeOverlap(spoken: string, receptionistSaid: string): Promise<CallJudgments | null> {
    const answers = await this.ask(`overlap "${spoken}"`, overlapState(spoken, receptionistSaid), { answers: ANSWERS });
    if (!answers) return null;

    const answered = (answers.answers as NoulAnswer).noul;
    this.onJudgment?.(`overlap "${spoken}" over "${receptionistSaid}": answers ${two(answered)}`);
    return { overlap: { text: spoken, answers: answered } };
  }

  async judgeReply(callerSaid: string, reply: string): Promise<CallJudgments | null> {
    const answers = await this.ask(`reply to "${callerSaid}"`, replyState(callerSaid, reply), { answered: ANSWERED });
    if (!answers) return null;

    const answered = (answers.answered as NoulAnswer).noul;
    this.onJudgment?.(`reply "${reply}" to "${callerSaid}": answered ${two(answered)}`);
    return { reply: { text: callerSaid, reply, answered } };
  }

  private async ask(what: string, state: Record<string, unknown>, questions: Questions, timeoutMs?: number): Promise<Answers | null> {
    try {
      const result = await this.client.systemOne({ state: state as never, questions }, timeoutMs ? { timeout: timeoutMs } : undefined);
      const answers = (result.answers ?? {}) as Answers;
      // Typed output guarantees the interface, not that the server honoured it.
      for (const [name, question] of Object.entries(questions)) {
        const answer = answers[name] as { type?: string } | undefined;
        if (answer?.type !== question.type) throw new Error(`no ${question.type} answer for "${name}" in the response`);
      }
      return answers;
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.onWarning?.(
          `TypeSafe judgment failed for ${what}: ${error instanceof Error ? error.message : String(error)}. ` +
            'The rules decide until it recovers; further failures are not logged.',
        );
      }
      return null;
    }
  }
}
