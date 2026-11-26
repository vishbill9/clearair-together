/* eslint-disable @typescript-eslint/no-explicit-any */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createHarness, json, validHousehold } from './helpers/app.js';

interface Fake {
  wss: WebSocketServer;
  port: number;
  received: Array<Record<string, any>>;
  sockets: WebSocket[];
  closed: number;
}

async function fakeGemini(): Promise<Fake> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const f: Fake = { wss, port: (wss.address() as AddressInfo).port, received: [], sockets: [], closed: 0 };
  wss.on('connection', (s) => {
    f.sockets.push(s);
    s.on('message', (d) => {
      const m = JSON.parse(d.toString());
      f.received.push(m);
      if (m.setup) s.send(JSON.stringify({ setupComplete: {} }));
    });
    s.on('close', () => {
      f.closed++;
    });
  });
  return f;
}

const LIVE_ENV = {
  LIVE_AI_ENABLED: 'true',
  GOOGLE_GEMINI_API_KEY: 'test-gemini-key',
  GOOGLE_GEMINI_LIVE_MODEL: 'test-live-model',
  MAX_LIVE_SESSION_SECONDS: '3600',
  LIVE_IDLE_TIMEOUT_SECONDS: '600',
};
let fake: Fake;
const connected: WebSocket[] = [];

async function setup(env: Record<string, string> = {}) {
  const h = await createHarness({
    env: { ...LIVE_ENV, ...env },
    liveUpstream: () => new WebSocket(`ws://127.0.0.1:${fake.port}`),
  });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (h.app.server.address() as AddressInfo).port;
  const a = h.agent();
  const hid = json(await a.post('/api/v1/households', validHousehold({ countryCode: 'US' }))).data
    .id as string;
  const open = (
    opts: { origin?: string | null; csrf?: string | null; cookie?: boolean; query?: string } = {},
  ) => {
    const csrf = opts.csrf === undefined ? a.jar.get('ca_csrf')! : opts.csrf;
    const qs = `${csrf ? `csrf=${encodeURIComponent(csrf)}&` : ''}${opts.query ?? `householdId=${hid}`}`;
    const headers: Record<string, string> = {};
    if (opts.origin !== null) headers.origin = opts.origin ?? 'http://localhost:3000';
    if (opts.cookie !== false) headers.cookie = [...a.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/live/voice?${qs}`, { headers });
    connected.push(ws);
    const msgs: Array<Record<string, any>> = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    return { ws, msgs };
  };
  return { h, a, hid, open, port };
}
const until = async (cond: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const waitClosed = (ws: WebSocket) =>
  ws.readyState === WebSocket.CLOSED ? Promise.resolve() : once(ws, 'close').then(() => undefined);
const rejected = (ws: WebSocket) =>
  new Promise<number>((res) => {
    ws.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0));
    ws.on('error', () => undefined);
  });

before(async () => {
  fake = await fakeGemini();
});
after(async () => {
  for (const w of connected) w.terminate();
  for (const s of fake.sockets) s.terminate();
  fake.wss.close();
});

describe('live voice: gating and authentication', () => {
  it('is not configured by default', async () => {
    const h = await createHarness();
    try {
      await h.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (h.app.server.address() as AddressInfo).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/live/voice?csrf=x`, {
        headers: { origin: 'http://localhost:3000' },
      });
      assert.equal(await rejected(ws), 503);
    } finally {
      await h.close();
    }
  });

  it('rejects missing/foreign origin, bad csrf and missing session before upgrade', async () => {
    const { h, open } = await setup();
    try {
      assert.equal(await rejected(open({ origin: null }).ws), 403);
      assert.equal(await rejected(open({ origin: 'https://evil.example' }).ws), 403);
      assert.equal(await rejected(open({ csrf: 'forged.token' }).ws), 403);
      assert.equal(await rejected(open({ csrf: null }).ws), 403);
      assert.equal(await rejected(open({ cookie: false }).ws), 403);
    } finally {
      await h.close();
    }
  });

  it("will not start a session on another user's household", async () => {
    const { h, open } = await setup();
    try {
      const mallory = h.agent();
      await mallory.post('/api/v1/households', validHousehold());
      const hidOther = json(await h.agent().post('/api/v1/households', validHousehold())).data.id;
      const { ws, msgs } = open({ query: `householdId=${hidOther}` });
      await until(() => msgs.some((m) => m.type === 'error'));
      assert.equal(msgs.find((m) => m.type === 'error')!.code, 'not_found');
      await waitClosed(ws);
    } finally {
      await h.close();
    }
  });
});

describe('live voice: session behaviour', () => {
  it('proxies setup with verified context, forwards audio, captions, interruption and never stores audio', async () => {
    fake.received.length = 0;
    const { h, a, open } = await setup();
    try {
      const { ws, msgs } = open();
      await until(() => msgs.some((m) => m.type === 'ready'));
      const setupMsg = fake.received.find((m) => m.setup)!.setup;
      assert.equal(setupMsg.model, 'models/test-live-model');
      assert.deepEqual(setupMsg.generationConfig.responseModalities, ['AUDIO']);
      assert.ok(setupMsg.inputAudioTranscription && setupMsg.outputAudioTranscription);
      const sys = setupMsg.systemInstruction.parts[0].text as string;
      assert.match(sys, /<verified_context>/);
      assert.match(sys, /google_air_quality/);
      assert.ok(!sys.includes('test-gemini-key'));

      ws.send(JSON.stringify({ type: 'audio', data: Buffer.from('pcm-bytes').toString('base64') }));
      await until(() => fake.received.some((m) => m.realtimeInput?.audio));
      assert.equal(
        fake.received.find((m) => m.realtimeInput?.audio)!.realtimeInput.audio.mimeType,
        'audio/pcm;rate=16000',
      );

      const g = fake.sockets.at(-1)!;
      g.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'Can I jog today?' } } }));
      g.send(
        JSON.stringify({
          serverContent: {
            outputTranscription: { text: 'Consider an easy walk instead.' },
            modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] },
          },
        }),
      );
      g.send(JSON.stringify({ serverContent: { interrupted: true } }));
      g.send(JSON.stringify({ serverContent: { turnComplete: true } }));
      await until(() => msgs.some((m) => m.type === 'turn_complete'));
      assert.deepEqual(
        msgs.filter((m) => m.type === 'caption').map((m) => [m.role, m.text]),
        [
          ['user', 'Can I jog today?'],
          ['assistant', 'Consider an easy walk instead.'],
        ],
      );
      assert.ok(msgs.some((m) => m.type === 'audio' && m.mimeType.startsWith('audio/')));
      assert.ok(msgs.some((m) => m.type === 'interrupted'));

      const out = h.logs.join('');
      assert.ok(!out.includes('cGNtLWJ5dGVz'), 'audio must not be logged');
      assert.ok(!out.includes('Can I jog today'), 'transcripts must not be logged');
      assert.ok(!out.includes('test-gemini-key'));
      const tables = await h.tdb
        .sql`select column_name from information_schema.columns where table_schema='public' and (column_name ilike '%audio%' or column_name ilike '%transcript%')`;
      assert.equal(tables.length, 0, 'no table can hold raw audio or transcripts');

      ws.send(JSON.stringify({ type: 'stop' }));
      await until(() => msgs.some((m) => m.type === 'closed' && m.reason === 'stopped_by_user'));
      void a;
    } finally {
      await h.close();
    }
  });

  it('a second concurrent session is refused, and the stop endpoint ends the first', async () => {
    const { h, a, open } = await setup();
    try {
      const first = open();
      await until(() => first.msgs.some((m) => m.type === 'ready'));
      assert.equal(await rejected(open().ws), 409);
      assert.equal((await a.post('/api/v1/live/voice/stop', {})).statusCode, 200);
      await until(() => first.msgs.some((m) => m.type === 'closed' && m.reason === 'stopped_by_user'));
      assert.equal((await a.post('/api/v1/live/voice/stop', {})).statusCode, 404);
      assert.equal((await h.agent().post('/api/v1/live/voice/stop', {})).statusCode, 401);
    } finally {
      await h.close();
    }
  });

  it('urgent symptoms end the model session and return emergency guidance for the household country', async () => {
    const { h, open } = await setup();
    try {
      const { ws, msgs } = open();
      await until(() => msgs.some((m) => m.type === 'ready'));
      fake.sockets
        .at(-1)!
        .send(JSON.stringify({ serverContent: { inputTranscription: { text: "I can't breathe" } } }));
      await until(() => msgs.some((m) => m.type === 'emergency'));
      const e = msgs.find((m) => m.type === 'emergency')!;
      assert.equal(e.emergencyNumber, '911');
      assert.equal(e.notEmergencyService, true);
      await waitClosed(ws);
    } finally {
      await h.close();
    }
  });

  it('blocks unsafe assistant speech via transcript checks and closes', async () => {
    const { h, open } = await setup();
    try {
      const { ws, msgs } = open();
      await until(() => msgs.some((m) => m.type === 'ready'));
      fake.sockets.at(-1)!.send(
        JSON.stringify({
          serverContent: {
            outputTranscription: { text: 'The AQI is 777 and you should double your inhaler dose.' },
          },
        }),
      );
      await until(() => msgs.some((m) => m.type === 'blocked'));
      assert.ok(!msgs.some((m) => m.type === 'caption' && /777/.test(m.text)));
      await waitClosed(ws);
    } finally {
      await h.close();
    }
  });

  it('closes on idle timeout and on max duration', async () => {
    const idle = await setup({ LIVE_IDLE_TIMEOUT_SECONDS: '1', MAX_LIVE_SESSION_SECONDS: '60' });
    try {
      const { msgs } = idle.open();
      await until(() => msgs.some((m) => m.type === 'closed' && m.reason === 'idle_timeout'), 5000);
    } finally {
      await idle.h.close();
    }
    const max = await setup({ MAX_LIVE_SESSION_SECONDS: '2', LIVE_IDLE_TIMEOUT_SECONDS: '60' });
    try {
      const { ws, msgs } = max.open();
      await until(() => msgs.some((m) => m.type === 'ready'));
      const t = setInterval(
        () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'audio', data: 'AAAA' })),
        200,
      );
      await until(() => msgs.some((m) => m.type === 'closed' && m.reason === 'max_duration'), 6000);
      clearInterval(t);
    } finally {
      await max.h.close();
    }
  });

  it('closes the upstream connection when the client disconnects (cleanup)', async () => {
    const before = fake.closed;
    const { h, open } = await setup();
    try {
      const { ws, msgs } = open();
      await until(() => msgs.some((m) => m.type === 'ready'));
      ws.terminate();
      await until(() => fake.closed > before);
    } finally {
      await h.close();
    }
  });

  it('rejects protocol abuse: binary frames, bad JSON, oversized or malformed audio, unknown types, floods', async () => {
    const { h, open } = await setup();
    try {
      for (const bad of [
        Buffer.from([1, 2, 3]),
        '{not json',
        JSON.stringify({ type: 'audio', data: '***' }),
        JSON.stringify({ type: 'audio', data: 'A'.repeat(60_000) }),
        JSON.stringify({ type: 'evil' }),
        JSON.stringify({ type: 'audio', data: 'AAAA', extra: 1 }),
      ]) {
        const { ws, msgs } = open();
        await until(() => msgs.some((m) => m.type === 'ready'));
        ws.send(bad);
        await waitClosed(ws);
        await new Promise((r) => setTimeout(r, 30));
      }
      const { ws, msgs } = open();
      await until(() => msgs.some((m) => m.type === 'ready'));
      for (let i = 0; i < 100; i++) ws.send(JSON.stringify({ type: 'audio', data: 'AAAA' }));
      await until(() => msgs.some((m) => m.type === 'closed' && m.reason === 'rate_limited'));
    } finally {
      await h.close();
    }
  });

  it('limits session starts per hour', async () => {
    const { h, a, open } = await setup();
    try {
      let last = 0;
      for (let i = 0; i < 11; i++) {
        const { ws, msgs } = open();
        const code = await Promise.race([
          rejected(ws),
          until(() => msgs.some((m) => m.type === 'ready')).then(() => 101),
        ]);
        last = code;
        if (code === 101) {
          await a.post('/api/v1/live/voice/stop', {});
          await until(() => ws.readyState === WebSocket.CLOSED);
        }
      }
      assert.equal(last, 429);
    } finally {
      await h.close();
    }
  });
});
