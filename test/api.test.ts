import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, json, validHousehold, type Harness } from './helpers/app.js';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.close();
});

describe('envelope and basics', () => {
  it('GET /health returns the envelope and integration flags but no secrets', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const b = json(res);
    assert.ok(b.requestId && b.schemaVersion);
    assert.equal(b.data.database, 'ok');
    assert.equal(b.data.integrations.googleAirQuality, true);
    assert.ok(!res.body.includes('test-google-key'));
    assert.ok(!res.body.includes('test-anthropic-key'));
  });

  it('unknown API routes return an enveloped 404', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/nope' });
    assert.equal(res.statusCode, 404);
    assert.equal(json(res).error.code, 'not_found');
  });

  it('request ids are server generated, not client supplied', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'attacker-controlled' },
    });
    assert.notEqual(json(res).requestId, 'attacker-controlled');
    assert.equal(res.headers['x-request-id'], json(res).requestId);
  });
});

describe('air quality route', () => {
  it('returns a fresh real-shaped snapshot with provenance, then cached', async () => {
    const a = h.agent();
    const r1 = json(await a.get('/api/v1/air-quality?lat=28.61&lng=77.21'));
    assert.equal(r1.data.status, 'fresh');
    assert.equal(r1.data.snapshot.source, 'google_air_quality');
    assert.ok(r1.data.snapshot.observedAt && r1.data.snapshot.fetchedAt);
    const calls = h.state.googleCalls;
    const r2 = json(await a.get('/api/v1/air-quality?lat=28.61&lng=77.21'));
    assert.equal(r2.data.status, 'cached');
    assert.equal(h.state.googleCalls, calls);
  });

  it('rejects invalid and unknown query input', async () => {
    const a = h.agent();
    for (const q of ['lat=999&lng=0', 'lat=abc&lng=0', 'lat=1', 'lat=1&lng=1&foo=bar']) {
      const res = await a.get(`/api/v1/air-quality?${q}`);
      assert.equal(res.statusCode, 400, q);
      assert.equal(json(res).error.code, 'validation_error');
    }
  });

  it('forecast validates windows', async () => {
    const res = await h
      .agent()
      .get('/api/v1/air-quality/forecast?lat=1&lng=1&start=2026-01-01T00:00:00Z&end=2030-01-01T00:00:00Z');
    assert.equal(res.statusCode, 400);
  });

  it('upstream failure for an unseen location is unavailable with no snapshot', async () => {
    h.state.google = 'down';
    const res = await h.agent().get('/api/v1/air-quality?lat=-33.87&lng=151.21');
    h.state.google = 'ok';
    const b = json(res);
    assert.equal(res.statusCode, 200);
    assert.equal(b.data.status, 'unavailable');
    assert.equal(b.data.snapshot, null);
    assert.ok(!res.body.includes('test-google-key'));
  });
});

describe('households and authorization', () => {
  it('requires CSRF for mutations', async () => {
    const a = h.agent();
    await a.get('/api/v1/session');
    const res = await a.post('/api/v1/households', validHousehold(), { csrf: false });
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).error.code, 'csrf_failed');
  });

  it('rejects cross-origin mutations', async () => {
    const res = await h
      .agent()
      .post('/api/v1/households', validHousehold(), { headers: { origin: 'https://evil.example' } });
    assert.equal(res.statusCode, 403);
  });

  it('creates a household with a secure session cookie, rounds coordinates, rejects unknown fields', async () => {
    const a = h.agent();
    const bad = await a.post('/api/v1/households', { ...validHousehold(), isAdmin: true });
    assert.equal(bad.statusCode, 400);
    const res = await a.post('/api/v1/households', validHousehold());
    assert.equal(res.statusCode, 201);
    const sid = res.cookies.find((c) => c.name === 'ca_sid');
    assert.ok(sid?.httpOnly);
    assert.equal(sid?.sameSite, 'Lax');
    const b = json(res);
    assert.equal(b.data.location.latitude, 28.61);
    assert.equal(b.data.members[0].ageGroup, 'child');
  });

  it("a user cannot read, update, plan against or give feedback on another user's household", async () => {
    const owner = h.agent();
    const mallory = h.agent();
    const created = json(await owner.post('/api/v1/households', validHousehold()));
    const id = created.data.id as string;

    assert.equal((await owner.get(`/api/v1/households/${id}`)).statusCode, 200);

    // Mallory has her own session.
    await mallory.post('/api/v1/households', validHousehold({ name: 'Mine' }));
    for (const res of [
      await mallory.get(`/api/v1/households/${id}`),
      await mallory.put(`/api/v1/households/${id}/constraints`, { commuteMode: 'walk' }),
      await mallory.post(`/api/v1/households/${id}/daily-plan`, {}),
      await mallory.post('/api/v1/scenarios/compare', { householdId: id, candidates: ['walk'] }),
      await mallory.post('/api/v1/assistant/messages', { message: 'hello', householdId: id }),
    ]) {
      assert.equal(res.statusCode, 404, res.body);
    }
    // Anonymous (no session) is unauthorized, not a data oracle.
    assert.equal((await h.agent().get(`/api/v1/households/${id}`)).statusCode, 401);

    // Recommendation feedback is object-level protected too.
    const plan = json(await owner.post(`/api/v1/households/${id}/daily-plan`, {}));
    const recId = plan.data.indoorQuickWins[0].id as string;
    assert.ok(recId);
    assert.equal(
      (await mallory.post(`/api/v1/recommendations/${recId}/feedback`, { eventType: 'helpful' })).statusCode,
      404,
    );
    assert.equal(
      (await owner.post(`/api/v1/recommendations/${recId}/feedback`, { eventType: 'helpful', note: 'ok' }))
        .statusCode,
      201,
    );
    assert.equal(
      (await owner.post(`/api/v1/recommendations/${recId}/feedback`, { eventType: 'bogus' })).statusCode,
      400,
    );
  });

  it('malformed ids are rejected before touching the database', async () => {
    const a = h.agent();
    await a.post('/api/v1/households', validHousehold());
    assert.equal((await a.get("/api/v1/households/1' or '1'='1")).statusCode, 400);
  });
});
