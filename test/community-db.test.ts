import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, json, validHousehold, type Harness } from './helpers/app.js';
import { TABLES } from '../src/db/schema.js';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.close();
});

const challenge = {
  title: 'Clean air week',
  description: 'Try one quick win a day.',
  startsAt: '2026-11-26T00:00:00Z',
  endsAt: '2026-12-03T00:00:00Z',
};

describe('community aggregates are k-anonymous', () => {
  it('suppresses counts below k=5 and never exposes individuals', async () => {
    const creator = h.agent();
    const created = json(await creator.post('/api/v1/community/challenges', challenge));
    const id = created.data.id as string;
    assert.equal(created.data.suppressed, true);
    assert.equal(created.data.participantCount, null);
    assert.match(created.data.participantCountLabel, /Fewer than 5/);

    await creator.post(`/api/v1/community/challenges/${id}/actions`, { actionKey: 'run_purifier' });
    for (let i = 0; i < 3; i++) await h.agent().post(`/api/v1/community/challenges/${id}/join`, {});
    const s4 = json(await h.agent().get(`/api/v1/community/challenges/${id}/summary`));
    assert.equal(s4.data.suppressed, true);
    assert.equal(s4.data.actionCounts, null);

    const fifth = h.agent();
    await fifth.post(`/api/v1/community/challenges/${id}/join`, {});
    await fifth.post(`/api/v1/community/challenges/${id}/actions`, { actionKey: 'run_purifier' });
    const s5 = json(await h.agent().get(`/api/v1/community/challenges/${id}/summary`));
    assert.equal(s5.data.suppressed, false);
    assert.equal(s5.data.participantCount, 5);
    assert.deepEqual(s5.data.actionCounts, {}, 'only 2 completed run_purifier, below k, so suppressed');
    const body = JSON.stringify(s5);
    assert.ok(!/userId|user_id|ownerUserId|latitude|household/i.test(body));
  });

  it('rejects free-text action keys, bad dates and non-participants', async () => {
    const a = h.agent();
    const c = json(await a.post('/api/v1/community/challenges', challenge)).data.id as string;
    assert.equal(
      (await a.post(`/api/v1/community/challenges/${c}/actions`, { actionKey: 'my medical condition' }))
        .statusCode,
      400,
    );
    assert.equal(
      (await a.post('/api/v1/community/challenges', { ...challenge, endsAt: '2026-11-01T00:00:00Z' }))
        .statusCode,
      400,
    );
    assert.equal(
      (await h.agent().post(`/api/v1/community/challenges/${c}/actions`, { actionKey: 'run_purifier' }))
        .statusCode,
      401,
    );
    const stranger = h.agent();
    await stranger.post('/api/v1/households', validHousehold());
    assert.equal(
      (await stranger.post(`/api/v1/community/challenges/${c}/actions`, { actionKey: 'run_purifier' }))
        .statusCode,
      404,
    );
    assert.equal(
      (await h.agent().get('/api/v1/community/challenges/00000000-0000-4000-8000-000000000000/summary'))
        .statusCode,
      404,
    );
  });
});

describe('migrations and repositories on real Postgres', () => {
  it('creates every required table with RLS enabled', async () => {
    const rows = await h.tdb.sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and c.relname = any(${TABLES.map((t) => t)})`;
    for (const t of [
      'users',
      'households',
      'household_members',
      'household_constraints',
      'air_quality_snapshots',
      'recommendations',
      'recommendation_events',
      'community_challenges',
      'community_participation',
      'audit_events',
    ]) {
      const r = rows.find((x) => x.relname === t);
      assert.ok(r, `missing table ${t}`);
      assert.equal(r.relrowsecurity, true, `${t} must have RLS`);
    }
  });

  it('enforces check constraints and foreign keys in the database itself', async () => {
    const u = await h.tdb.sql`insert into users default values returning id`;
    const uid = u[0]!.id as string;
    await assert.rejects(
      h.tdb.sql`insert into households (owner_user_id,name,latitude,longitude) values (${uid},'x',200,0)`,
    );
    await assert.rejects(
      h.tdb
        .sql`insert into households (owner_user_id,name,latitude,longitude) values (gen_random_uuid(),'x',1,1)`,
    );
    await assert.rejects(
      h.tdb
        .sql`insert into air_quality_snapshots (location_key,latitude,longitude,source,observed_at,fetched_at,payload) values ('k',1,1,'made_up',now(),now(),'{}')`,
    );
    await assert.rejects(
      h.tdb
        .sql`insert into household_constraints (household_id,commute_mode) values (gen_random_uuid(),'teleport')`,
    );
  });

  it('cascades deletes from user to owned data', async () => {
    const a = h.agent();
    const hh = json(await a.post('/api/v1/households', validHousehold())).data.id as string;
    await a.post(`/api/v1/households/${hh}/daily-plan`, {});
    const [{ n: before } = { n: 0 }] = await h.tdb
      .sql`select count(*)::int n from recommendations where household_id=${hh}`;
    assert.ok(before > 0);
    await h.tdb.sql`delete from households where id=${hh}`;
    const [{ n: after } = { n: 1 }] = await h.tdb
      .sql`select count(*)::int n from recommendations where household_id=${hh}`;
    assert.equal(after, 0);
  });

  it('daily plan is idempotent per day and feedback is upserted', async () => {
    const a = h.agent();
    const hh = json(await a.post('/api/v1/households', validHousehold())).data.id as string;
    const p1 = json(await a.post(`/api/v1/households/${hh}/daily-plan`, {}));
    const p2 = json(await a.post(`/api/v1/households/${hh}/daily-plan`, {}));
    assert.deepEqual(
      p1.data.indoorQuickWins.map((i: { id: string }) => i.id),
      p2.data.indoorQuickWins.map((i: { id: string }) => i.id),
    );
    const rid = p1.data.indoorQuickWins[0].id as string;
    await a.post(`/api/v1/recommendations/${rid}/feedback`, { eventType: 'done' });
    await a.post(`/api/v1/recommendations/${rid}/feedback`, { eventType: 'done', note: 'again' });
    const [{ n } = { n: 0 }] = await h.tdb
      .sql`select count(*)::int n from recommendation_events where recommendation_id=${rid}`;
    assert.equal(n, 1);
  });

  it('writes audit events without message content or raw IPs', async () => {
    const a = h.agent();
    await a.post('/api/v1/households', validHousehold());
    const rows = await h.tdb
      .sql`select event_type, client_hash, metadata from audit_events where event_type='household.create' limit 1`;
    assert.equal(rows.length, 1);
    assert.match(String(rows[0]!.client_hash), /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(rows[0]).includes('127.0.0.1'));
  });
});
