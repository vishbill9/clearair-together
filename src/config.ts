import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const intInRange = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intInRange(3000, 1, 65535),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: optionalString,
  GOOGLE_AIR_QUALITY_API_KEY: optionalString,
  GOOGLE_AIR_QUALITY_BASE_URL: z.string().url().default('https://airquality.googleapis.com'),
  ANTHROPIC_API_KEY: optionalString,
  SESSION_SECRET: optionalString,
  AI_MODEL: z.string().min(1).default('claude-3-5-sonnet-latest'),
  AIR_QUALITY_CACHE_TTL_SECONDS: intInRange(900, 0, 86_400),
  AIR_QUALITY_STALE_MAX_SECONDS: intInRange(21_600, 0, 172_800),
  MAX_FORECAST_HOURS: intInRange(96, 1, 96),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ALLOWED_ORIGINS: z.string().optional().default(''),
  FRAME_ANCESTORS: z.string().optional().default(''),
  TRUST_PROXY: bool,
  GOOGLE_GEMINI_API_KEY: optionalString,
  GOOGLE_GEMINI_LIVE_MODEL: optionalString,
  GOOGLE_GEMINI_VISION_MODEL: optionalString,
  LIVE_AI_ENABLED: bool,
  MAX_LIVE_SESSION_SECONDS: intInRange(300, 2, 3600),
  LIVE_IDLE_TIMEOUT_SECONDS: intInRange(30, 1, 600),
  MAX_IMAGE_BYTES: intInRange(5_242_880, 10_000, 20_000_000),
  MAX_IMAGE_DIMENSION: intInRange(4096, 64, 12_000),
  IMAGE_ENCRYPTION_KEY: optionalString,
  IMAGE_RETENTION_DAYS: intInRange(30, 1, 365),
  VISION_RATE_LIMIT_PER_MINUTE: intInRange(6, 1, 600),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  appOrigin: string;
  databaseUrl?: string;
  google: { apiKey?: string; baseUrl: string };
  anthropicApiKey?: string;
  sessionSecret: string;
  aiModel: string;
  airQuality: { cacheTtlSeconds: number; staleMaxSeconds: number; maxForecastHours: number };
  logLevel: string;
  corsAllowedOrigins: string[];
  frameAncestors: string[];
  trustProxy: boolean;
  live: {
    enabled: boolean;
    geminiApiKey?: string;
    liveModel?: string;
    visionModel?: string;
    maxSessionSeconds: number;
    idleTimeoutSeconds: number;
  };
  images: {
    maxBytes: number;
    maxDimension: number;
    encryptionKey?: Buffer;
    retentionDays: number;
    visionRateLimitPerMinute: number;
  };
  /** Which upstream integrations have credentials. Used to show explicit "not configured" states. */
  integrations: {
    database: boolean;
    googleAirQuality: boolean;
    assistant: boolean;
    live: boolean;
    vision: boolean;
  };
}

export class ConfigError extends Error {}

const DEV_SESSION_SECRET_MESSAGE =
  'SESSION_SECRET is not set; using a random per-process secret (development only).';

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  warn: (m: string) => void = () => {},
): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  if (isProduction) {
    const missing: string[] = [];
    if (!e.DATABASE_URL) missing.push('DATABASE_URL');
    if (!e.GOOGLE_AIR_QUALITY_API_KEY) missing.push('GOOGLE_AIR_QUALITY_API_KEY');
    if (!e.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
    if (!e.SESSION_SECRET) missing.push('SESSION_SECRET');
    if (e.LIVE_AI_ENABLED) {
      if (!e.GOOGLE_GEMINI_API_KEY) missing.push('GOOGLE_GEMINI_API_KEY');
      if (!e.GOOGLE_GEMINI_LIVE_MODEL) missing.push('GOOGLE_GEMINI_LIVE_MODEL');
    }
    if (missing.length)
      throw new ConfigError(`Missing required production configuration: ${missing.join(', ')}`);
    if (e.SESSION_SECRET && e.SESSION_SECRET.length < 32) {
      throw new ConfigError('SESSION_SECRET must be at least 32 characters in production.');
    }
    if (new URL(e.APP_ORIGIN).protocol !== 'https:') {
      throw new ConfigError('APP_ORIGIN must use https in production.');
    }
    if (new URL(e.GOOGLE_AIR_QUALITY_BASE_URL).host !== 'airquality.googleapis.com') {
      throw new ConfigError('GOOGLE_AIR_QUALITY_BASE_URL may only be overridden outside production.');
    }
  }

  let sessionSecret = e.SESSION_SECRET;
  if (!sessionSecret) {
    warn(DEV_SESSION_SECRET_MESSAGE);
    sessionSecret = cryptoRandom();
  }

  let encryptionKey: Buffer | undefined;
  if (e.IMAGE_ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(e.IMAGE_ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32)
      throw new ConfigError('IMAGE_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
  }

  const splitList = (v: string) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    appOrigin: new URL(e.APP_ORIGIN).origin,
    databaseUrl: e.DATABASE_URL,
    google: {
      apiKey: e.GOOGLE_AIR_QUALITY_API_KEY,
      baseUrl: e.GOOGLE_AIR_QUALITY_BASE_URL.replace(/\/$/, ''),
    },
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    sessionSecret,
    aiModel: e.AI_MODEL,
    airQuality: {
      cacheTtlSeconds: e.AIR_QUALITY_CACHE_TTL_SECONDS,
      staleMaxSeconds: e.AIR_QUALITY_STALE_MAX_SECONDS,
      maxForecastHours: e.MAX_FORECAST_HOURS,
    },
    logLevel: e.LOG_LEVEL,
    corsAllowedOrigins: splitList(e.CORS_ALLOWED_ORIGINS),
    frameAncestors: splitList(e.FRAME_ANCESTORS),
    trustProxy: e.TRUST_PROXY,
    live: {
      enabled: e.LIVE_AI_ENABLED,
      geminiApiKey: e.GOOGLE_GEMINI_API_KEY,
      liveModel: e.GOOGLE_GEMINI_LIVE_MODEL,
      visionModel: e.GOOGLE_GEMINI_VISION_MODEL,
      maxSessionSeconds: e.MAX_LIVE_SESSION_SECONDS,
      idleTimeoutSeconds: e.LIVE_IDLE_TIMEOUT_SECONDS,
    },
    images: {
      maxBytes: e.MAX_IMAGE_BYTES,
      maxDimension: e.MAX_IMAGE_DIMENSION,
      encryptionKey,
      retentionDays: e.IMAGE_RETENTION_DAYS,
      visionRateLimitPerMinute: e.VISION_RATE_LIMIT_PER_MINUTE,
    },
    integrations: {
      database: Boolean(e.DATABASE_URL),
      googleAirQuality: Boolean(e.GOOGLE_AIR_QUALITY_API_KEY),
      assistant: Boolean(e.ANTHROPIC_API_KEY),
      live: e.LIVE_AI_ENABLED && Boolean(e.GOOGLE_GEMINI_API_KEY && e.GOOGLE_GEMINI_LIVE_MODEL),
      vision: Boolean(e.GOOGLE_GEMINI_API_KEY && e.GOOGLE_GEMINI_VISION_MODEL),
    },
  };
}

import { randomBytes } from 'node:crypto';
function cryptoRandom(): string {
  return randomBytes(48).toString('base64url');
}
