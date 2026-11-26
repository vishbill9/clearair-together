export type ErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'csrf_failed'
  | 'rate_limited'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'not_configured'
  | 'upstream_unavailable'
  | 'upstream_auth_failed'
  | 'upstream_rate_limited'
  | 'upstream_bad_response'
  | 'ai_unavailable'
  | 'ai_bad_output'
  | 'safety_blocked'
  | 'conflict'
  | 'internal_error';

/** An error whose message is safe to show to end users. Everything else becomes `internal_error`. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new AppError('not_found', 404, `${what} not found.`);
export const unauthorized = () =>
  new AppError('unauthorized', 401, 'A session is required for this request.');
export const validationError = (message: string, details?: unknown) =>
  new AppError('validation_error', 400, message, details);
export const notConfigured = (what: string) =>
  new AppError('not_configured', 503, `${what} is not configured on this server.`);
