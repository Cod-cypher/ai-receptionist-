/**
 * ElevenLabs streaming speech synthesis.
 *
 * Requests `ulaw_8000` directly, which is exactly what Twilio's media stream
 * expects, so audio goes from the synthesiser to the caller with no resampling
 * or re-encoding anywhere in the path.
 */

import { Logger } from '@nestjs/common';

import type { TtsProvider, TtsRequest } from './tts-provider.interface';

export interface ElevenLabsOptions {
  apiKey: string;
  /** Fallback when the business has not chosen a voice. */
  defaultVoiceId: string;
  /** Turbo models exist because latency matters more than nuance on a call. */
  modelId?: string;
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = 'elevenlabs';
  private readonly logger = new Logger('ElevenLabs');

  constructor(private readonly options: ElevenLabsOptions) {}

  async *stream(request: TtsRequest): AsyncIterable<Buffer> {
    const voiceId = request.voiceId ?? this.options.defaultVoiceId;
    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream` +
      '?output_format=ulaw_8000&optimize_streaming_latency=3';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.options.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/basic',
      },
      body: JSON.stringify({
        text: request.text,
        model_id: this.options.modelId ?? 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          // A receptionist should sound steady, not theatrical.
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `ElevenLabs synthesis failed (${response.status}): ${detail.slice(0, 300)}`,
      );
    }

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) yield Buffer.from(value);
      }
    } finally {
      // Abandoning mid-sentence is the normal case when a caller interrupts,
      // so releasing the reader must not depend on the stream finishing.
      reader.releaseLock();
      if (!response.bodyUsed) {
        await response.body.cancel().catch(() => undefined);
      }
    }
  }
}
