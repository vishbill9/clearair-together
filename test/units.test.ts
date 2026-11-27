import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError, z } from 'zod';
import { postJson, statusError } from '../src/ai/http.js';
import { AiProviderError } from '../src/ai/provider.js';
import { assistantProvider, plantChatProvider } from '../src/ai/providers.js';
import { chooseAiProvider, loadConfig } from '../src/config.js';
import { buildDailyPlan } from '../src/domain/plan.js';
import { toPublicError } from '../src/error-handler.js';
import { AppError } from '../src/errors.js';
import { normalizeCurrent } from '../src/google/normalize.js';
import { severityOf } from '../src/google/severity.js';
import { forecastWindow } from '../src/routes/air-quality.js';
import { currentBody } from './helpers/google-fixtures.js';

const BASE_ENV = { NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv;
const config = (env: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...env });

describe('chooseAiProvider', () => {
  it('prefers Ollama when both keys are set and nothing is chosen', () => {
    assert.equal(chooseAiProvider({ OLLAMA_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' }), 'ollama');
    assert.equal(chooseAiProvider({ ANTHROPIC_API_KEY: 'a' }), 'anthropic');
    assert.equal(chooseAiProvider({}), null);
  });
  it('honours an explicit choice only when its key is present', () => {
    assert.equal(
      chooseAiProvider({ AI_PROVIDER: 'anthropic', OLLAMA_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' }),
      'anthropic',
    );
    assert.equal(chooseAiProvider({ AI_PROVIDER: 'anthropic', OLLAMA_API_KEY: 'o' }), null);
  });
});

describe('provider factories', () => {
  it('builds the configured assistant provider, or none', () => {
    assert.equal(assistantProvider(config({ OLLAMA_API_KEY: 'o' }))?.name, 'ollama');
    assert.equal(assistantProvider(config({ ANTHROPIC_API_KEY: 'a' }))?.name, 'anthropic');
    assert.equal(assistantProvider(config()), null);
  });
  it('uses Gemini for plant chat, with the assistant as fallback when there is one', () => {
    const geminiOnly = config({ GOOGLE_GEMINI_API_KEY: 'g', GOOGLE_GEMINI_CHAT_MODEL: 'm' });
    assert.equal(plantChatProvider(geminiOnly, null, () => undefined)?.name, 'gemini');
    const assistant = assistantProvider(config({ OLLAMA_API_KEY: 'o' }));
    assert.equal(plantChatProvider(geminiOnly, assistant, () => undefined)?.name, 'gemini+ollama');
    assert.equal(
      plantChatProvider(config(), assistant, () => undefined),
      null,
    );
  });
});

describe('provider HTTP errors', () => {
  it('maps statuses to actionable kinds', () => {
    assert.equal(statusError(200), null);
    assert.equal(statusError(401)?.kind, 'auth');
    assert.equal(statusError(403)?.kind, 'auth');
    assert.equal(statusError(429)?.kind, 'rate_limited');
    assert.equal(statusError(503)?.kind, 'server');
    assert.equal(statusError(404)?.detail, 'http:404');
  });

  const post = (fetchImpl: (u: string, i: RequestInit) => Promise<Response>, timeoutMs = 1000) =>
    postJson({ url: 'https://example.test', headers: {}, body: {}, timeoutMs, fetchImpl });

  it('returns parsed JSON and rejects unparseable or oversized replies', async () => {
    assert.deepEqual(await post(async () => new Response('{"a":1}')), { a: 1 });
    await assert.rejects(
      post(async () => new Response('not json')),
      (e: AiProviderError) => e.detail === 'unparseable',
    );
    await assert.rejects(
      post(async () => new Response('x'.repeat(200_001))),
      (e: AiProviderError) => e.detail === 'too_large',
    );
  });

  it('reports a timeout separately from a network failure', async () => {
    const hang = (_u: string, i: RequestInit) =>
      new Promise<Response>((_, reject) =>
        i.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        ),
      );
    await assert.rejects(post(hang, 20), (e: AiProviderError) => e.kind === 'timeout');
    await assert.rejects(
      post(async () => {
        throw new TypeError('fetch failed');
      }),
      (e: AiProviderError) => e.kind === 'network',
    );
  });
});

describe('toPublicError', () => {
  it('passes app errors through and hides unknown ones', () => {
    assert.deepEqual(toPublicError(new AppError('not_found', 404, 'Missing.')), {
      status: 404,
      code: 'not_found',
      message: 'Missing.',
      details: undefined,
    });
    assert.equal(toPublicError(new Error('secret detail')).message, 'Something went wrong on our side.');
  });
  it('maps validation and framework errors to safe messages', () => {
    const zodErr = z.string().safeParse(1).error as ZodError;
    assert.equal(toPublicError(zodErr).code, 'validation_error');
    assert.equal(toPublicError({ statusCode: 429 }).code, 'rate_limited');
    assert.equal(toPublicError({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' }).status, 413);
    assert.equal(toPublicError({ statusCode: 415 }).code, 'unsupported_media_type');
    assert.equal(toPublicError({ statusCode: 404 }).code, 'validation_error');
  });
});

describe('forecastWindow', () => {
  const now = new Date('2026-11-27T10:20:00Z');
  it('defaults to the next full hour for up to 24 hours', () => {
    assert.deepEqual(forecastWindow(now, 96), {
      start: '2026-11-27T11:00:00.000Z',
      end: '2026-11-28T11:00:00.000Z',
    });
    assert.equal(forecastWindow(now, 6).end, '2026-11-27T17:00:00.000Z');
  });
  it('keeps an explicit window', () => {
    const w = forecastWindow(now, 96, '2026-11-27T12:00:00Z', '2026-11-27T15:00:00Z');
    assert.deepEqual(w, { start: '2026-11-27T12:00:00Z', end: '2026-11-27T15:00:00Z' });
  });
});

describe('severity bands at their edges', () => {
  const sev = (code: string, aqi: number) => severityOf({ code, displayName: '', aqi, category: '' });
  it('maps each scale in the right direction', () => {
    assert.deepEqual(
      [60, 59, 40, 39, 20, 19].map((v) => sev('uaqi', v)),
      ['good', 'moderate', 'moderate', 'unhealthy', 'unhealthy', 'very_unhealthy'],
    );
    assert.deepEqual(
      [50, 51, 101, 151, 201].map((v) => sev('usa_epa_nowcast', v)),
      ['good', 'moderate', 'sensitive', 'unhealthy', 'very_unhealthy'],
    );
    assert.deepEqual(
      [100, 101, 201, 301].map((v) => sev('ind_cpcb', v)),
      ['good', 'moderate', 'unhealthy', 'very_unhealthy'],
    );
  });
});

describe('daily plan rules by day type', () => {
  const plan = (aqi: number, sensitive: boolean, extra: Record<string, unknown> = {}) =>
    buildDailyPlan(
      {
        status: 'fresh',
        snapshot: normalizeCurrent(
          currentBody({ indexes: [{ code: 'usa_epa', aqi, category: 'Category' }] }),
          {
            latitude: 1,
            longitude: 1,
            fetchedAt: new Date(),
          },
        ),
      },
      {
        members: sensitive ? [{ ageGroup: 'older_adult', needsExtraCaution: false }] : [],
        constraints: {
          commuteMode: 'bus',
          canWorkFromHome: false,
          hasAirPurifier: false,
          hasPets: false,
          cookingFuel: 'induction',
          budgetLevel: 'unknown',
          timeFlexibility: 'fixed',
          ...extra,
        },
      },
    );

  it('moderate days ease off only for sensitive households', () => {
    assert.equal(plan(80, true).items[0]?.title, 'Take it easier outdoors today');
    assert.equal(plan(80, false).items[0]?.exposureEffect, 'similar');
  });
  it('good days suggest airing out and active travel', () => {
    assert.equal(plan(20, false).items[0]?.key, 'enjoy-outdoors');
  });
  it('a fixed schedule on a poor day raises the effort of shifting activity', () => {
    assert.equal(plan(180, false).items[0]?.effort, 'medium');
    assert.equal(plan(180, false, { timeFlexibility: 'high' }).items[0]?.effort, 'low');
  });
  it('electric cooking gets its own ventilation advice', () => {
    assert.match(plan(20, false).indoorQuickWins[0]!.body, /electric or induction/);
  });
});
