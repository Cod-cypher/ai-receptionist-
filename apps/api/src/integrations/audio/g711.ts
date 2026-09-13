/**
 * Telephone audio conversion.
 *
 * Twilio carries calls as 8 kHz G.711 μ-law. OpenAI's speech API streams 24 kHz
 * 16-bit PCM and has no telephone format, so every reply is resampled and
 * re-encoded on the way out.
 *
 * Resampling is a plain divide-by-three (24 000 / 8 000), but it must be
 * low-pass filtered first. Dropping two samples in three without a filter folds
 * everything above 4 kHz back down into the voice band as audible hiss — the
 * difference between a clean voice and a harsh one on a phone line.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** Exponent lookup for the top byte of a biased sample: floor(log2(i)), 0..7. */
const EXPONENT = new Uint8Array(256);
for (let i = 2; i < 256; i += 1) EXPONENT[i] = Math.min(7, Math.floor(Math.log2(i)));

/** Encodes one signed 16-bit sample as a G.711 μ-law byte. */
export function linearToMulaw(input: number): number {
  let sample = Math.max(-32768, Math.min(32767, Math.round(input)));
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  const exponent = EXPONENT[(sample >> 7) & 0xff]!;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decodes a G.711 μ-law byte to a signed 16-bit sample. Used by tests and tools. */
export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

/* -------------------------------------------------------------------------- */
/*  24 kHz → 8 kHz                                                            */
/* -------------------------------------------------------------------------- */

const INPUT_RATE = 24_000;
const DECIMATION = 3;
const TAPS = 31;
/** Just under the 4 kHz limit of the output, and above the telephone voice band. */
const CUTOFF_HZ = 3_400;

/** Windowed-sinc low-pass filter (Hamming), normalised to unity gain. */
const FILTER: Float64Array = (() => {
  const h = new Float64Array(TAPS);
  const centre = (TAPS - 1) / 2;
  const fc = CUTOFF_HZ / INPUT_RATE;
  let sum = 0;
  for (let n = 0; n < TAPS; n += 1) {
    const x = n - centre;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (TAPS - 1));
    h[n] = sinc * window;
    sum += h[n]!;
  }
  for (let n = 0; n < TAPS; n += 1) h[n] = h[n]! / sum;
  return h;
})();

/**
 * Streaming converter from 24 kHz 16-bit little-endian PCM to 8 kHz μ-law.
 *
 * Network chunks arrive at arbitrary byte boundaries, including in the middle
 * of a sample, so a trailing odd byte and the filter's history are carried
 * between calls. Feeding the same audio in one piece or in a thousand pieces
 * produces identical output.
 */
export class Pcm24kToMulaw8k {
  private readonly history = new Float64Array(TAPS);
  private position = 0;
  private phase = 0;
  private carry: number | null = null;

  push(chunk: Buffer): Buffer {
    let bytes = chunk;
    if (this.carry !== null) {
      bytes = Buffer.concat([Buffer.from([this.carry]), chunk]);
      this.carry = null;
    }

    const samples = Math.floor(bytes.length / 2);
    if (bytes.length % 2 === 1) this.carry = bytes[bytes.length - 1]!;

    const out = Buffer.allocUnsafe(Math.ceil(samples / DECIMATION) + 1);
    let written = 0;

    for (let i = 0; i < samples; i += 1) {
      this.history[this.position] = bytes.readInt16LE(i * 2);
      this.position = (this.position + 1) % TAPS;
      this.phase += 1;

      if (this.phase === DECIMATION) {
        this.phase = 0;
        let y = 0;
        for (let k = 0; k < TAPS; k += 1) {
          y += FILTER[k]! * this.history[(this.position + k) % TAPS]!;
        }
        out[written++] = linearToMulaw(y);
      }
    }

    return out.subarray(0, written);
  }
}

/**
 * Wraps raw 8 kHz μ-law in a WAV header (format 7), so a synthesised reply can
 * be saved and listened to exactly as a caller would hear it.
 */
export function mulawToWav(mulaw: Buffer): Buffer {
  const header = Buffer.alloc(58);
  header.write('RIFF', 0);
  header.writeUInt32LE(50 + mulaw.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(18, 16); // fmt chunk size
  header.writeUInt16LE(7, 20); // μ-law
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24); // sample rate
  header.writeUInt32LE(8000, 28); // byte rate
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.writeUInt16LE(0, 36); // extension size
  header.write('fact', 38);
  header.writeUInt32LE(4, 42);
  header.writeUInt32LE(mulaw.length, 46);
  header.write('data', 50);
  header.writeUInt32LE(mulaw.length, 54);
  return Buffer.concat([header, mulaw]);
}
