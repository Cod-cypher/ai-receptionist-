/**
 * Is the caller actually talking, and for how long?
 *
 * OpenAI's voice activity detection says when speech starts, but not whether
 * it is a real interruption ("wait, it's actually a Ford") or a word of
 * acknowledgement ("okay", "uh-huh") that a good listener talks straight
 * through. The gateway holds the receptionist's audio at speech onset and
 * asks this gauge, frame by frame, which of the two it is hearing.
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
 * caller's voice, so the receptionist talked over them.
 */
const MIN_VOICED_RMS = 250;
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

  private readonly recent: number[] = [];

  /** Starts from a typical quiet phone line; the floor adapts from there. */
  constructor(initialFloor = 60) {
    this.recent.push(initialFloor);
  }

  /** The noise floor: the quietest fifth of recent frames. */
  get floor(): number {
    const sorted = [...this.recent].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 5)] ?? sorted[0] ?? 0;
  }

  /** Feeds one frame of caller audio; returns whether it was voiced. */
  feed(frame: Buffer): boolean {
    const ms = frame.length / BYTES_PER_MS;
    const rms = frameRms(frame);
    const voiced = rms >= MIN_VOICED_RMS && rms >= this.floor * FLOOR_RATIO;

    this.totalMs += ms;
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
