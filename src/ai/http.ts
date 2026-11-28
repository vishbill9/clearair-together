import { AiProviderError } from './provider.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JsonPost {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

const MAX_RESPONSE_CHARS = 200_000;

/** Maps an HTTP status to the provider error a caller can act on, or null when the response is usable. */
export function statusError(status: number): AiProviderError | null {
  if (status === 401 || status === 403) return new AiProviderError('auth');
  if (status === 429) return new AiProviderError('rate_limited');
  if (status >= 500) return new AiProviderError('server');
  if (status < 200 || status >= 300) return new AiProviderError('bad_response', `http:${status}`);
  return null;
}

/** True for the error `fetch` throws when its AbortSignal fires. */
export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

async function send(p: JsonPost): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), p.timeoutMs);
  try {
    return await (p.fetchImpl ?? fetch)(p.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...p.headers },
      body: JSON.stringify(p.body),
      signal: ctl.signal,
      redirect: 'error',
    });
  } catch (e) {
    throw new AiProviderError(isAbort(e) ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POSTs JSON to a model provider with a hard timeout and returns the parsed reply.
 * Every failure becomes an `AiProviderError` whose detail never contains user or model text.
 */
export async function postJson<T>(p: JsonPost): Promise<T> {
  const res = await send(p);
  const err = statusError(res.status);
  if (err) throw err;
  const text = await res.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new AiProviderError('bad_response', 'too_large');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AiProviderError('bad_response', 'unparseable');
  }
}
