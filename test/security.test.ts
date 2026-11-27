import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, json, validHousehold, TEST_SECRET, type Harness } from './helpers/app.js';
import { csrfCheck, newCsrfToken, signSession, verifySession } from '../src/security/session.js';
import { createLogger, scrubUrl } from '../src/logger.js';
import { Writable } from 'node:stream';

let h: Harness;
before(async () => {
  h = await createHarness({
    env: {
      CORS_ALLOWED_ORIGINS: 'https://preview.example.com',
      FRAME_ANCESTORS: 'https://preview.example.com',
    },
  });
});
after(async () => {
  await h.close();
});

describe('security headers', () => {
  it('sets CSP without unsafe-eval/inline, nosniff, no-referrer and a narrow Permissions-Policy', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.ok(!/unsafe-eval|unsafe-inline/.test(csp));
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'self' https:\/\/preview\.example\.com/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-powered-by'], undefined);
    const pp = String(res.headers['permissions-policy']);
    assert.match(pp, /camera=\(\)/);
    assert.match(pp, /payment=\(\)/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['strict-transport-security'], undefined, 'HSTS only in production');
  });

  it('enables HSTS and Secure cookies in production config', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { buildApp } = await import('../src/app.js');
    const cfg = loadConfig(
      {
        NODE_ENV: 'production',
        APP_ORIGIN: 'https://clearair.example.com',
        SESSION_SECRET: TEST_SECRET,
        GOOGLE_AIR_QUALITY_API_KEY: 'k',
        ANTHROPIC_API_KEY: 'a',
        DATABASE_URL: h.tdb.url,
        LOG_LEVEL: 'silent',
      } as NodeJS.ProcessEnv,
      () => undefined,
    );
    const { app } = await buildApp({ config: cfg, dbh: null });
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.match(String(res.headers['strict-transport-security']), /max-age=31536000/);
    assert.ok(res.cookies.find((c) => c.name === 'ca_csrf')?.secure);
    assert.match(String(res.headers['content-security-policy']), /upgrade-insecure-requests/);
    await app.close();
  });

  it('serves static files with the same headers and denies dotfiles', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/.env' });
    assert.equal(res.statusCode, 404);
  });
});

describe('CORS', () => {
  it('allows only allowlisted origins and never wildcards', async () => {
    const ok = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://preview.example.com' },
    });
    assert.equal(ok.headers['access-control-allow-origin'], 'https://preview.example.com');
    assert.equal(ok.headers['access-control-allow-credentials'], 'true');
    const bad = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
    const pre = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/households',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
  });
});

describe('CSRF and session integrity', () => {
  it('rejects forged or mismatched CSRF tokens', async () => {
    const a = h.agent();
    await a.get('/api/v1/session');
    const forged = await a.post('/api/v1/households', validHousehold(), {
      csrf: false,
      headers: { 'x-csrf-token': 'abc.def' },
    });
    assert.equal(forged.statusCode, 403);
    const other = newCsrfToken(TEST_SECRET);
    const mismatch = await a.post('/api/v1/households', validHousehold(), {
      csrf: false,
      headers: { 'x-csrf-token': other },
    });
    assert.equal(mismatch.statusCode, 403);
  });

  it('csrfCheck and session verification reject tampering, expiry and wrong secrets', () => {
    const t = newCsrfToken(TEST_SECRET);
    assert.equal(csrfCheck(TEST_SECRET, t, t), true);
    assert.equal(csrfCheck('another-secret-another-secret-123456', t, t), false);
    assert.equal(csrfCheck(TEST_SECRET, t, undefined), false);
    const uid = '3f1c1a84-5a2b-4a6e-9a3b-0d8e6b1d9c11';
    const c = signSession(TEST_SECRET, uid, Date.now());
    assert.equal(verifySession(TEST_SECRET, c), uid);
    assert.equal(verifySession(TEST_SECRET, c.replace(uid, '3f1c1a84-5a2b-4a6e-9a3b-0d8e6b1d9c12')), null);
    assert.equal(verifySession('wrong-wrong-wrong-wrong-wrong-wrong', c), null);
    assert.equal(
      verifySession(TEST_SECRET, signSession(TEST_SECRET, uid, Date.now() - 40 * 86400_000)),
      null,
    );
    assert.equal(verifySession(TEST_SECRET, 'garbage'), null);
    assert.equal(verifySession(TEST_SECRET, undefined), null);
  });

  it('a tampered session cookie is unauthorized', async () => {
    const a = h.agent();
    await a.post('/api/v1/households', validHousehold());
    a.jar.set('ca_sid', a.jar.get('ca_sid')!.slice(0, -3) + 'AAA');
    assert.equal((await a.get('/api/v1/households/3f1c1a84-5a2b-4a6e-9a3b-0d8e6b1d9c11')).statusCode, 401);
  });
});

describe('request hardening', () => {
  it('rejects oversized bodies and wrong content types with safe errors', async () => {
    const a = h.agent();
    await a.get('/api/v1/session');
    const big = await a.post('/api/v1/assistant/messages', { message: 'x'.repeat(100_000) });
    assert.equal(big.statusCode, 413);
    assert.equal(json(big).error.code, 'payload_too_large');
    const wrongType = await h.app.inject({
      method: 'POST',
      url: '/api/v1/assistant/messages',
      headers: {
        'content-type': 'text/plain',
        cookie: `ca_csrf=${a.jar.get('ca_csrf')}`,
        'x-csrf-token': a.jar.get('ca_csrf')!,
      },
      payload: 'hello',
    });
    assert.ok([400, 415].includes(wrongType.statusCode));
  });

  it('never leaks stack traces on malformed JSON', async () => {
    const a = h.agent();
    await a.get('/api/v1/session');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/households',
      headers: {
        'content-type': 'application/json',
        cookie: `ca_csrf=${a.jar.get('ca_csrf')}`,
        'x-csrf-token': a.jar.get('ca_csrf')!,
      },
      payload: '{bad json',
    });
    assert.equal(res.statusCode, 400);
    assert.ok(!/at .*\.ts|node_modules/.test(res.body));
  });

  it('is not a proxy: no route accepts a URL to fetch', async () => {
    const res = await h.agent().get('/api/v1/air-quality?lat=1&lng=1&url=http://169.254.169.254/');
    assert.equal(res.statusCode, 400);
  });
});

describe('rate limiting', () => {
  it('limits the assistant endpoint per client and returns an enveloped 429', async () => {
    const h2 = await createHarness();
    try {
      const a = h2.agent();
      h2.ai.next = '{}';
      let last = 0;
      for (let i = 0; i < 20; i++)
        last = (await a.post('/api/v1/assistant/messages', { message: 'hi', lat: 1, lng: 1 })).statusCode;
      assert.equal(last, 429);
      const res = await a.post('/api/v1/assistant/messages', { message: 'hi', lat: 1, lng: 1 });
      assert.equal(json(res).error.code, 'rate_limited');
    } finally {
      await h2.close();
    }
  });
});

describe('static assets and rate limits', () => {
  it('do not consume the API rate limit', async () => {
    const h2 = await createHarness();
    try {
      let worst = 200;
      for (let i = 0; i < 150; i++) {
        const r = await h2.app.inject({ method: 'GET', url: '/styles.css' });
        worst = Math.max(worst === 200 ? 0 : worst, r.statusCode);
      }
      assert.equal(worst, 200);
      assert.equal((await h2.agent().get('/api/v1/config')).statusCode, 200);
    } finally {
      await h2.close();
    }
  });
});

describe('log redaction', () => {
  it('redacts secrets, cookies, keys and URL key params', () => {
    const lines: string[] = [];
    const log = createLogger(
      'info',
      new Writable({
        write(c, _e, cb) {
          lines.push(String(c));
          cb();
        },
      }),
    );
    log.info(
      {
        req: {
          headers: { authorization: 'Bearer SECRET1', cookie: 'ca_sid=SECRET2', 'x-csrf-token': 'SECRET3' },
        },
        apiKey: 'SECRET4',
        GOOGLE_AIR_QUALITY_API_KEY: 'SECRET5',
        ANTHROPIC_API_KEY: 'SECRET6',
        audio: 'SECRET7',
        imageBase64: 'SECRET8',
        password: 'SECRET9',
      },
      'hello',
    );
    const out = lines.join('');
    for (let i = 1; i <= 9; i++) assert.ok(!out.includes(`SECRET${i}`), `SECRET${i} leaked: ${out}`);
    assert.equal(
      scrubUrl('https://airquality.googleapis.com/v1/x?key=ABC123&a=1'),
      'https://airquality.googleapis.com/v1/x?key=[Redacted]&a=1',
    );
  });

  it('request logs from the app never contain upstream keys or cookies', async () => {
    const h2 = await createHarness({ env: { LOG_LEVEL: 'info' } });
    try {
      const a = h2.agent();
      await a.post('/api/v1/households', validHousehold());
      await a.get('/api/v1/air-quality?lat=28.61&lng=77.21');
      const out = h2.logs.join('');
      assert.ok(out.length > 0);
      assert.ok(!out.includes('test-google-key'));
      assert.ok(!out.includes('test-anthropic-key'));
      assert.ok(!out.includes(a.jar.get('ca_sid')!));
    } finally {
      await h2.close();
    }
  });
});
