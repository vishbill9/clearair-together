import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, type ErrorCode } from './errors.js';
import { fail } from './envelope.js';

interface PublicError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/** Framework errors mapped to safe public messages, by status code. */
const FRAMEWORK_ERRORS: Record<number, Omit<PublicError, 'status'>> = {
  413: { code: 'payload_too_large', message: 'The request body is too large.' },
  415: { code: 'unsupported_media_type', message: 'Unsupported content type.' },
  429: { code: 'rate_limited', message: 'Too many requests. Please slow down and try again shortly.' },
};

const INTERNAL: PublicError = {
  status: 500,
  code: 'internal_error',
  message: 'Something went wrong on our side.',
};

/** Maps any thrown error to what the client may see. Unknown errors never leak details. */
export function toPublicError(err: unknown): PublicError {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof ZodError) {
    return { status: 400, code: 'validation_error', message: 'The request was not valid.' };
  }
  const e = err as Partial<FastifyError>;
  const status = e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 413 : (e.statusCode ?? 500);
  const known = FRAMEWORK_ERRORS[status];
  if (known) return { status, ...known };
  if (status >= 400 && status < 500) {
    return { status, code: 'validation_error', message: 'The request could not be processed.' };
  }
  return INTERNAL;
}

function sendError(req: FastifyRequest, reply: FastifyReply, err: unknown) {
  const p = toPublicError(err);
  if (p === INTERNAL) {
    const { message, name } = err as Error;
    req.log.error({ err: { message, name } }, 'unhandled error');
  } else if (p.status >= 500) {
    req.log.error({ code: p.code }, p.message);
  }
  const body = { code: p.code, message: p.message, ...(p.details ? { details: p.details } : {}) };
  return reply.code(p.status).send(fail(req.id, body));
}

/** JSON error envelope for every failure, plus 404s that differ for API and static paths. */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => sendError(req, reply, err));
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send(fail(req.id, { code: 'not_found', message: 'Not found.' }));
    }
    return reply.code(404).type('text/plain').send('Not found');
  });
}
