import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAirQualityClient, UpstreamError, type FetchLike } from '../src/google/client.js';
import {
  buildCurrentRequest,
  buildForecastRequest,
  currentQuerySchema,
  forecastQuerySchema,
  roundCoordinate,
} from '../src/google/request.js';
import { currentBody, forecastHour, jsonResponse } from './helpers/google-fixtures.js';

const FIXED = new Date('2026-11-26T08:05:00Z');
const mk = (fetchImpl: FetchLike, over: Record<string, unknown> = {}) =>
  new GoogleAirQualityClient({
    apiKey: 'SECRET-KEY-123',
    baseUrl: 'https://airquality.googleapis.com',
    timeoutMs: 200,
    maxRetries: 2,
    maxResponseBytes: 50_000,
    maxPages: 4,
    fetchImpl,
    sleep: async () => undefined,
    now: () => FIXED,
    ...over,
  });
const Q = { lat: 28.6139, lng: 77.209, languageCode: 'en' };

describe('request construction', () => {
  it('builds an allowlisted body with rounded coordinates', () => {
    const b = buildCurrentRequest(Q);
    assert.deepEqual(Object.keys(b).sort(), [
      'extraComputations',
      'languageCode',
      'location',
      'universalAqi',
    ]);
    assert.equal(b.location.latitude, 28.61);
    assert.equal(b.location.longitude, 77.21);
    assert.ok(b.extraComputations.includes('HEALTH_RECOMMENDATIONS'));
  });
  it('rejects bad coordinates and unknown fields', () => {
    assert.equal(currentQuerySchema.safeParse({ lat: '91', lng: '0' }).success, false);
    assert.equal(currentQuerySchema.safeParse({ lat: '0', lng: '181' }).success, false);
    assert.equal(currentQuerySchema.safeParse({ lat: 'abc', lng: '0' }).success, false);
    assert.equal(currentQuerySchema.safeParse({ lat: '1', lng: '1', extra: 'x' }).success, false);
    assert.equal(
      currentQuerySchema.safeParse({ lat: '1', lng: '1', languageCode: 'en; drop' }).success,
      false,
    );
    assert.equal(roundCoordinate(-0.001), 0);
  });
  it('validates forecast windows', () => {
    const s = forecastQuerySchema(96, () => FIXED);
    const base = { lat: '1', lng: '1' };
    assert.equal(
      s.safeParse({ ...base, start: '2026-11-26T09:00:00Z', end: '2026-11-26T12:00:00Z' }).success,
      true,
    );
    assert.equal(s.safeParse({ ...base, start: '2026-11-26T09:00:00Z' }).success, false);
    assert.equal(
      s.safeParse({ ...base, start: '2026-11-26T12:00:00Z', end: '2026-11-26T09:00:00Z' }).success,
      false,
    );
    assert.equal(
      s.safeParse({ ...base, start: '2026-11-26T09:00:00Z', end: '2026-12-10T09:00:00Z' }).success,
      false,
    );
    assert.equal(s.safeParse({ ...base, start: 'tomorrow', end: 'later' }).success, false);
  });
  it('rejects malformed page tokens', () => {
    assert.throws(() =>
      buildForecastRequest(Q, '2026-11-26T09:00:00Z', '2026-11-26T10:00:00Z', 'bad token;'),
    );
  });
});

describe('google client', () => {
  it('posts to the allowlisted endpoint with key as query param and normalizes the response', async () => {
    let seen: { url: string; body: string } | undefined;
    const c = mk(async (url, init) => {
      seen = { url, body: String(init.body) };
      return jsonResponse(currentBody());
    });
    const s = await c.fetchCurrent(Q);
    assert.ok(seen!.url.startsWith('https://airquality.googleapis.com/v1/currentConditions:lookup?key='));
    assert.equal(s.source, 'google_air_quality');
    assert.equal(s.observedAt, '2026-11-26T08:00:00.000Z');
    assert.equal(s.fetchedAt, FIXED.toISOString());
    assert.equal(s.regionCode, 'IN');
    assert.equal(s.indexes[0]?.aqi, 42);
    assert.equal(s.pollutants[0]?.units, 'µg/m³');
    assert.equal(s.healthRecommendations?.elderly, 'Stay indoors if possible.');
    assert.equal(s.freshness, 'fresh');
  });

  it('normalizes offset timestamps to UTC', async () => {
    const c = mk(async () => jsonResponse(currentBody({ dateTime: '2026-11-26T13:30:00+05:30' })));
    assert.equal((await c.fetchCurrent(Q)).observedAt, '2026-11-26T08:00:00.000Z');
  });

  for (const [status, kind] of [
    [401, 'auth'],
    [403, 'auth'],
  ] as const) {
    it(`maps ${status} to ${kind} without retrying`, async () => {
      let calls = 0;
      const c = mk(async () => (calls++, jsonResponse({ error: 'x' }, status)));
      await assert.rejects(c.fetchCurrent(Q), (e: UpstreamError) => e.kind === kind);
      assert.equal(calls, 1);
    });
  }

  it('retries 429 and 5xx a bounded number of times', async () => {
    let calls = 0;
    const c = mk(async () => (calls++, jsonResponse({}, 503)));
    await assert.rejects(c.fetchCurrent(Q), (e: UpstreamError) => e.kind === 'server');
    assert.equal(calls, 3);
    calls = 0;
    const c2 = mk(async () => (calls++, jsonResponse({}, 429)));
    await assert.rejects(c2.fetchCurrent(Q), (e: UpstreamError) => e.kind === 'rate_limited');
    assert.equal(calls, 3);
  });

  it('recovers when a retry succeeds', async () => {
    let calls = 0;
    const c = mk(async () => (++calls < 2 ? jsonResponse({}, 502) : jsonResponse(currentBody())));
    assert.equal((await c.fetchCurrent(Q)).indexes.length, 2);
  });

  it('times out', async () => {
    const c = mk(
      (_u, init) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
      { maxRetries: 0, timeoutMs: 30 },
    );
    await assert.rejects(c.fetchCurrent(Q), (e: UpstreamError) => e.kind === 'timeout');
  });

  it('rejects malformed JSON, wrong shapes and empty payloads', async () => {
    await assert.rejects(
      mk(async () => new Response('<html>', { status: 200 })).fetchCurrent(Q),
      (e: UpstreamError) => e.kind === 'malformed',
    );
    await assert.rejects(
      mk(async () => jsonResponse({ dateTime: 5 })).fetchCurrent(Q),
      (e: UpstreamError) => e.kind === 'malformed',
    );
    await assert.rejects(
      mk(async () =>
        jsonResponse({ dateTime: '2026-11-26T08:00:00Z', indexes: [{ code: 'uaqi' }] }),
      ).fetchCurrent(Q),
      (e: UpstreamError) => e.kind === 'malformed',
    );
  });

  it('enforces the response size limit', async () => {
    const big = currentBody({ healthRecommendations: { generalPopulation: 'x'.repeat(100_000) } });
    await assert.rejects(
      mk(async () => jsonResponse(big)).fetchCurrent(Q),
      (e: UpstreamError) => e.kind === 'too_large',
    );
    await assert.rejects(
      mk(async () => jsonResponse(currentBody(), 200, { 'content-length': '999999' })).fetchCurrent(Q),
      (e: UpstreamError) => e.kind === 'too_large',
    );
  });

  it('follows forecast pagination, dedupes and sorts', async () => {
    const pages = [
      {
        hourlyForecasts: [forecastHour('2026-11-26T10:00:00Z'), forecastHour('2026-11-26T09:00:00Z')],
        nextPageToken: 'tok1',
        regionCode: 'in',
      },
      {
        hourlyForecasts: [forecastHour('2026-11-26T10:00:00Z', 99), forecastHour('2026-11-26T11:00:00Z')],
        nextPageToken: 'tok2',
      },
      { hourlyForecasts: [forecastHour('2026-11-26T12:00:00Z')] },
    ];
    const tokens: Array<string | undefined> = [];
    let i = 0;
    const c = mk(async (_u, init) => {
      tokens.push(JSON.parse(String(init.body)).pageToken);
      return jsonResponse(pages[i++]);
    });
    const f = await c.fetchForecast(Q, '2026-11-26T09:00:00Z', '2026-11-26T13:00:00Z');
    assert.deepEqual(tokens, [undefined, 'tok1', 'tok2']);
    assert.deepEqual(
      f.hours.map((h) => h.forecastAt),
      [
        '2026-11-26T09:00:00.000Z',
        '2026-11-26T10:00:00.000Z',
        '2026-11-26T11:00:00.000Z',
        '2026-11-26T12:00:00.000Z',
      ],
    );
    assert.equal(f.hours[1]?.indexes[0]?.aqi, 50, 'first occurrence wins on duplicates');
    assert.equal(f.regionCode, 'IN');
  });

  it('refuses looping or invalid pagination tokens', async () => {
    const loop = mk(async () =>
      jsonResponse({ hourlyForecasts: [forecastHour('2026-11-26T09:00:00Z')], nextPageToken: 'same' }),
    );
    await assert.rejects(
      loop.fetchForecast(Q, '2026-11-26T09:00:00Z', '2026-11-26T13:00:00Z'),
      (e: UpstreamError) => e.kind === 'malformed',
    );
    const bad = mk(async () => jsonResponse({ hourlyForecasts: [], nextPageToken: 'a b;c' }));
    await assert.rejects(
      bad.fetchForecast(Q, '2026-11-26T09:00:00Z', '2026-11-26T13:00:00Z'),
      (e: UpstreamError) => e.kind === 'malformed',
    );
  });

  it('never leaks the API key in error messages', async () => {
    const c = mk(async () => jsonResponse({}, 403));
    try {
      await c.fetchCurrent(Q);
      assert.fail('should throw');
    } catch (e) {
      assert.ok(!String((e as Error).message).includes('SECRET-KEY-123'));
    }
  });
});
