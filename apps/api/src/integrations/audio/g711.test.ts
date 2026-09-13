import { describe, expect, it } from 'vitest';

import { Pcm24kToMulaw8k, linearToMulaw, mulawToLinear, mulawToWav } from './g711';

/** A 24 kHz 16-bit little-endian sine wave. */
function sine(frequencyHz: number, seconds: number, amplitude = 12_000): Buffer {
  const samples = Math.round(24_000 * seconds);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / 24_000)), i * 2);
  }
  return buffer;
}

function rms(mulaw: Buffer, skip = 40): number {
  let sum = 0;
  let n = 0;
  // The first few output samples are the filter filling up.
  for (let i = skip; i < mulaw.length; i += 1) {
    const s = mulawToLinear(mulaw[i]!);
    sum += s * s;
    n += 1;
  }
  return Math.sqrt(sum / n);
}

describe('G.711 μ-law', () => {
  it('encodes the reference points', () => {
    expect(linearToMulaw(0)).toBe(0xff);
    expect(linearToMulaw(32767)).toBe(0x80);
    expect(linearToMulaw(-32768)).toBe(0x00);
  });

  it('round-trips within the quantisation error of the band', () => {
    for (const sample of [-30000, -8000, -1000, -100, 0, 100, 1000, 8000, 30000]) {
      const decoded = mulawToLinear(linearToMulaw(sample));
      // μ-law steps grow with amplitude; ~6% plus a small floor is the spec.
      expect(Math.abs(decoded - sample)).toBeLessThanOrEqual(Math.abs(sample) * 0.07 + 40);
    }
  });
});

describe('24 kHz PCM → 8 kHz μ-law', () => {
  it('produces one output sample for every three input samples', () => {
    const input = sine(1000, 1);
    const output = new Pcm24kToMulaw8k().push(input);
    expect(output.length).toBe(8000);
  });

  it('keeps a voice-band tone at full strength', () => {
    const output = new Pcm24kToMulaw8k().push(sine(1000, 0.5));
    const expected = 12_000 / Math.SQRT2;
    expect(rms(output)).toBeGreaterThan(expected * 0.9);
    expect(rms(output)).toBeLessThan(expected * 1.1);
  });

  it('removes content above 4 kHz instead of folding it back as hiss', () => {
    // 7 kHz would alias to an audible 1 kHz without the low-pass filter.
    const output = new Pcm24kToMulaw8k().push(sine(7000, 0.5));
    expect(rms(output)).toBeLessThan((12_000 / Math.SQRT2) * 0.05);
  });

  it('gives identical output however the network splits the stream', () => {
    const input = sine(440, 0.3);
    const whole = new Pcm24kToMulaw8k().push(input);

    // Deliberately awkward chunk sizes, including splits mid-sample.
    const converter = new Pcm24kToMulaw8k();
    const parts: Buffer[] = [];
    let offset = 0;
    const sizes = [1, 3, 7, 2, 1021, 5, 333, 4096];
    for (let i = 0; offset < input.length; i += 1) {
      const size = sizes[i % sizes.length]!;
      parts.push(converter.push(input.subarray(offset, offset + size)));
      offset += size;
    }

    expect(Buffer.concat(parts).equals(whole)).toBe(true);
  });

  it('writes a playable μ-law WAV header', () => {
    const wav = mulawToWav(Buffer.alloc(800, 0xff));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(20)).toBe(7);
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.length).toBe(58 + 800);
  });
});
