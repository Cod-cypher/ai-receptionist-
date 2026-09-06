/**
 * Speech synthesis.
 *
 * Streaming rather than a single buffer, for two reasons that both matter on a
 * phone call:
 *
 *  - the caller hears the first syllable while the rest is still being
 *    generated, which removes most of the perceived latency of a turn
 *  - synthesis can be abandoned mid-sentence when the caller interrupts, which
 *    is what makes barge-in feel like talking to a person rather than to a
 *    voicemail system
 */

export interface TtsRequest {
  text: string;
  /** Provider-specific voice identifier, from the business's settings. */
  voiceId?: string;
  /** Aborts synthesis when the caller starts speaking. */
  signal?: AbortSignal;
}

export interface TtsProvider {
  readonly name: string;
  /**
   * Yields raw audio chunks in 8 kHz mu-law, the encoding telephony uses, so
   * the frames can go straight out without transcoding.
   */
  stream(request: TtsRequest): AsyncIterable<Buffer>;
}

export const TTS_PROVIDER = Symbol('TTS_PROVIDER');
