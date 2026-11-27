import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Writable } from 'node:stream';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { FetchLike } from '../../src/google/client.js';
import type { AiProvider } from '../../src/ai/provider.js';
import type { VisionProvider } from '../../src/indoor/gemini-vision.js';
import { createTestDb, type TestDb } from './db.js';
import { currentBody, jsonResponse } from './google-fixtures.js';

export const TEST_SECRET = 'test-secret-test-secret-test-secret-123456';

export function testConfig(over: Record<string, string | undefined> = {}, database?: string): Config {
  return loadConfig(
    {
      NODE_ENV: 'test',
      APP_ORIGIN: 'http://localhost:3000',
      SESSION_SECRET: TEST_SECRET,
      GOOGLE_AIR_QUALITY_API_KEY: 'test-google-key',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      DATABASE_URL: database,
      LOG_LEVEL: 'silent',
      ...over,
    } as NodeJS.ProcessEnv,
    () => undefined,
  );
}

export interface Harness {
  app: FastifyInstance;
  tdb: TestDb;
  logs: string[];
  state: { google: 'ok' | 'down' | 'auth'; googleCalls: number };
  ai: { next: string | (() => string); calls: string[] };
  vision: { next: string | (() => string); calls: Array<{ bytes: number; mime: string; hasExif: boolean }> };
  agent(): Agent;
  close(): Promise<void>;
}

export interface Agent {
  jar: Map<string, string>;
  get(url: string, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  send(
    method: 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
    opts?: { csrf?: boolean; headers?: Record<string, string> },
  ): Promise<LightMyRequestResponse>;
  post(
    url: string,
    body?: unknown,
    opts?: { csrf?: boolean; headers?: Record<string, string> },
  ): Promise<LightMyRequestResponse>;
  put(
    url: string,
    body?: unknown,
    opts?: { csrf?: boolean; headers?: Record<string, string> },
  ): Promise<LightMyRequestResponse>;
  delete(
    url: string,
    opts?: { csrf?: boolean; headers?: Record<string, string> },
  ): Promise<LightMyRequestResponse>;
}

export async function createHarness(
  opts: {
    env?: Record<string, string | undefined>;
    withAi?: boolean;
    withGoogleKey?: boolean;
    withVision?: boolean;
    liveUpstream?: import('../../src/live/voice.js').UpstreamFactory | null;
    oauthFetch?: import('../../src/routes/google-login.js').OAuthFetch;
    plantProvider?: import('../../src/ai/provider.js').AiProvider | null;
  } = {},
): Promise<Harness> {
  const tdb = await createTestDb();
  const env = { ...opts.env };
  if (opts.withGoogleKey === false) env.GOOGLE_AIR_QUALITY_API_KEY = '';
  if (opts.withVision !== false) {
    env.GOOGLE_GEMINI_API_KEY ??= 'test-gemini-key';
    env.GOOGLE_GEMINI_VISION_MODEL ??= 'test-vision-model';
    env.IMAGE_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
  }
  const config = testConfig(env, tdb.url);
  const state: Harness['state'] = { google: 'ok', googleCalls: 0 };
  const googleFetch: FetchLike = async () => {
    state.googleCalls++;
    if (state.google === 'down') return jsonResponse({}, 503);
    if (state.google === 'auth') return jsonResponse({}, 403);
    return jsonResponse(currentBody());
  };
  const ai: Harness['ai'] = { next: '{}', calls: [] };
  const provider: AiProvider | null =
    opts.withAi === false
      ? null
      : {
          name: 'stub',
          async generate(req) {
            ai.calls.push(req.user);
            return typeof ai.next === 'function' ? ai.next() : ai.next;
          },
        };
  const vision: Harness['vision'] = { next: '{}', calls: [] };
  const visionProvider: VisionProvider | null =
    opts.withVision === false
      ? null
      : {
          name: 'stub',
          async assess(i) {
            vision.calls.push({
              bytes: i.image.length,
              mime: i.mimeType,
              hasExif: i.image.includes(Buffer.from('Exif')),
            });
            return typeof vision.next === 'function' ? vision.next() : vision.next;
          },
        };
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk, _e, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const { app } = await buildApp({
    config,
    dbh: tdb,
    googleFetch,
    aiProvider: provider,
    visionProvider,
    ...(opts.liveUpstream !== undefined ? { liveUpstream: opts.liveUpstream } : {}),
    ...(opts.oauthFetch ? { oauthFetch: opts.oauthFetch } : {}),
    ...(opts.plantProvider !== undefined ? { plantProvider: opts.plantProvider } : {}),
    logDestination: sink,
    now: () => new Date(),
  });
  await app.ready();

  const agent = (): Agent => {
    const jar = new Map<string, string>();
    const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const absorb = (res: LightMyRequestResponse) => {
      for (const c of res.cookies) jar.set(c.name, c.value);
    };
    const get: Agent['get'] = async (url, headers = {}) => {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader(), ...headers } });
      absorb(res);
      return res;
    };
    const send: Agent['send'] = async (method, url, body, o = {}) => {
      if (!jar.has('ca_csrf')) await get('/api/v1/session');
      const headers: Record<string, string> = {
        cookie: cookieHeader(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...o.headers,
      };
      if (o.csrf !== false && jar.has('ca_csrf')) headers['x-csrf-token'] = jar.get('ca_csrf')!;
      const res = await app.inject({
        method,
        url,
        headers,
        payload: body === undefined ? undefined : JSON.stringify(body),
      });
      absorb(res);
      return res;
    };
    return {
      jar,
      get,
      send,
      post: (u, b, o) => send('POST', u, b, o),
      put: (u, b, o) => send('PUT', u, b, o),
      delete: (u, o) => send('DELETE', u, undefined, o),
    };
  };

  return {
    app,
    tdb,
    logs,
    state,
    ai,
    vision,
    agent,
    close: async () => {
      await app.close();
      await tdb.drop();
    },
  };
}

export const json = <T = any>(res: LightMyRequestResponse): T => JSON.parse(res.body) as T; // eslint-disable-line @typescript-eslint/no-explicit-any

export const validHousehold = (over: Record<string, unknown> = {}) => ({
  name: 'Home',
  lat: 28.6139,
  lng: 77.209,
  approximateLabel: 'Delhi',
  countryCode: 'IN',
  members: [{ label: 'Child', ageGroup: 'child', needsExtraCaution: true }],
  constraints: { commuteMode: 'car', canWorkFromHome: true, hasAirPurifier: true, timeFlexibility: 'some' },
  ...over,
});

export function multipartBody(
  fields: Record<string, string>,
  file?: { name?: string; filename: string; type: string; data: Buffer },
) {
  const boundary = '----clearair' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name ?? 'image'}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
    );
    chunks.push(file.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
