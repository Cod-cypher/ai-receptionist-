/**
 * Scores one run, attributing every failure to the part of the system that
 * caused it — so a regression can be traced to the model, a tool, the state
 * merge, validation, the priority engine or the spoken reply.
 */

import { checkReply } from '../../../conversation/guardrails';
import { classifyLocation } from '../../../conversation/location';
import { determineNextAction } from '../../../conversation/next-action';
import { questionsIn } from '../../../conversation/response-check';
import { EVAL_FACTS, type RunRecord } from './harness';
import type { Scenario } from './scenarios';

export type FailureCategory =
  | 'EXTRACTION_FAILURE'
  | 'FIELD_OMITTED'
  | 'WRONG_FIELD_VALUE'
  | 'WRONG_SPECIFICITY'
  | 'STATE_MERGE_FAILURE'
  | 'LOCATION_VALIDATION_FAILURE'
  | 'WRONG_NEXT_ACTION'
  | 'RESPONSE_DID_NOT_FOLLOW_ACTION'
  | 'PREMATURE_CONFIRMATION'
  | 'SAFETY_MISSED'
  | 'URGENCY_MISSED'
  | 'INFERENCE_UNTAGGED'
  | 'GUESSED_UNCLEAR_SPEECH'
  | 'CONVERSATION_FAILURE'
  | 'GUARDRAIL_BROKEN'
  | 'TOOL_CALL_FAILURE';

export type FailureSource = 'model' | 'tool' | 'merge' | 'validation' | 'priority' | 'response' | 'backend';

export interface Failure {
  category: FailureCategory;
  source: FailureSource;
  detail: string;
}

const MISUNDERSTOOD = /\b(?:did ?n[o']?t|did not|could ?n[o']?t|could not|can ?n[o']?t|cannot) (?:quite )?(?:catch|understand|make out|get) (?:that|you|what)/i;
const SAFETY_ADVICE = /\b911\b|\bemergency services\b|\bcall (?:the )?(?:police|an ambulance)\b/i;

const show = (value: unknown) => JSON.stringify(value);

function everSent(run: RunRecord, key: string): unknown[] {
  return run.ops
    .filter((o) => o.op.kind === 'update')
    .map((o) => (o.op as { slots: Record<string, unknown> }).slots[key])
    .filter((v) => v !== undefined);
}

export function scoreRun(scenario: Scenario, run: RunRecord): Failure[] {
  const failures: Failure[] = [];
  const fail = (category: FailureCategory, source: FailureSource, detail: string) => failures.push({ category, source, detail });
  const final = run.finalContext;
  const values = final.values as Record<string, unknown>;
  const allReplies = run.turns.flatMap((t) => t.replies);

  for (const error of run.errors) fail('TOOL_CALL_FAILURE', 'tool', error);
  for (const op of run.ops) {
    if (typeof op.output.error === 'string') fail('TOOL_CALL_FAILURE', 'tool', op.output.error);
  }
  if (run.turns.length < scenario.lines.length) fail('EXTRACTION_FAILURE', 'model', `only ${run.turns.length}/${scenario.lines.length} turns completed`);

  for (const reply of allReplies) {
    const verdict = checkReply(reply);
    const codes = verdict.ok ? [] : verdict.violations.map((v) => v.code).filter((c) => c !== 'too_long');
    if (codes.length > 0) fail('GUARDRAIL_BROKEN', 'response', `${codes.join(', ')}: "${reply}"`);
  }

  // ---- Fields ----
  let omitted = false;
  for (const [key, want] of Object.entries(scenario.fields ?? {})) {
    const value = values[key];
    const sent = everSent(run, key);
    const matches = (v: unknown) => (want instanceof RegExp ? typeof v === 'string' && want.test(v) : v === want);
    if (value === undefined) {
      omitted = true;
      if (sent.some(matches)) fail('STATE_MERGE_FAILURE', 'merge', `${key} was sent as ${show(sent)} but not saved`);
      else if (sent.length === 0) fail('FIELD_OMITTED', 'model', `${key} never saved`);
      else fail('WRONG_FIELD_VALUE', 'model', `${key} sent as ${show(sent)}`);
    } else if (!matches(value)) {
      fail('WRONG_FIELD_VALUE', 'model', `${key} = ${show(value)}`);
    }
  }

  for (const [key, rule] of Object.entries(scenario.specific ?? {})) {
    const value = values[key];
    const sent = everSent(run, key);
    if (typeof value === 'string' && rule.want.test(value)) continue;
    if (sent.some((v) => typeof v === 'string' && rule.want.test(v))) {
      fail('STATE_MERGE_FAILURE', 'merge', `${key}: specific value sent but saved as ${show(value)}`);
    } else if (value === undefined) {
      omitted = true;
      fail('FIELD_OMITTED', 'model', `${key} never saved`);
    } else {
      fail('WRONG_SPECIFICITY', 'model', `${key} saved as ${show(value)}`);
    }
  }

  if (scenario.locationStatus) {
    const status = classifyLocation(final.values.location, { knownAreas: EVAL_FACTS.serviceAreas }).status;
    if (final.values.location && status !== scenario.locationStatus) {
      fail('LOCATION_VALIDATION_FAILURE', 'validation', `"${final.values.location}" classified ${status}, expected ${scenario.locationStatus}`);
    }
  }

  // ---- Turn expectations ----
  for (const expectation of scenario.turns ?? []) {
    const turn = run.turns[expectation.turn - 1];
    if (!turn) continue;
    const text = turn.replies.join(' ');
    const topics = new Set(questionsIn(text).flatMap((q) => q.topics));
    const gaveSafety = SAFETY_ADVICE.test(text);

    if (expectation.action && !omitted) {
      const action = determineNextAction(turn.stateAfter, { emergencyNumber: '911', knownAreas: EVAL_FACTS.serviceAreas }).action;
      // Before the fix the backend has no safety step; judge the step after it.
      const acceptable = new Set(expectation.action);
      if (!acceptable.has(action)) fail('WRONG_NEXT_ACTION', 'priority', `turn ${expectation.turn}: backend chose ${action}`);
    }

    if (expectation.ask) {
      const askedRight = expectation.ask.some((t) => topics.has(t)) || (expectation.allowSafety && gaveSafety);
      if (!askedRight) fail('RESPONSE_DID_NOT_FOLLOW_ACTION', 'response', `turn ${expectation.turn}: did not ask about ${expectation.ask.join('/')}: "${text}"`);
    }
    const forbidden = (expectation.forbid ?? []).filter((t) => topics.has(t));
    if (forbidden.length > 0) {
      fail('RESPONSE_DID_NOT_FOLLOW_ACTION', 'response', `turn ${expectation.turn}: asked about ${forbidden.join(', ')}: "${text}"`);
    }
    if (expectation.understood && MISUNDERSTOOD.test(text)) {
      fail('CONVERSATION_FAILURE', 'response', `turn ${expectation.turn}: said it did not understand: "${text}"`);
    }
    if (expectation.mention && !expectation.mention.test(text)) {
      fail('CONVERSATION_FAILURE', 'response', `turn ${expectation.turn}: "${text}"`);
    }
  }

  // ---- Confirmation ----
  if (scenario.leadCreated !== undefined) {
    const created = run.leadCreatedAtTurn !== null;
    if (scenario.leadCreated && !created) fail('EXTRACTION_FAILURE', 'model', 'no lead was created');
    if (created) {
      const readBackTurn = run.turns.findIndex((t) => questionsIn(t.replies.join(' ')).some((q) => q.topics.includes('details'))) + 1;
      if (readBackTurn === 0 || run.leadCreatedAtTurn! <= readBackTurn) {
        fail('PREMATURE_CONFIRMATION', 'backend', `lead created at turn ${run.leadCreatedAtTurn} but the read-back was ${readBackTurn ? `at turn ${readBackTurn}` : 'never asked'}`);
      }
    }
  }
  if (scenario.phoneNotConfirmed && final.phoneConfirmed) {
    fail('PREMATURE_CONFIRMATION', 'backend', 'callback number marked confirmed though the caller was never asked');
  }

  // ---- Safety, urgency, provenance ----
  if (scenario.safetyBy) {
    const text = run.turns.slice(0, scenario.safetyBy).flatMap((t) => t.replies).join(' ');
    if (!SAFETY_ADVICE.test(text)) fail('SAFETY_MISSED', 'priority', `no emergency advice by turn ${scenario.safetyBy}: "${text}"`);
  }
  if (scenario.urgencyHigh && final.urgency?.level !== 'high') fail('URGENCY_MISSED', 'priority', 'lead not marked urgent');
  if (scenario.inferredMake && final.values.vehicleMake && final.fieldSources?.vehicleMake !== 'inferred') {
    fail('INFERENCE_UNTAGGED', 'tool', `make "${final.values.vehicleMake}" was never said but is not tagged inferred`);
  }
  if (scenario.garbledField) {
    const key = scenario.garbledField;
    const lastTurn = run.turns.at(-1);
    const accepted = final.values[key] !== undefined && final.fieldSources?.[key] !== 'unsure';
    const checked = lastTurn ? questionsIn(lastTurn.replies.join(' ')).some((q) => q.topics.includes('movable')) : false;
    if (accepted && !checked) fail('GUESSED_UNCLEAR_SPEECH', 'model', `${key} accepted from garbled speech without checking`);
  }

  return failures;
}
