/**
 * Is the caller actually talking, and for how long?
 *
 * OpenAI's voice activity detection says when speech starts, but not whether
 * it is a real interruption ("wait, it's actually a Ford") or a word of
 * acknowledgement ("okay", "uh-huh") that a good listener talks straight
 * through. From speech onset the gateway asks this gauge, frame by frame,
 * which of the two it is hearing, and pauses the receptionist's audio only
 * once the sound has gone on.
 *
 * Pure energy measurement on the μ-law frames Twilio already delivers: a frame
 * is voiced when its level stands well above the line's own noise floor, which
 * is learned from the quietest recent frames so a hissy line does not read as
 * speech.
 */

import { mulawToLinear } from './g711';

/** μ-law at 8 kHz: 8 bytes per millisecond. */
const BYTES_PER_MS = 8;
/**
 * A frame must be this loud in absolute terms, whatever the floor. Phone
 * speech at normal level is 1,000-5,000 RMS on this scale; a quiet caller on
 * a handset can sit near 300. The first real call used 700 and missed the
 * caller's voice, so the receptionist talked over them. A caller heard to
 * speak more quietly still gets a lower bar (`VoiceLevel`).
 */
export const MIN_VOICED_RMS = 250;
/** The lowest bar for a quiet caller: well above a quiet line, and the receptionist's own echo on most phones. */
export const QUIET_VOICED_RMS = 120;
/** A frame counts as the caller's voice at this share of their usual speaking level. */
const VOICE_SHARE = 0.5;
/** Frames of a caller speaking alone (20 ms each) before their level is trusted: half a second. */
const VOICE_FRAMES_NEEDED = 25;
/** Frames of a caller's speech kept to judge their level: about five seconds. */
const VOICE_HISTORY = 250;
/** And this many times louder than the noise floor. */
const FLOOR_RATIO = 2.5;
/** Frames of history used to estimate the noise floor. */
const HISTORY = 50;

const LINEAR = new Int16Array(256);
for (let byte = 0; byte < 256; byte += 1) LINEAR[byte] = mulawToLinear(byte);

/** Root mean square level of one μ-law frame, on the 16-bit scale. */
export function frameRms(frame: Buffer): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = LINEAR[frame[i]!]!;
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
}

export class SpeechGauge {
  /** Milliseconds of voiced audio heard since the gauge was created. */
  voicedMs = 0;
  /** Milliseconds heard in total. */
  totalMs = 0;
  /** Milliseconds of unvoiced audio since the last voiced frame (or since the start). */
  trailingSilenceMs = 0;
  /** The loudest frame heard, for the trail: how near a missed voice came to counting. */
  loudestRms = 0;

  private readonly recent: number[] = [];

  /**
   * Starts from a typical quiet phone line; the floor adapts from there.
   * `minVoicedRms`: how loud a frame must be to count, for this caller.
   */
  constructor(
    initialFloor = 60,
    readonly minVoicedRms = MIN_VOICED_RMS,
  ) {
    this.recent.push(initialFloor);
  }

  /** The noise floor: the quietest fifth of recent frames. */
  get floor(): number {
    const sorted = [...this.recent].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 5)] ?? sorted[0] ?? 0;
  }

  /**
   * Feeds one frame of caller audio; returns whether it was voiced.
   * `minVoicedRms`: the bar for this frame, for a gauge that outlives what is
   * known of the caller's level (the one that listens for the whole call).
   */
  feed(frame: Buffer, minVoicedRms = this.minVoicedRms): boolean {
    const ms = frame.length / BYTES_PER_MS;
    const rms = frameRms(frame);
    const voiced = rms >= minVoicedRms && rms >= this.floor * FLOOR_RATIO;

    this.totalMs += ms;
    this.loudestRms = Math.max(this.loudestRms, rms);
    if (voiced) {
      this.voicedMs += ms;
      this.trailingSilenceMs = 0;
    } else {
      this.trailingSilenceMs += ms;
      // Only quiet frames shape the floor, so a long utterance cannot raise it
      // until speech itself stops counting as speech.
      this.recent.push(rms);
      if (this.recent.length > HISTORY) this.recent.shift();
    }
    return voiced;
  }
}

/**
 * How loudly this caller speaks, learned while they talk and the receptionist
 * is silent, so the receptionist's own voice is not in it. On a real call the
 * caller's voice sat under `MIN_VOICED_RMS`: each time they spoke over a reply
 * the gauge heard 0 ms of voice, the reply carried on, and it talked over
 * them for two seconds while OpenAI heard them speaking.
 */
export class VoiceLevel {
  private readonly levels: number[] = [];

  /** One frame while the caller is speaking alone. Pauses between words are left out. */
  feed(frame: Buffer): void {
    const rms = frameRms(frame);
    if (rms < QUIET_VOICED_RMS) return;
    this.levels.push(rms);
    if (this.levels.length > VOICE_HISTORY) this.levels.shift();
  }

  /** How loud a frame must be to count as this caller's voice. Never above the usual bar, only below it. */
  get minVoicedRms(): number {
    if (this.levels.length < VOICE_FRAMES_NEEDED) return MIN_VOICED_RMS;
    const sorted = [...this.levels].sort((a, b) => a - b);
    const usual = sorted[Math.floor(sorted.length / 2)]!;
    return Math.round(Math.min(MIN_VOICED_RMS, Math.max(QUIET_VOICED_RMS, usual * VOICE_SHARE)));
  }
}
