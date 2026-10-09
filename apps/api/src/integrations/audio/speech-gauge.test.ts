import { describe, expect, it } from 'vitest';

import { linearToMulaw } from './g711';
import { MIN_VOICED_RMS, QUIET_VOICED_RMS, SpeechGauge, VoiceLevel, frameRms } from './speech-gauge';

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

  it('hears a caller quieter than the usual bar when told their level', () => {
    // A real call: the caller's voice sat under the usual bar, the gauge heard 0 ms, and the reply talked over them.
    const soft = tone(280); // RMS ~200
    expect(new SpeechGauge().feed(soft)).toBe(false);
    expect(new SpeechGauge(undefined, QUIET_VOICED_RMS).feed(soft)).toBe(true);
    // A quiet line still is not a voice.
    expect(new SpeechGauge(undefined, QUIET_VOICED_RMS).feed(tone(150))).toBe(false);
  });

  it('keeps the loudest frame, for the trail', () => {
    const gauge = new SpeechGauge();
    gauge.feed(tone(280));
    gauge.feed(SILENCE);
    expect(Math.round(gauge.loudestRms)).toBe(Math.round(frameRms(tone(280))));
  });
});

describe('VoiceLevel', () => {
  it('keeps the usual bar until it has heard half a second of the caller', () => {
    const voice = new VoiceLevel();
    for (let i = 0; i < 10; i += 1) voice.feed(tone(280));
    expect(voice.minVoicedRms).toBe(MIN_VOICED_RMS);
  });

  it('lowers the bar for a quiet caller, never below the quiet minimum, and ignores the pauses between words', () => {
    const voice = new VoiceLevel();
    for (let i = 0; i < 40; i += 1) {
      voice.feed(tone(280)); // RMS ~200
      voice.feed(SILENCE);
    }
    expect(voice.minVoicedRms).toBe(QUIET_VOICED_RMS);

    const louder = new VoiceLevel();
    for (let i = 0; i < 40; i += 1) louder.feed(tone(560)); // RMS ~400
    expect(louder.minVoicedRms).toBeGreaterThan(QUIET_VOICED_RMS);
    expect(louder.minVoicedRms).toBeLessThan(MIN_VOICED_RMS);
  });

  it('never raises the bar for a loud caller', () => {
    const voice = new VoiceLevel();
    for (let i = 0; i < 40; i += 1) voice.feed(tone(6000));
    expect(voice.minVoicedRms).toBe(MIN_VOICED_RMS);
  });
});
