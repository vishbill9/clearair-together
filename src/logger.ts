import { pino, type Logger, type LoggerOptions } from 'pino';

/** Paths whose values must never reach logs. Wildcards cover nested request/response objects. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.apiKey',
  '*.api_key',
  '*.key',
  '*.token',
  '*.secret',
  '*.sessionSecret',
  '*.GOOGLE_AIR_QUALITY_API_KEY',
  '*.GOOGLE_GEMINI_API_KEY',
  '*.ANTHROPIC_API_KEY',
  '*.OLLAMA_API_KEY',
  '*.SESSION_SECRET',
  '*.DATABASE_URL',
  '*.audio',
  '*.imageBase64',
  '*.image',
  '*.data',
  'audio',
  'imageBase64',
  'image',
  'authorization',
  'cookie',
  'password',
  'apiKey',
  'api_key',
  'key',
  'token',
  'secret',
  'sessionSecret',
  'GOOGLE_AIR_QUALITY_API_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OLLAMA_API_KEY',
  'SESSION_SECRET',
  'DATABASE_URL',
  'data',
];

function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    base: { service: 'clearair-together' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
}

export function createLogger(level: string, destination?: NodeJS.WritableStream): Logger {
  return destination ? pino(loggerOptions(level), destination) : pino(loggerOptions(level));
}

/** Removes `key=...` query parameters (e.g. Google API keys) from any URL-like string before logging. */
export function scrubUrl(input: string): string {
  return input.replace(/([?&](?:key|api_key|apikey|token)=)[^&\s"']+/gi, '$1[Redacted]');
}
