import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, json, validHousehold, type Harness } from './helpers/app.js';
import { hashPassword, verifyPassword } from '../src/security/password.js';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.close();
});

const creds = (email = 'asha@example.com') => ({ email, password: 'correct horse battery', displayName: 'Asha' });

describe('password hashing', () => {
  it('verifies the right password only and never accepts a missing hash', async () => {
    const hash = await hashPassword('s3cret-passphrase');
    assert.ok(hash.startsWith('scrypt$'));
    assert.ok(!hash.includes('s3cret'));
    assert.equal(await verifyPassword('s3cret-passphrase', hash), true);
    assert.equal(await verifyPassword('wrong', hash), false);
    assert.equal(await verifyPassword('anything', null), false);
    assert.equal(await verifyPassword('x', 'garbage'), false);
  });
});

describe('accounts', () => {
  it('registers, keeps data saved before sign-up, and signs out and in again', async () => {
    const a = h.agent();
    const hh = await a.post('/api/v1/households', validHousehold());
    assert.equal(hh.statusCode, 201, hh.body);
    const hid = json(hh).data.id ?? json(hh).data.household?.id;

    const reg = await a.post('/api/v1/auth/register', creds());
    assert.equal(reg.statusCode, 200, reg.body);
    assert.ok(!reg.body.includes('correct horse'));
    assert.ok(!reg.body.includes('scrypt'));
    assert.equal(json(await a.get('/api/v1/auth/me')).data.email, 'asha@example.com');
    // same user: the earlier household is still readable
    assert.equal((await a.get(`/api/v1/households/${hid}`)).statusCode, 200);

    const out = await a.post('/api/v1/auth/logout');
    assert.equal(out.statusCode, 200);
    assert.equal(json(await a.get('/api/v1/auth/me')).data.kind, 'none');

    const bad = await a.post('/api/v1/auth/login', { email: 'asha@example.com', password: 'nope-nope-nope' });
    assert.equal(bad.statusCode, 401);
    const good = await a.post('/api/v1/auth/login', { email: 'ASHA@example.com', password: 'correct horse battery' });
    assert.equal(good.statusCode, 200, good.body);
    assert.equal((await a.get(`/api/v1/households/${hid}`)).statusCode, 200);
  });

  it('does not reveal whether an email exists on failed login', async () => {
    const a = h.agent();
    const r1 = await a.post('/api/v1/auth/login', { email: 'asha@example.com', password: 'wrong-password-1' });
    const r2 = await a.post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'wrong-password-1' });
    assert.equal(r1.statusCode, 401);
    assert.equal(r2.statusCode, 401);
    assert.equal(json(r1).error.message, json(r2).error.message);
  });

  it('rejects duplicate emails, weak passwords, extra fields and missing CSRF', async () => {
    const a = h.agent();
    const dup = await a.post('/api/v1/auth/register', creds());
    assert.equal(dup.statusCode, 409);
    const b = h.agent();
    assert.equal((await b.post('/api/v1/auth/register', { ...creds('b@example.com'), password: 'short' })).statusCode, 400);
    assert.equal((await b.post('/api/v1/auth/register', { ...creds('b@example.com'), kind: 'admin' })).statusCode, 400);
    assert.equal((await b.post('/api/v1/auth/register', { ...creds('not-an-email') })).statusCode, 400);
    assert.equal((await b.post('/api/v1/auth/register', creds('c@example.com'), { csrf: false })).statusCode, 403);
  });

  it("another account cannot read someone's household after sign-in", async () => {
    const a = h.agent();
    await a.post('/api/v1/auth/register', creds('owner@example.com'));
    const hh = await a.post('/api/v1/households', validHousehold());
    const hid = json(hh).data.id ?? json(hh).data.household?.id;
    const b = h.agent();
    await b.post('/api/v1/auth/register', creds('other@example.com'));
    assert.equal((await b.get(`/api/v1/households/${hid}`)).statusCode, 404);
  });

  it('throttles repeated login attempts', async () => {
    const a = h.agent();
    let last = 0;
    for (let i = 0; i < 14; i++) {
      last = (await a.post('/api/v1/auth/login', { email: 'x@example.com', password: 'wrong-password-1' })).statusCode;
    }
    assert.equal(last, 429);
  });
});
