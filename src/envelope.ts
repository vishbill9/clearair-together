import type { ErrorCode } from './errors.js';

export const SCHEMA_VERSION = '2026-11-01';

export interface SafeError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export type Envelope<T> =
  | { requestId: string; schemaVersion: string; data: T }
  | { requestId: string; schemaVersion: string; error: SafeError };

export const ok = <T>(requestId: string, data: T): Envelope<T> => ({
  requestId,
  schemaVersion: SCHEMA_VERSION,
  data,
});

export const fail = (requestId: string, error: SafeError): Envelope<never> => ({
  requestId,
  schemaVersion: SCHEMA_VERSION,
  error,
});
