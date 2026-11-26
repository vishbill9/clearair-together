import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAirQualityClient, type FetchLike } from '../src/google/client.js';
import { AirQualityService } from '../src/google/service.js';
import { createTestDb, type TestDb } from './helpers/db.js';
import { currentBody, jsonResponse } from './helpers/google-fixtures.js';

let tdb: TestDb;
let clock = new Date('2026-11-26T08:00:00Z');
const Q = { lat: 28.6, lng: 77.2, languageCode: 'en' };
let mode: 'ok' | 'down' = 'ok';
let calls = 0;
const fetchImpl: FetchLike = async () => {
  calls++;
  return mode === 'ok' ? jsonResponse(currentBody()) : jsonResponse({}, 503);
};
const client = () =>
  new GoogleAirQualityClient({
    apiKey: 'k',
    baseUrl: 'https://airquality.googleapis.com',
    timeoutMs: 100,
    maxRetries: 0,
    maxResponseBytes: 50_000,
    maxPages: 2,
    fetchImpl,
    sleep: async () => undefined,
    now: () => clock,
  });
const svc = () =>
  new AirQualityService({
    client: client(),
    db: tdb.db,
    cacheTtlSeconds: 900,
    staleMaxSeconds: 3600,
    now: () => clock,
  });

describe('air quality service freshness', () => {
  before(async () => {
    tdb = await createTestDb();
  });
  after(async () => {
    await tdb.drop();
  });

  it('not_configured: no key means no data and a clear reason', async () => {
    const s = new AirQualityService({
      client: null,
      db: tdb.db,
      cacheTtlSeconds: 900,
      staleMaxSeconds: 3600,
      now: () => clock,
    });
    const r = await s.getCurrent(Q);
    assert.equal(r.status, 'not_configured');
    assert.equal(r.snapshot, null);
    assert.match(r.reason!, /not configured/i);
  });

  it('fresh then cached within TTL', async () => {
    const a = await svc().getCurrent(Q);
    assert.equal(a.status, 'fresh');
    clock = new Date(clock.getTime() + 300_000);
    const before = calls;
    const b = await svc().getCurrent(Q);
    assert.equal(b.status, 'cached');
    assert.equal(calls, before, 'no upstream call while cached');
    assert.equal(b.snapshot?.source, 'google_air_quality');
  });

  it('stale when upstream down but real snapshot is within the stale window', async () => {
    clock = new Date(clock.getTime() + 1_000_000); // beyond TTL, within stale max
    mode = 'down';
    const r = await svc().getCurrent(Q);
    assert.equal(r.status, 'stale');
    assert.equal(r.snapshot?.freshness, 'stale');
    assert.match(r.reason!, /last real reading/);
    assert.equal(r.upstreamError, 'server');
  });

  it('unavailable (and no numbers) once the snapshot is older than the stale window', async () => {
    clock = new Date(clock.getTime() + 10_000_000);
    const r = await svc().getCurrent(Q);
    assert.equal(r.status, 'unavailable');
    assert.equal(r.snapshot, null);
  });

  it('unavailable for a never-seen location when upstream is down', async () => {
    const r = await svc().getCurrent({ lat: -33.86, lng: 151.2, languageCode: 'en' });
    assert.equal(r.status, 'unavailable');
    assert.equal(r.snapshot, null);
  });

  it('recovers to fresh when upstream returns', async () => {
    mode = 'ok';
    assert.equal((await svc().getCurrent(Q)).status, 'fresh');
  });
});
