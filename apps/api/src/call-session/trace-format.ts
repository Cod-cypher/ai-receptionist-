/**
 * A call's event trail as something a person can read: one or a few lines
 * per event, grouped by the caller turn they belong to. Shared by
 * `npm run call:trace` (a real call, from the database) and
 * `npm run realtime:explain` (a scenario, from the eval harness).
 *
 * Pure: no database, no Nest. Unknown event types still print, as key=value.
 */

export interface TraceEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt?: Date | string;
}

export interface TraceTranscriptLine {
  turnIndex: number;
  speaker: string;
  text: string;
  createdAt: Date | string;
}

export interface TraceCall {
  id: string;
  fromNumber?: string | null;
  startedAt?: Date | string | null;
  durationSeconds?: number | null;
  outcome?: string | null;
  finalState?: string | null;
  error?: string | null;
}

export interface FormatOptions {
  /** Print the notes given to the model in full, rather than their first line. */
  notes?: boolean;
}

const INDENT = '      ';

/** At most `max` characters, on one line. */
export function clip(value: unknown, max = 300): string {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const list = (value: unknown) => (Array.isArray(value) ? value.map(str) : []);
/** What a reply asked for with the caller's words replaced. */
const SUPERSEDED: Record<string, string> = {
  asked: 'replaces the reply already asked for',
  started: 'replaces the reply under way, unheard',
  empty: 'the reply before it said nothing',
};
/** How loud the caller came through against the level that counted as their voice, when recorded. */
const loudness = (p: Record<string, unknown>) =>
  p.loudestRms !== undefined ? `; loudest ${str(p.loudestRms)}, voice from ${str(p.minVoicedRms)}` : '';

function keyValues(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([key]) => key !== 'turn')
    .map(([key, value]) => `${key}=${clip(value, 120)}`)
    .join(' ');
}

/** One event, as one or more lines without a trailing newline. */
export function formatEvent(type: string, payload: Record<string, unknown> | null, options: FormatOptions = {}): string {
  const p = payload ?? {};
  switch (type) {
    case 'CUSTOMER_SPEECH':
      return `Caller: "${str(p.transcript)}"`;

    case 'AI_RESPONSE': {
      const who = p.filler ? 'Receptionist (filler)' : p.greeting ? 'Receptionist (greeting)' : 'Receptionist';
      const why = p.filler || p.greeting ? '' : p.inReplyTo ? ` (reply to: ${str(p.inReplyTo)})` : '';
      const stopped = p.stopped ? ` [${str(p.stopped)}; heard ~"${str(p.heard)}", ${str(p.heardMs)}ms of ${str(p.audioMs)}ms]` : '';
      // What the caller waited for the first reply to their turn.
      const wait =
        typeof p.afterLastSoundMs === 'number'
          ? ` [began ${p.afterLastSoundMs}ms after their last sound]`
          : typeof p.afterTurnMs === 'number'
            ? ` [sent ${p.afterTurnMs}ms after their turn ended]`
            : '';
      return `${who}: "${str(p.text)}"${stopped}${why}${wait}`;
    }

    case 'NEXT_ACTION': {
      const because = list(p.because);
      const lines = [`→ NEXT: ${str(p.action)} (after ${str(p.after)}) because ${because[0] ?? 'no reason recorded'}`];
      for (const reason of because.slice(1)) lines.push(`${INDENT}· ${reason}`);
      const waits = list(p.doNotAsk);
      if (waits.length > 0) lines.push(`${INDENT}· must wait: ${waits.join(', ')}`);
      return lines.join('\n');
    }

    case 'TOOL_CALL':
      return [
        `tool ${str(p.kind)}${p.understood === false ? ' (NOT UNDERSTOOD)' : ''} ${clip(p.args, 400)}`,
        `${INDENT}-> ${clip(p.output, 600)}`,
      ].join('\n');

    case 'JUDGMENT': {
      const found = list(p.found);
      return `judge ${str(p.about)} "${clip(p.text, 120)}" in ${str(p.ms)}ms: ${found.length > 0 ? found.join('; ') : 'nothing came back, the rules decided alone'}`;
    }

    case 'RISK_ASSESSED': {
      const parts = [`risk: urgency ${str(p.urgency)}`];
      const added = list(p.reasonsAdded);
      if (added.length > 0) parts.push(`because ${added.join(', ')}`);
      if (p.hazard) parts.push(`hazard "${str(p.hazard)}" found by ${str(p.foundBy)}`);
      return parts.join('; ');
    }

    case 'MODEL_NOTE': {
      const text = str(p.text);
      const head = `note to model (${str(p.kind)}${p.pinned ? ', pinned' : ''}${p.action ? `, ${str(p.action)}` : ''})`;
      const body = options.notes ? text.split('\n') : [clip(text.split('\n')[0], 160), `(${text.split('\n').length} lines; --notes for all)`];
      const lines = [`${head}:`, ...body.map((line) => `${INDENT}| ${line}`)];
      if (options.notes && Array.isArray(p.toolOutputs) && p.toolOutputs.length > 0) {
        lines.push(`${INDENT}| tool outputs: ${clip(p.toolOutputs, 800)}`);
      }
      return lines.join('\n');
    }

    case 'REPLY_REQUESTED': {
      // The caller's words the reply was asked for with, once known, and what it replaced.
      const replaced = p.superseded ? `; ${SUPERSEDED[str(p.superseded)] ?? `replaces ${str(p.superseded)}`}` : '';
      const said = p.said !== undefined ? ` "${clip(p.said, 200)}" (${str(p.kind)}${replaced})` : '';
      const waited = typeof p.waitedMs === 'number' ? ` [held ${p.waitedMs}ms for the words]` : '';
      const endpoint = typeof p.endpointMs === 'number' ? ` [turn ended ${p.endpointMs}ms after their last sound]` : '';
      return `reply asked for: ${str(p.reason)}${said}${endpoint}${waited}${p.instructions ? ` "${clip(p.instructions, 200)}"` : ''}`;
    }

    case 'ACTION_DEVIATION':
      // Not stopped: the next question, asked in a reply that did not save the answer to this one.
      if (p.unsaved) return `NOT SAVED: asked the next question (${str(p.asked)}) while ${str(p.required)} was required, and saved nothing: "${str(p.question)}"`;
      return `STOPPED (${p.redirected ? 'redirected' : 'logged only'}): asked about ${str(p.asked)} while ${str(p.required)} was required: "${str(p.question)}"${p.heard !== undefined && p.heard !== null ? `; heard ~"${str(p.heard)}"` : ''}`;

    case 'GUARDRAIL_TRIPPED':
      return `STOPPED by guardrail (${list(p.violations).join(', ')}, attempt ${str(p.attempt)}): "${str(p.suppressed)}"${p.heard !== undefined ? `; heard ~"${str(p.heard)}"` : ''}`;

    case 'AI_INTERRUPTED':
      return `caller took the floor after ${str(p.heardMs)}ms of the reply${p.heard !== undefined ? ` (heard ~"${str(p.heard)}")` : ''}${p.via ? `; decided by ${str(p.via)}, ${str(p.voicedMs)}ms voiced${loudness(p)}` : ''}`;

    case 'HOLD_RESUMED':
      // A sound too short to pause for: the reply was never stopped.
      if (p.playedThrough) {
        return `caller made a brief sound: the reply played through it (${str(p.voicedMs)}ms voiced; decided by ${str(p.via)}${loudness(p)})`;
      }
      // `holdMs` runs from the onset of the sound; the gap in the reply began when playback stopped.
      return `caller spoke briefly: paused ${str(p.pausedMs ?? p.holdMs)}ms and carried on (${str(p.voicedMs)}ms voiced; decided by ${str(p.via)}${loudness(p)})`;

    case 'TALKED_OVER':
      return `TALKED OVER the caller: the reply carried on while OpenAI heard them speak for ${str(p.spokenMs)}ms (${str(p.voicedMs)}ms voiced after the pause${loudness(p)})`;

    case 'OVERLAP_DECIDED':
      // Not said over anything: a sound of thinking on a turn of its own, left unanswered.
      if (p.hesitation) return `caller is still thinking: "${str(p.said)}" → no reply, waiting for them to go on`;
      return `said over the receptionist: "${str(p.said)}" → ${str(p.decision)} (${str(p.by)}${p.answers !== undefined && p.answers !== null ? `, answers ${str(p.answers)}` : ''}${p.why ? `: ${str(p.why)}` : ''})`;

    case 'TRANSCRIPT_DROPPED':
      // Not dropped whole: what the transcriber wrote in another script was taken out.
      if (p.reason === 'script') {
        return `transcriber wrote "${str(p.text)}" in another script: ${p.kept ? `kept "${str(p.kept)}"` : 'nothing kept, the line is not in the transcript'}`;
      }
      return `caller line not in the transcript: ${str(p.reason)}${p.text ? ` "${str(p.text)}"` : ''}`;

    case 'FIELD_EXTRACTED':
      return `saved ${str(p.field)} = ${clip(p.value, 120)}${p.source ? ` (${str(p.source)})` : ''}`;

    case 'FIELD_CORRECTED':
      return `changed ${str(p.field)}: ${clip(p.from, 80)} → ${clip(p.to, 80)}${p.source ? ` (${str(p.source)})` : ''}`;

    case 'FIELD_REJECTED':
      return `rejected ${str(p.field)}: ${str(p.reason)}`;

    case 'CONFIRMATION_REJECTED':
      return `confirmation refused (${str(p.kind)}): ${str(p.reason)}`;

    case 'CONFIRMATION_JUDGED':
      return `YES TAKEN by the backend (${str(p.kind)}): "${str(p.text)}" confirms ${str(p.confirms)}, corrects ${str(p.corrects)}; the model had not saved it`;

    case 'TURN_TIMING': {
      // Where the turn's wait went, stage by stage; each reply is timed from the end of the caller's turn.
      const replies = (Array.isArray(p.replies) ? (p.replies as Array<Record<string, unknown>>) : []).map((reply, i) => {
        const audio = typeof reply.audioMs === 'number' ? `audio after ${reply.audioMs}ms` : 'no audio';
        const tools = typeof reply.toolsMs === 'number' ? `, tools ${reply.toolsMs}ms` : '';
        return `reply ${i + 1} (${str(reply.reason)}) asked at ${str(reply.askedMs)}ms, ${audio}${tools}`;
      });
      const from = p.sinceLastSound ? 'their last sound' : 'their turn ended';
      const parts = [
        ...(typeof p.endedMs === 'number' ? [`turn ended ${p.endedMs}ms after their last sound`] : []),
        ...(typeof p.stateMs === 'number' ? [`state ${p.stateMs}ms`] : []),
        ...(typeof p.wordsMs === 'number' ? [`held ${p.wordsMs}ms for their words`] : []),
        ...replies,
        ...(typeof p.voiceMs === 'number'
          ? [`own voice ${p.voiceMs}ms after ${from}${p.lastReplyMs !== p.voiceMs ? `, last reply ${str(p.lastReplyMs)}ms` : ''}`]
          : ['nothing said']),
        ...(typeof p.fillers === 'number' && p.fillers > 0 ? [`${p.fillers} filler${p.fillers === 1 ? '' : 's'}`] : []),
      ];
      return `timing: ${parts.join(' | ')}`;
    }

    case 'CALL_ENDED':
      return `CALL ENDED: ${str(p.outcome)}${p.reason ? `; ${str(p.reason)}` : ''}${p.endedBy ? `; ended by ${str(p.endedBy)}` : ''}${p.goodbyeHeard === false ? '; goodbye not heard' : ''}`;

    default: {
      const rest = keyValues(p);
      return `${type}${rest ? ` ${clip(rest, 300)}` : ''}`;
    }
  }
}

export interface TimelineOptions extends FormatOptions {
  /** Only these event types. */
  only?: readonly string[];
}

/**
 * A whole call: a header, then its events grouped under the caller turn
 * they belong to, in the order they were recorded within each turn. A call
 * recorded before the trail existed has no reply events: its transcript is
 * interleaved with its events by time instead.
 */
export function renderTimeline(call: TraceCall, transcript: TraceTranscriptLine[], events: TraceEvent[], options: TimelineOptions = {}): string {
  const out: string[] = [];
  const started = call.startedAt ? new Date(call.startedAt).toISOString() : 'unknown';
  out.push(`Call ${call.id}`);
  out.push(
    `  from ${call.fromNumber ?? 'unknown'} · started ${started} · ${call.durationSeconds ?? '?'}s · outcome ${call.outcome ?? 'none'} · ended in ${call.finalState ?? 'unknown'}${call.error ? ` · error: ${call.error}` : ''}`,
  );
  const shown = (type: string) => !options.only || options.only.includes(type);
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);

  if (!sorted.some((e) => e.type === 'AI_RESPONSE')) {
    out.push('  (recorded before replies were traced: transcript and events interleaved by time)', '');
    const rows = [
      ...transcript.map((line) => ({
        at: new Date(line.createdAt).getTime(),
        order: 0,
        text: `${line.speaker === 'ai' ? 'Receptionist' : 'Caller'}: "${line.text}"`,
        type: 'TRANSCRIPT',
      })),
      ...sorted.map((e) => ({ at: e.createdAt ? new Date(e.createdAt).getTime() : 0, order: 1, text: formatEvent(e.type, e.payload, options), type: e.type })),
    ]
      .filter((row) => row.type === 'TRANSCRIPT' || (row.type !== 'CUSTOMER_SPEECH' && shown(row.type)))
      .sort((a, b) => a.at - b.at || a.order - b.order);
    for (const row of rows) out.push(indent(row.text, '  '));
    return out.join('\n');
  }

  // Events without a turn belong with the one before them.
  let current = 0;
  const groups = new Map<number, TraceEvent[]>();
  for (const event of sorted) {
    const turn = typeof event.payload?.turn === 'number' ? event.payload.turn : current;
    current = turn;
    if (!groups.has(turn)) groups.set(turn, []);
    groups.get(turn)!.push(event);
  }
  for (const turn of [...groups.keys()].sort((a, b) => a - b)) {
    const lines = groups.get(turn)!.filter((e) => shown(e.type));
    if (lines.length === 0) continue;
    out.push('', turn === 0 ? 'Before the caller spoke' : `Turn ${turn}`);
    for (const event of lines) out.push(indent(formatEvent(event.type, event.payload, options), '  '));
  }
  return out.join('\n');
}

function indent(text: string, by: string): string {
  return text
    .split('\n')
    .map((line) => by + line)
    .join('\n');
}
