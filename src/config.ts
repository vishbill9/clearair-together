import { randomBytes } from 'node:crypto';
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
  GOOGLE_OAUTH_CLIENT_ID: optionalString,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalString,
  GOOGLE_AIR_QUALITY_BASE_URL: z.string().url().default('https://airquality.googleapis.com'),
  ANTHROPIC_API_KEY: optionalString,
  OLLAMA_API_KEY: optionalString,
  OLLAMA_MODEL: z.string().min(1).default('gemma4:31b'),
  OLLAMA_BASE_URL: z.string().url().default('https://ollama.com'),
  AI_PROVIDER: z.enum(['ollama', 'anthropic']).optional(),
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
  GOOGLE_GEMINI_CHAT_MODEL: optionalString,
  LIVE_AI_ENABLED: bool,
  MAX_LIVE_SESSION_SECONDS: intInRange(300, 2, 3600),
  LIVE_IDLE_TIMEOUT_SECONDS: intInRange(30, 1, 600),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  appOrigin: string;
  /** "Continue with Google"; null unless both the client id and secret are set. */
  googleLogin: { clientId: string; clientSecret: string } | null;
  databaseUrl?: string;
  google: { apiKey?: string; baseUrl: string };
  anthropicApiKey?: string;
  ollama: { apiKey?: string; model: string; baseUrl: string };
  /** Which assistant provider is active; null when no key is configured. */
  aiProvider: 'ollama' | 'anthropic' | null;
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
    /** Text model for the plant chat (Gemini generateContent). */
    chatModel?: string;
    liveModel?: string;
    maxSessionSeconds: number;
    idleTimeoutSeconds: number;
  };
  /** Which upstream integrations have credentials. Used to show explicit "not configured" states. */
  integrations: {
    database: boolean;
    googleAirQuality: boolean;
    googleLogin: boolean;
    assistant: boolean;
    live: boolean;
    plantChat: boolean;
  };
}

export class ConfigError extends Error {}

const DEV_SESSION_SECRET_MESSAGE =
  'SESSION_SECRET is not set; using a random per-process secret (development only).';

type Env = z.infer<typeof envSchema>;
type AiProviderName = 'ollama' | 'anthropic';

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new ConfigError(`Invalid environment configuration: ${issues}`);
}

/** An explicit AI_PROVIDER wins; otherwise Ollama is preferred when both keys are set. */
export function chooseAiProvider(
  e: Partial<Pick<Env, 'AI_PROVIDER' | 'OLLAMA_API_KEY' | 'ANTHROPIC_API_KEY'>>,
): AiProviderName | null {
  const available: Record<AiProviderName, boolean> = {
    ollama: Boolean(e.OLLAMA_API_KEY),
    anthropic: Boolean(e.ANTHROPIC_API_KEY),
  };
  if (e.AI_PROVIDER) return available[e.AI_PROVIDER] ? e.AI_PROVIDER : null;
  return (['ollama', 'anthropic'] as const).find((p) => available[p]) ?? null;
}

/** Keys production cannot start without; each entry names what to set. */
function missingProductionKeys(e: Env): string[] {
  const required: Array<[boolean, string]> = [
    [!e.DATABASE_URL, 'DATABASE_URL'],
    [!e.GOOGLE_AIR_QUALITY_API_KEY, 'GOOGLE_AIR_QUALITY_API_KEY'],
    [!e.ANTHROPIC_API_KEY && !e.OLLAMA_API_KEY, 'OLLAMA_API_KEY (or ANTHROPIC_API_KEY)'],
    [e.AI_PROVIDER === 'ollama' && !e.OLLAMA_API_KEY, 'OLLAMA_API_KEY'],
    [e.AI_PROVIDER === 'anthropic' && !e.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY'],
    [!e.SESSION_SECRET, 'SESSION_SECRET'],
    [e.LIVE_AI_ENABLED && !e.GOOGLE_GEMINI_API_KEY, 'GOOGLE_GEMINI_API_KEY'],
    [e.LIVE_AI_ENABLED && !e.GOOGLE_GEMINI_LIVE_MODEL, 'GOOGLE_GEMINI_LIVE_MODEL'],
  ];
  return required.filter(([isMissing]) => isMissing).map(([, key]) => key);
}

/** Production fails fast rather than running half-configured or with unsafe overrides. */
function assertProductionReady(e: Env): void {
  const missing = missingProductionKeys(e);
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

const splitList = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const trimSlash = (url: string) => url.replace(/\/$/, '');

function integrationFlags(e: Env, aiProvider: AiProviderName | null): Config['integrations'] {
  return {
    database: Boolean(e.DATABASE_URL),
    googleAirQuality: Boolean(e.GOOGLE_AIR_QUALITY_API_KEY),
    googleLogin: Boolean(e.GOOGLE_OAUTH_CLIENT_ID && e.GOOGLE_OAUTH_CLIENT_SECRET),
    assistant: aiProvider !== null,
    live: e.LIVE_AI_ENABLED && Boolean(e.GOOGLE_GEMINI_API_KEY && e.GOOGLE_GEMINI_LIVE_MODEL),
    plantChat: Boolean(e.GOOGLE_GEMINI_API_KEY && e.GOOGLE_GEMINI_CHAT_MODEL),
  };
}

function buildConfig(e: Env, sessionSecret: string): Config {
  const aiProvider = chooseAiProvider(e);
  const { GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret } = e;
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    appOrigin: new URL(e.APP_ORIGIN).origin,
    googleLogin: clientId && clientSecret ? { clientId, clientSecret } : null,
    databaseUrl: e.DATABASE_URL,
    google: { apiKey: e.GOOGLE_AIR_QUALITY_API_KEY, baseUrl: trimSlash(e.GOOGLE_AIR_QUALITY_BASE_URL) },
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    ollama: { apiKey: e.OLLAMA_API_KEY, model: e.OLLAMA_MODEL, baseUrl: trimSlash(e.OLLAMA_BASE_URL) },
    aiProvider,
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
      chatModel: e.GOOGLE_GEMINI_CHAT_MODEL,
      maxSessionSeconds: e.MAX_LIVE_SESSION_SECONDS,
      idleTimeoutSeconds: e.LIVE_IDLE_TIMEOUT_SECONDS,
    },
    integrations: integrationFlags(e, aiProvider),
  };
}

/** Reads and validates the environment once at start-up. Throws `ConfigError` with a clear message. */
export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  warn: (m: string) => void = () => {},
): Config {
  const e = parseEnv(source);
  if (Boolean(e.GOOGLE_OAUTH_CLIENT_ID) !== Boolean(e.GOOGLE_OAUTH_CLIENT_SECRET)) {
    throw new ConfigError('Set both GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, or neither.');
  }
  if (e.NODE_ENV === 'production') assertProductionReady(e);
  if (e.SESSION_SECRET) return buildConfig(e, e.SESSION_SECRET);
  warn(DEV_SESSION_SECRET_MESSAGE);
  return buildConfig(e, randomBytes(48).toString('base64url'));
}
