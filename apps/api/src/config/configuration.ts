/**
 * Environment configuration, validated at boot.
 *
 * The application refuses to start on invalid configuration rather than
 * discovering it mid-call. A missing Twilio auth token should be a failed
 * deploy, not a caller listening to silence.
 */

import { z } from 'zod';

const trimmedString = z.string().trim();

/**
 * Treats an empty variable as absent.
 *
 * `.env.example` ships every optional key as `KEY=`, so an unset value arrives
 * as `''` rather than undefined. Zod's `.optional()` only permits undefined, so
 * without this an untouched `OPENAI_BASE_URL=` fails `.url()` and the whole
 * application refuses to boot — a confusing failure for a key the operator
 * deliberately left blank.
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(unsetIfBlank, schema.optional());
}

/** An empty variable as unset, so a default applies rather than `''` coerced to 0. */
function unsetIfBlank(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: trimmedString.url().default('http://localhost:3000'),

    DATABASE_URL: trimmedString.min(1),
    DATABASE_MIGRATION_URL: optional(trimmedString.min(1)),
    REDIS_URL: trimmedString.min(1).default('redis://localhost:6379'),

    JWT_ACCESS_SECRET: trimmedString.min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: trimmedString.min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: trimmedString.default('15m'),
    JWT_REFRESH_TTL: trimmedString.default('30d'),

    AI_PROVIDER: z.enum(['anthropic', 'openai', 'stub']).default('stub'),
    ANTHROPIC_API_KEY: optional(trimmedString),
    AI_ANTHROPIC_EXTRACTION_MODEL: trimmedString.default('claude-opus-5'),
    AI_ANTHROPIC_RESPONSE_MODEL: trimmedString.default('claude-opus-5'),
    OPENAI_API_KEY: optional(trimmedString),
    /**
     * Points the OpenAI adapter at an OpenAI-compatible gateway — OpenRouter,
     * Together, Groq, a local vLLM. Leave unset for OpenAI itself.
     */
    OPENAI_BASE_URL: optional(trimmedString.url()),
    AI_OPENAI_EXTRACTION_MODEL: trimmedString.default('gpt-4o'),
    AI_OPENAI_RESPONSE_MODEL: trimmedString.default('gpt-4o'),

    /**
     * gather  — Twilio recognises and speaks; simplest.
     * stream  — separate speech recognition and synthesis over a media stream.
     * chatgpt — one OpenAI realtime model listens, understands and speaks.
     */
    VOICE_PIPELINE: z.enum(['gather', 'stream', 'chatgpt']).default('gather'),
    TWILIO_ACCOUNT_SID: optional(trimmedString),
    TWILIO_AUTH_TOKEN: optional(trimmedString),
    TWILIO_VALIDATE_SIGNATURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    TWILIO_TTS_VOICE: trimmedString.default('Polly.Joanna'),

    // Stream pipeline speech providers. Setting an OpenAI model selects OpenAI
    // for that half; otherwise Deepgram / ElevenLabs are used.
    AI_TRANSCRIPTION_MODEL: optional(trimmedString),
    AI_TRANSCRIPTION_SILENCE_MS: z.coerce.number().int().min(200).max(3000).default(600),
    AI_TTS_MODEL: optional(trimmedString),
    AI_TTS_VOICE: trimmedString.default('marin'),
    AI_TTS_INSTRUCTIONS: optional(trimmedString),

    // VOICE_PIPELINE=chatgpt: a speech-to-speech model for the whole call.
    AI_REALTIME_MODEL: trimmedString.default('gpt-realtime-mini'),
    AI_REALTIME_VOICE: trimmedString.default('marin'),
    AI_REALTIME_SILENCE_MS: z.coerce.number().int().min(200).max(3000).default(900),
    /**
     * How the caller's turn is ended. server_vad: after AI_REALTIME_SILENCE_MS
     * of quiet. semantic_vad: OpenAI also judges from the words whether the
     * caller has finished, so a pause to think does not end their turn.
     */
    AI_REALTIME_TURN_DETECTION: z.enum(['server_vad', 'semantic_vad']).default('server_vad'),
    /** semantic_vad only: how quickly a turn is ended. */
    AI_REALTIME_VAD_EAGERNESS: z.enum(['low', 'medium', 'high', 'auto']).default('auto'),
    /** OpenAI's input noise reduction. Phones are near-field. */
    AI_REALTIME_NOISE_REDUCTION: z.enum(['near_field', 'far_field', 'off']).default('near_field'),
    /** Playback speed of the receptionist's voice, 0.25 to 1.5. Unset: OpenAI's default of 1. Recorded fillers and greetings use it too. */
    AI_REALTIME_SPEED: optional(z.coerce.number().min(0.25).max(1.5)),
    /**
     * How long the first reply to a caller turn waits for their words to be
     * transcribed, from the end of the turn, so the model is told what they
     * said. On a real call they took 400 to 560 ms. 0 asks for the reply at
     * once, without them.
     */
    AI_REALTIME_WORDS_WAIT_MS: z.preprocess(unsetIfBlank, z.coerce.number().int().min(0).max(2000).default(500)),
    /** Transcribes the caller for the call record; the realtime model hears the audio itself. */
    // The larger model: on real calls the mini one, though told the language
    // is English, wrote caller lines in Korean, Arabic and Turkish, and the
    // judge reads these lines to take a yes.
    AI_REALTIME_TRANSCRIPTION_MODEL: trimmedString.default('gpt-4o-transcribe'),

    /**
     * TypeSafe Jev judges whether a location is precise enough to dispatch to
     * and whether the caller is in danger. Optional: without a key the regex
     * rules decide alone.
     */
    TYPESAFE_API_KEY: optional(trimmedString),
    TYPESAFE_MODEL: trimmedString.default('jev-latest'),
    /** Per request. A tool call waits for this, so it is short; on timeout the rules decide. */
    TYPESAFE_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(1500),

    DEEPGRAM_API_KEY: optional(trimmedString),
    DEEPGRAM_MODEL: trimmedString.default('nova-3'),
    ELEVENLABS_API_KEY: optional(trimmedString),
    ELEVENLABS_VOICE_ID: optional(trimmedString),

    WHATSAPP_PROVIDER: z.enum(['twilio', 'console']).default('console'),
    TWILIO_WHATSAPP_FROM: trimmedString.default('whatsapp:+14155238886'),
    TWILIO_WHATSAPP_CONTENT_SID: optional(trimmedString),

    RATE_LIMIT_TTL: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
    ENABLE_DEV_SIMULATOR: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  // Cross-field rules: a provider selected without its credentials is a
  // misconfiguration that would only surface on a live call.
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic',
      });
    }
    if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when AI_PROVIDER=openai',
      });
    }
    if (env.WHATSAPP_PROVIDER === 'twilio' && (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TWILIO_ACCOUNT_SID'],
        message: 'Twilio credentials are required when WHATSAPP_PROVIDER=twilio',
      });
    }
    if (env.VOICE_PIPELINE === 'chatgpt' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when VOICE_PIPELINE=chatgpt',
      });
    }
    if (env.VOICE_PIPELINE === 'stream') {
      if (env.AI_TRANSCRIPTION_MODEL) {
        if (!env.OPENAI_API_KEY) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['OPENAI_API_KEY'],
            message: 'OPENAI_API_KEY is required when AI_TRANSCRIPTION_MODEL is set',
          });
        }
      } else if (!env.DEEPGRAM_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AI_TRANSCRIPTION_MODEL'],
          message:
            'VOICE_PIPELINE=stream needs speech recognition: set AI_TRANSCRIPTION_MODEL (OpenAI) or DEEPGRAM_API_KEY',
        });
      }

      if (env.AI_TTS_MODEL) {
        if (!env.OPENAI_API_KEY) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['OPENAI_API_KEY'],
            message: 'OPENAI_API_KEY is required when AI_TTS_MODEL is set',
          });
        }
      } else if (!env.ELEVENLABS_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AI_TTS_MODEL'],
          message:
            'VOICE_PIPELINE=stream needs a voice: set AI_TTS_MODEL (OpenAI) or ELEVENLABS_API_KEY',
        });
      }
    }
    if (env.NODE_ENV === 'production') {
      if (env.ENABLE_DEV_SIMULATOR) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ENABLE_DEV_SIMULATOR'],
          message:
            'ENABLE_DEV_SIMULATOR must be false in production: it exposes an unauthenticated conversation endpoint',
        });
      }
      if (!env.TWILIO_VALIDATE_SIGNATURE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TWILIO_VALIDATE_SIGNATURE'],
          message:
            'TWILIO_VALIDATE_SIGNATURE must be true in production: it is what stops forged call webhooks',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): AppConfig {
  const result = EnvSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}
