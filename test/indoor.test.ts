import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, json, validHousehold, type Agent, type Harness } from './helpers/app.js';
import { purgeExpired } from '../src/routes/indoor.js';

let h: Harness;
let a: Agent;
let hid: string;

before(async () => {
  h = await createHarness();
  a = h.agent();
  hid = json(await a.post('/api/v1/households', validHousehold())).data.id;
});
after(async () => {
  await h.close();
});

describe('sensor readings and measured indoor status', () => {
  const reading = (over: Record<string, unknown> = {}) => ({
    householdId: hid,
    deviceId: 'purple-1',
    pollutant: 'pm25',
    unit: 'ug/m3',
    value: 22.5,
    measuredAt: new Date().toISOString(),
    ...over,
  });

  it('reports no measured status without a recent sensor reading', async () => {
    const s = json(await a.get(`/api/v1/indoor/status?householdId=${hid}`)).data;
    assert.equal(s.status, 'no_recent_sensor_data');
    assert.equal(s.measuredAqi, null);
    assert.deepEqual(s.readings, []);
    assert.match(s.message, /not measured/i);
  });

  it('accepts a valid reading and reports it as measured concentration with a WHO reference, not an AQI', async () => {
    assert.equal((await a.post('/api/v1/indoor/sensor-reading', reading())).statusCode, 201);
    const s = json(await a.get(`/api/v1/indoor/status?householdId=${hid}`)).data;
    assert.equal(s.status, 'measured');
    assert.equal(s.measuredAqi, null);
    assert.equal(s.readings[0].value, 22.5);
    assert.equal(s.readings[0].reference.relation, 'above');
    assert.match(s.readings[0].reference.guideline, /WHO 2021/);
  });

  it('rejects invalid pollutants, units, ranges, timestamps and unknown fields', async () => {
    for (const bad of [
      reading({ pollutant: 'aqi' }),
      reading({ unit: 'ppm' }),
      reading({ value: -1 }),
      reading({ value: 99999 }),
      reading({ value: 'high' }),
      reading({ measuredAt: new Date(Date.now() + 3_600_000).toISOString() }),
      reading({ measuredAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
      reading({ deviceId: 'bad id;drop' }),
      { ...reading(), measuredAqi: 50 },
    ])
      assert.equal((await a.post('/api/v1/indoor/sensor-reading', bad)).statusCode, 400, JSON.stringify(bad));
  });

  it('enforces household ownership for readings and status', async () => {
    const m = h.agent();
    await m.post('/api/v1/households', validHousehold());
    assert.equal((await m.post('/api/v1/indoor/sensor-reading', reading())).statusCode, 404);
    assert.equal((await m.get(`/api/v1/indoor/status?householdId=${hid}`)).statusCode, 404);
    assert.equal((await h.agent().get(`/api/v1/indoor/status?householdId=${hid}`)).statusCode, 401);
  });

  it('old readings do not count as current status', async () => {
    await h.tdb.sql`update indoor_sensor_readings set measured_at = now() - interval '2 hours'`;
    assert.equal(
      json(await a.get(`/api/v1/indoor/status?householdId=${hid}`)).data.status,
      'no_recent_sensor_data',
    );
  });

  it('purges readings older than 30 days', async () => {
    await h.tdb.sql`update indoor_sensor_readings set received_at = now() - interval '31 days'`;
    const r = await purgeExpired({
      config: undefined as never,
      dbh: h.tdb,
      aq: undefined as never,
      assistant: undefined as never,
      now: () => new Date(),
    });
    assert.ok(r.readings >= 1);
    const [{ n } = { n: 1 }] = await h.tdb.sql`select count(*)::int n from indoor_sensor_readings`;
    assert.equal(n, 0);
  });
});
