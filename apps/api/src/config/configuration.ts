/**
 * Environment configuration, validated at boot.
 *
 * The application refuses to start on invalid configuration rather than
 * discovering it mid-call. A missing Twilio auth token should be a failed
 * deploy, not a caller listening to silence.
 */

import { z } from 'zod';

const trimmedString = z.string().trim();

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: trimmedString.url().default('http://localhost:3000'),

    DATABASE_URL: trimmedString.min(1),
    DATABASE_MIGRATION_URL: trimmedString.min(1).optional(),
    REDIS_URL: trimmedString.min(1).default('redis://localhost:6379'),

    JWT_ACCESS_SECRET: trimmedString.min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: trimmedString.min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: trimmedString.default('15m'),
    JWT_REFRESH_TTL: trimmedString.default('30d'),

    AI_PROVIDER: z.enum(['anthropic', 'openai', 'stub']).default('stub'),
    ANTHROPIC_API_KEY: trimmedString.optional(),
    AI_ANTHROPIC_EXTRACTION_MODEL: trimmedString.default('claude-opus-5'),
    AI_ANTHROPIC_RESPONSE_MODEL: trimmedString.default('claude-opus-5'),
    OPENAI_API_KEY: trimmedString.optional(),
    AI_OPENAI_EXTRACTION_MODEL: trimmedString.default('gpt-4o'),
    AI_OPENAI_RESPONSE_MODEL: trimmedString.default('gpt-4o'),

    VOICE_PIPELINE: z.enum(['gather', 'stream']).default('gather'),
    TWILIO_ACCOUNT_SID: trimmedString.optional(),
    TWILIO_AUTH_TOKEN: trimmedString.optional(),
    TWILIO_VALIDATE_SIGNATURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    TWILIO_TTS_VOICE: trimmedString.default('Polly.Joanna'),

    DEEPGRAM_API_KEY: trimmedString.optional(),
    DEEPGRAM_MODEL: trimmedString.default('nova-3'),
    ELEVENLABS_API_KEY: trimmedString.optional(),
    ELEVENLABS_VOICE_ID: trimmedString.optional(),

    WHATSAPP_PROVIDER: z.enum(['twilio', 'console']).default('console'),
    TWILIO_WHATSAPP_FROM: trimmedString.default('whatsapp:+14155238886'),
    TWILIO_WHATSAPP_CONTENT_SID: trimmedString.optional(),

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
    if (env.VOICE_PIPELINE === 'stream') {
      if (!env.DEEPGRAM_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DEEPGRAM_API_KEY'],
          message: 'DEEPGRAM_API_KEY is required when VOICE_PIPELINE=stream',
        });
      }
      if (!env.ELEVENLABS_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ELEVENLABS_API_KEY'],
          message: 'ELEVENLABS_API_KEY is required when VOICE_PIPELINE=stream',
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
