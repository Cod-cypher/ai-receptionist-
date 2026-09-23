/**
 * TypeSafe's Jev model as the call's judge.
 *
 * One HTTP request per event, carrying every question that applies to it,
 * since TypeSafe answers them in parallel at no extra latency. A call cannot
 * wait for a retry backoff, so there are no retries and a short timeout;
 * any failure returns `null` and the rules decide, exactly as before Jev
 * existed. The first failure is logged, later ones are not, so an outage
 * does not fill the log once per caller turn.
 */

import { TypeSafeClient, type Fetch, type Questions, type SystemOneResult } from '@typesafe-ai/sdk';

import type { CallJudge, CallJudgments, HazardChoice, LocationJudgment, PendingQuestion, RiskJudgment } from './judgment.interface';
import { ANSWERS, CONFIRMS, CORRECTS, HAZARD, LOCATION_PRECISION, URGENT, locationState, overlapState, speechState } from './typesafe-questions';

export interface TypeSafeJudgeOptions {
  apiKey: string;
  /** Default `jev-latest`. */
  model?: string;
  /** Per request; default 1500 ms. */
  timeoutMs?: number;
  onWarning?: (message: string) => void;
  /** Each judgment made, for logs. */
  onJudgment?: (summary: string) => void;
  /** For tests. */
  fetch?: Fetch;
}

export const DEFAULT_TIMEOUT_MS = 1500;

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

export class TypeSafeJudge implements CallJudge {
  private readonly client: TypeSafeClient;
  private readonly onWarning?: (message: string) => void;
  private readonly onJudgment?: (summary: string) => void;
  private warned = false;

  constructor(options: TypeSafeJudgeOptions) {
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      defaultModel: options.model ?? 'jev-latest',
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retry: { maxRetries: 0 },
      logLevel: 'off',
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.onWarning = options.onWarning;
    this.onJudgment = options.onJudgment;
  }

  async judgeLocation(text: string, knownAreas: readonly string[]): Promise<CallJudgments | null> {
    const result = await this.ask(`location "${text}"`, locationState(text, knownAreas), {
      precision: LOCATION_PRECISION,
      hazard: HAZARD,
    });
    if (!result) return null;

    const { precision, hazard } = result.answers;
    const probabilities = { ...(precision.probabilities as Record<string, number>) };
    const location: LocationJudgment = {
      text,
      status: topLevel(probabilities) >= 2 ? 'complete' : 'partial',
      confidence: precision.confidence,
      probabilities,
    };
    const risk = riskFrom(text, hazard.probabilities as Record<string, number>, null);
    this.onJudgment?.(
      `location "${text}": ${location.status} (${location.confidence.toFixed(2)}), ` +
        `danger ${risk.danger.toFixed(2)} ${risk.hazard}`,
    );
    return { location, risk };
  }

  async judgeSpeech(spoken: string, location: string | undefined, pending?: PendingQuestion): Promise<CallJudgments | null> {
    if (pending) {
      const result = await this.ask(`speech "${spoken}"`, speechState(spoken, location, pending), {
        hazard: HAZARD,
        urgent: URGENT,
        confirms: CONFIRMS,
        corrects: CORRECTS,
      });
      if (!result) return null;

      const { hazard, urgent, confirms, corrects } = result.answers;
      const risk = riskFrom(spoken, hazard.probabilities as Record<string, number>, urgent.noul);
      // `callerTurn` is the caller's to stamp: the judge does not know which turn this line belongs to.
      const confirmation = { text: spoken, callerTurn: -1, confirms: confirms.noul, corrects: corrects.noul };
      this.onJudgment?.(
        `speech "${spoken}": danger ${risk.danger.toFixed(2)} ${risk.hazard}, urgent ${urgent.noul.toFixed(2)}, ` +
          `confirms ${confirms.noul.toFixed(2)}, corrects ${corrects.noul.toFixed(2)} (${pending.kind})`,
      );
      return { risk, confirmation };
    }

    const result = await this.ask(`speech "${spoken}"`, speechState(spoken, location), { hazard: HAZARD, urgent: URGENT });
    if (!result) return null;

    const { hazard, urgent } = result.answers;
    const risk = riskFrom(spoken, hazard.probabilities as Record<string, number>, urgent.noul);
    this.onJudgment?.(`speech "${spoken}": danger ${risk.danger.toFixed(2)} ${risk.hazard}, urgent ${urgent.noul.toFixed(2)}`);
    return { risk };
  }

  async judgeOverlap(spoken: string, receptionistSaid: string): Promise<CallJudgments | null> {
    const result = await this.ask(`overlap "${spoken}"`, overlapState(spoken, receptionistSaid), { answers: ANSWERS });
    if (!result) return null;

    const answers = result.answers.answers.noul;
    this.onJudgment?.(`overlap "${spoken}" over "${receptionistSaid}": answers ${answers.toFixed(2)}`);
    return { overlap: { text: spoken, answers } };
  }

  private async ask<Q extends Questions>(
    what: string,
    state: Record<string, unknown>,
    questions: Q,
  ): Promise<SystemOneResult<Q> | null> {
    try {
      const result = await this.client.systemOne({ state: state as never, questions });
      // Typed output guarantees the interface, not that the server honoured it.
      for (const [name, question] of Object.entries(questions)) {
        const answer = (result.answers as Record<string, { type?: string } | undefined> | undefined)?.[name];
        if (answer?.type !== question.type) throw new Error(`no ${question.type} answer for "${name}" in the response`);
      }
      return result;
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
