import type { ZodType } from 'zod';
import { z } from 'zod';
import { validationError } from '../errors.js';

/** Parses with Zod and returns a safe error listing only paths and messages (never values). */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw validationError(
    'The request was not valid.',
    r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message.slice(0, 160) })),
  );
}

export const uuidParam = z.object({ id: z.uuid() }).strict();
