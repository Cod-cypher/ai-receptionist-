import { describe, expect, it } from 'vitest';

import { linearToMulaw } from './g711';
import { SpeechGauge, frameRms } from './speech-gauge';

/** 20 ms of μ-law at a sine wave of the given amplitude (16-bit scale). */
function tone(amplitude: number, frames = 1): Buffer {
  const out = Buffer.alloc(160 * frames);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = linearToMulaw(amplitude * Math.sin((2 * Math.PI * 440 * i) / 8000));
  }
  return out;
}

const SILENCE = Buffer.alloc(160, 0xff);

describe('SpeechGauge', () => {
  it('measures μ-law silence as silence and a loud tone as loud', () => {
    expect(frameRms(SILENCE)).toBeLessThan(10);
    expect(frameRms(tone(8000))).toBeGreaterThan(4000);
  });

  it('counts voiced milliseconds and the silence after them', () => {
    const gauge = new SpeechGauge();
    for (let i = 0; i < 15; i += 1) gauge.feed(tone(6000)); // 300 ms of speech
    expect(gauge.voicedMs).toBe(300);
    expect(gauge.trailingSilenceMs).toBe(0);

    for (let i = 0; i < 12; i += 1) gauge.feed(SILENCE); // 240 ms of quiet
    expect(gauge.voicedMs).toBe(300);
    expect(gauge.trailingSilenceMs).toBe(240);
    expect(gauge.totalMs).toBe(540);
  });

  it('does not mistake line noise for speech', () => {
    const gauge = new SpeechGauge();
    for (let i = 0; i < 25; i += 1) gauge.feed(tone(200)); // hiss well below speech level
    expect(gauge.voicedMs).toBe(0);
    expect(gauge.trailingSilenceMs).toBe(500);
  });

  it('hears a quiet caller', () => {
    const gauge = new SpeechGauge();
    expect(gauge.feed(tone(500))).toBe(true); // RMS ~350: soft speech on a handset
  });

  it('raises the bar on a noisy line so speech must stand out from it', () => {
    const gauge = new SpeechGauge();
    for (let i = 0; i < 50; i += 1) gauge.feed(tone(320)); // constant noise just under the absolute threshold
    const floor = gauge.floor;
    expect(floor).toBeGreaterThan(200);
    expect(gauge.feed(tone(600))).toBe(false); // above the absolute minimum, but not above the line's noise
    expect(gauge.feed(tone(6000))).toBe(true);
  });
});
