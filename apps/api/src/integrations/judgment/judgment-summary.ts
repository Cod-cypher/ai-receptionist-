/**
 * What a judgment found, as short lines for the call's event trail: the
 * scores the intake's thresholds are compared with, so a decision can be
 * read against the judgment that drove it.
 */

import type { CallJudgments } from './judgment.interface';

const two = (n: number) => n.toFixed(2);

export function summariseJudgments(judgments: CallJudgments): string[] {
  const lines: string[] = [];
  const { location, risk, service, move, confirmation, overlap, reply } = judgments;
  if (location) lines.push(`location ${location.status} (${two(location.confidence)})`);
  if (risk) {
    lines.push(`danger ${two(risk.danger)} ${risk.hazard}${risk.urgent !== null ? `, urgent ${two(risk.urgent)}` : ''}`);
  }
  if (service) {
    const alternatives = service.alternatives.length > 0 ? `, could be ${service.alternatives.join(' or ')}` : '';
    lines.push(`service ${service.service} (${two(service.confidence)})${alternatives}`);
  }
  if (move) lines.push(`caller ${move.move} (${two(move.confidence)})${move.topic && move.topic !== 'none' ? ` about ${move.topic}` : ''}`);
  if (confirmation) lines.push(`confirms ${two(confirmation.confirms)}, corrects ${two(confirmation.corrects)}`);
  if (overlap) lines.push(`answers ${two(overlap.answers)}`);
  if (reply) lines.push(`reply answered ${two(reply.answered)}`);
  return lines;
}
