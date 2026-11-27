import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, json, validHousehold, type Harness } from './helpers/app.js';
import { loadConfig } from '../src/config.js';
import { readIdToken } from '../src/routes/google-login.js';
import { challengeFor, openTransaction, sealTransaction } from '../src/security/oauth-state.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const env = { GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret-value' };

type Claims = Record<string, unknown>;
const idToken = (c: Claims) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;

let nextClaims: (nonce: string) => Claims = () => ({});
let tokenCalls: { body: URLSearchParams }[] = [];
let tokenStatus = 200;

let h: Harness;
before(async () => {
  h = await createHarness({
    env,
    oauthFetch: async (url, init) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      const body = new URLSearchParams(String(init.body));
      tokenCalls.push({ body });
      if (tokenStatus !== 200) return new Response('{}', { status: tokenStatus });
      return new Response(JSON.stringify({ id_token: idToken(nextClaims(String(lastNonce))) }));
    },
  });
});
after(async () => {
  await h.close();
});

let lastNonce = '';
const good =
  (over: Claims = {}) =>
  (nonce: string): Claims => ({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: 'google-sub-1',
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce,
    email: 'Priya@Example.com',
    email_verified: true,
    given_name: 'Priya',
    ...over,
  });

async function begin(a: ReturnType<Harness['agent']>) {
  const res = await a.get('/api/v1/auth/google/start');
  assert.equal(res.statusCode, 302);
  const loc = new URL(String(res.headers.location));
  lastNonce = loc.searchParams.get('nonce') ?? '';
  return { res, loc, state: loc.searchParams.get('state') ?? '' };
}

describe('Google sign-in', () => {
  it('redirects to Google with PKCE, state and nonce and sets a signed, http-only cookie', async () => {
    const { res, loc } = await begin(h.agent());
    assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(loc.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(loc.searchParams.get('response_type'), 'code');
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.match(loc.searchParams.get('redirect_uri') ?? '', /\/api\/v1\/auth\/google\/callback$/);
    assert.ok(loc.searchParams.get('scope')?.includes('openid'));
    const c = res.cookies.find((x) => x.name === 'ca_oauth');
    assert.ok(c?.httpOnly);
    assert.ok(!res.body.includes('test-secret-value'));
    assert.ok(!String(res.headers.location).includes('test-secret-value'));
  });

  it('signs in, creates the account and keeps data saved before sign-in', async () => {
    tokenCalls = [];
    tokenStatus = 200;
    nextClaims = good();
    const a = h.agent();
    const hh = await a.post('/api/v1/households', validHousehold());
    const hid = json(hh).data.id ?? json(hh).data.household?.id;
    const { state } = await begin(a);
    const cb = await a.get(`/api/v1/auth/google/callback?code=abc&state=${state}`);
    assert.equal(cb.statusCode, 302);
    assert.equal(cb.headers.location, '/#/today');
    // The one-time code is exchanged with the PKCE verifier and the secret, server-side only.
    assert.equal(tokenCalls.length, 1);
    const sent = tokenCalls[0]!.body;
    assert.equal(sent.get('grant_type'), 'authorization_code');
    assert.equal(sent.get('code'), 'abc');
    assert.equal(sent.get('client_secret'), 'test-secret-value');
    assert.ok(sent.get('code_verifier'));
    const me = json(await a.get('/api/v1/auth/me')).data;
    assert.equal(me.kind, 'registered');
    assert.equal(me.email, 'priya@example.com');
    assert.equal(me.displayName, 'Priya');
    assert.equal((await a.get(`/api/v1/households/${hid}`)).statusCode, 200);
  });

  it('signs the same Google account back in on a fresh browser', async () => {
    nextClaims = good();
    const b = h.agent();
    const { state } = await begin(b);
    const cb = await b.get(`/api/v1/auth/google/callback?code=abc&state=${state}`);
    assert.equal(cb.headers.location, '/#/today');
    assert.equal(json(await b.get('/api/v1/auth/me')).data.email, 'priya@example.com');
  });

  it('links to an existing email account instead of creating a duplicate', async () => {
    const pw = h.agent();
    await pw.post('/api/v1/auth/register', { email: 'sam@example.com', password: 'correct horse battery' });
    const id1 = json(await pw.get('/api/v1/auth/me')).data;
    nextClaims = good({ sub: 'google-sub-2', email: 'sam@example.com', given_name: 'Sam' });
    const g = h.agent();
    const { state } = await begin(g);
    await g.get(`/api/v1/auth/google/callback?code=abc&state=${state}`);
    assert.equal(json(await g.get('/api/v1/auth/me')).data.email, id1.email);
  });

  it('rejects a wrong or missing state without calling Google', async () => {
    tokenCalls = [];
    const a = h.agent();
    await begin(a);
    for (const url of [
      '/api/v1/auth/google/callback?code=abc&state=wrong',
      '/api/v1/auth/google/callback?code=abc',
      '/api/v1/auth/google/callback?state=x',
    ]) {
      const r = await a.get(url);
      assert.equal(r.statusCode, 302);
      assert.match(String(r.headers.location), /auth_error=google/);
    }
    const noCookie = await h.agent().get('/api/v1/auth/google/callback?code=abc&state=anything');
    assert.match(String(noCookie.headers.location), /auth_error=google/);
    assert.equal(tokenCalls.length, 0);
    assert.equal(json(await a.get('/api/v1/auth/me')).data.kind, 'none');
  });

  it('rejects bad claims: audience, issuer, nonce, expiry, unverified email', async () => {
    const cases: Claims[] = [
      { aud: 'someone-else' },
      { iss: 'https://evil.example' },
      { nonce: 'not-it' },
      { exp: Math.floor(Date.now() / 1000) - 10 },
      { email_verified: false },
    ];
    for (const over of cases) {
      nextClaims = good({ sub: `bad-${Math.random()}`, ...over });
      const a = h.agent();
      const { state } = await begin(a);
      const r = await a.get(`/api/v1/auth/google/callback?code=abc&state=${state}`);
      assert.match(String(r.headers.location), /auth_error=google/, JSON.stringify(over));
      assert.equal(json(await a.get('/api/v1/auth/me')).data.kind, 'none', JSON.stringify(over));
    }
  });

  it('handles a denied consent screen, a failing token endpoint and an unusable state cookie', async () => {
    const a = h.agent();
    await begin(a);
    const denied = await a.get('/api/v1/auth/google/callback?error=access_denied');
    assert.match(String(denied.headers.location), /auth_error=google_denied/);
    tokenStatus = 400;
    const b = h.agent();
    const { state } = await begin(b);
    const r = await b.get(`/api/v1/auth/google/callback?code=abc&state=${state}`);
    assert.match(String(r.headers.location), /auth_error=google/);
    tokenStatus = 200;
    // The state cookie is single-use: replaying the same callback fails.
    nextClaims = good({ sub: 'replay-sub', email: 'replay@example.com' });
    const c = h.agent();
    const s2 = await begin(c);
    await c.get(`/api/v1/auth/google/callback?code=abc&state=${s2.state}`);
    const again = await c.get(`/api/v1/auth/google/callback?code=abc&state=${s2.state}`);
    assert.match(String(again.headers.location), /auth_error=google/);
  });
});

describe('Google sign-in configuration and helpers', () => {
  it('is off, and says so, when not configured', async () => {
    const off = await createHarness();
    try {
      const r = await off.agent().get('/api/v1/auth/google/start');
      assert.equal(r.statusCode, 503);
      assert.equal(json(await off.agent().get('/api/v1/config')).data.integrations.googleLogin, false);
    } finally {
      await off.close();
    }
  });
  it('requires the client id and secret together', () => {
    const base = { NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) };
    assert.throws(() => loadConfig({ ...base, GOOGLE_OAUTH_CLIENT_ID: 'id' }), /both GOOGLE_OAUTH/);
    assert.equal(loadConfig({ ...base, ...env }).integrations.googleLogin, true);
  });
  it('seals and opens the state cookie and rejects tampering or expiry', () => {
    const t = { state: 's', nonce: 'n', verifier: 'v' };
    const secret = 'k'.repeat(40);
    const sealed = sealTransaction(secret, t, 1_000_000);
    assert.deepEqual(openTransaction(secret, sealed, 1_000_000), t);
    assert.equal(openTransaction('other'.repeat(10), sealed, 1_000_000), null);
    assert.equal(openTransaction(secret, `${sealed}x`, 1_000_000), null);
    assert.equal(openTransaction(secret, sealed, 1_000_000 + 11 * 60 * 1000), null);
    assert.equal(openTransaction(secret, undefined), null);
  });
  it('computes the RFC 7636 S256 challenge', () => {
    assert.equal(
      challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  it('readIdToken accepts "true" as a string and rejects malformed tokens', () => {
    const c = good({ email_verified: 'true' })('n');
    assert.equal(
      readIdToken(idToken(c), { clientId: CLIENT_ID, nonce: 'n', now: Date.now() }).sub,
      'google-sub-1',
    );
    assert.throws(() => readIdToken('nope', { clientId: CLIENT_ID, nonce: 'n', now: Date.now() }));
  });
});
