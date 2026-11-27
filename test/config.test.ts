import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/config.js';
import { AnthropicProvider } from '../src/ai/anthropic.js';
import { OllamaProvider } from '../src/ai/ollama.js';
import { AiProviderError } from '../src/ai/provider.js';

const prod = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://clearair.example.com',
  DATABASE_URL: 'postgres://u:p@h/db',
  GOOGLE_AIR_QUALITY_API_KEY: 'g',
  ANTHROPIC_API_KEY: 'a',
  SESSION_SECRET: 's'.repeat(40),
};
const load = (env: Record<string, string | undefined>, warns: string[] = []) =>
  loadConfig(env as NodeJS.ProcessEnv, (m) => warns.push(m));

describe('configuration', () => {
  it('production fails fast when any required secret is missing', () => {
    for (const k of ['DATABASE_URL', 'GOOGLE_AIR_QUALITY_API_KEY', 'ANTHROPIC_API_KEY', 'SESSION_SECRET']) {
      assert.throws(() => load({ ...prod, [k]: undefined }), ConfigError, k);
    }
    assert.throws(() => load({ ...prod, SESSION_SECRET: 'short' }), ConfigError);
    assert.throws(() => load({ ...prod, APP_ORIGIN: 'http://insecure.example.com' }), ConfigError);
    assert.equal(load(prod).isProduction, true);
  });
  it('production refuses to redirect the Google endpoint elsewhere', () => {
    assert.throws(
      () => load({ ...prod, GOOGLE_AIR_QUALITY_BASE_URL: 'https://evil.example.com' }),
      ConfigError,
    );
  });
  it('development works without keys and reports explicit not-configured integrations', () => {
    const warns: string[] = [];
    const c = load({ NODE_ENV: 'development' }, warns);
    assert.equal(c.integrations.googleAirQuality, false);
    assert.equal(c.integrations.assistant, false);
    assert.equal(c.integrations.database, false);
    assert.ok(warns.length > 0);
    assert.ok(c.sessionSecret.length >= 32);
  });
  it('live voice requires its credentials when enabled', () => {
    assert.throws(() => load({ ...prod, LIVE_AI_ENABLED: 'true' }), ConfigError);
  });
  it('defaults match the spec', () => {
    const c = load({ NODE_ENV: 'development' });
    assert.equal(c.airQuality.cacheTtlSeconds, 900);
    assert.equal(c.airQuality.maxForecastHours, 96);
    assert.equal(c.aiModel, 'claude-3-5-sonnet-latest');
  });
});

describe('Anthropic adapter', () => {
  const mk = (resp: () => Response | Promise<Response>) =>
    new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'm',
      baseUrl: 'https://api.anthropic.com',
      fetchImpl: async () => resp(),
    });
  const req = { system: 's', user: 'u', maxTokens: 10, timeoutMs: 100 };
  it('sends the key only as a header to the Anthropic host and returns text', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'm',
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }));
      },
    });
    assert.equal(await p.generate(req), 'hi');
    assert.equal(seen!.url, 'https://api.anthropic.com/v1/messages');
    assert.equal((seen!.init.headers as Record<string, string>)['x-api-key'], 'sk-test');
    assert.ok(!String(seen!.init.body).includes('sk-test'));
  });
  it('maps failures to typed errors', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [429, 'rate_limited'],
      [503, 'server'],
      [400, 'bad_response'],
    ] as const) {
      await assert.rejects(
        mk(() => new Response('{}', { status })).generate(req),
        (e: AiProviderError) => e.kind === kind,
      );
    }
    await assert.rejects(
      mk(() => new Response('not json')).generate(req),
      (e: AiProviderError) => e.kind === 'bad_response',
    );
    await assert.rejects(
      mk(() => new Response(JSON.stringify({ content: [] }))).generate(req),
      (e: AiProviderError) => e.kind === 'bad_response',
    );
  });
  it('times out', async () => {
    const p = new AnthropicProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: (_u, i) =>
        new Promise((_r, rej) =>
          i.signal?.addEventListener('abort', () =>
            rej(Object.assign(new Error('x'), { name: 'AbortError' })),
          ),
        ),
    });
    await assert.rejects(p.generate({ ...req, timeoutMs: 20 }), (e: AiProviderError) => e.kind === 'timeout');
  });
});

describe('provider selection', () => {
  const { ANTHROPIC_API_KEY: _drop, ...noAi } = prod;
  it('prefers Ollama when its key is set and defaults to gemma4:31b', () => {
    const c = load({ ...prod, OLLAMA_API_KEY: 'o' });
    assert.equal(c.aiProvider, 'ollama');
    assert.equal(c.ollama.model, 'gemma4:31b');
    assert.equal(c.ollama.baseUrl, 'https://ollama.com');
    assert.equal(c.integrations.assistant, true);
  });
  it('accepts Ollama alone in production and honours AI_PROVIDER', () => {
    assert.equal(load({ ...noAi, OLLAMA_API_KEY: 'o' }).aiProvider, 'ollama');
    assert.equal(load({ ...prod, OLLAMA_API_KEY: 'o', AI_PROVIDER: 'anthropic' }).aiProvider, 'anthropic');
    assert.throws(() => load({ ...noAi, OLLAMA_API_KEY: 'o', AI_PROVIDER: 'anthropic' }), ConfigError);
    assert.throws(() => load({ ...prod, AI_PROVIDER: 'ollama' }), ConfigError);
    assert.throws(() => load(noAi), ConfigError);
  });
  it('falls back to Anthropic when only that key exists', () => {
    assert.equal(load(prod).aiProvider, 'anthropic');
  });
});

describe('Ollama adapter', () => {
  const req = { system: 'sys', user: 'usr', maxTokens: 50, timeoutMs: 100 };
  const mk = (resp: () => Response | Promise<Response>) =>
    new OllamaProvider({ apiKey: 'ok-test', model: 'gemma4:31b', fetchImpl: async () => resp() });
  it('posts to /api/chat with a Bearer header, non-streaming, and returns content', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = new OllamaProvider({
      apiKey: 'ok-test',
      model: 'gemma4:31b',
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ message: { role: 'assistant', content: '{"a":1}' } }));
      },
    });
    assert.equal(await p.generate(req), '{"a":1}');
    assert.equal(seen!.url, 'https://ollama.com/api/chat');
    assert.equal((seen!.init.headers as Record<string, string>).authorization, 'Bearer ok-test');
    const body = JSON.parse(String(seen!.init.body));
    assert.equal(body.stream, false);
    assert.equal(body.model, 'gemma4:31b');
    assert.deepEqual(
      body.messages.map((m: { role: string }) => m.role),
      ['system', 'user'],
    );
    assert.equal(body.options.num_predict, 50);
    assert.ok(!String(seen!.init.body).includes('ok-test'));
  });
  it('maps failures to typed errors', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate_limited'],
      [502, 'server'],
      [400, 'bad_response'],
    ] as const) {
      await assert.rejects(
        mk(() => new Response('{}', { status })).generate(req),
        (e: AiProviderError) => e.kind === kind,
      );
    }
    for (const body of ['not json', '{}', JSON.stringify({ message: { content: '  ' } })]) {
      await assert.rejects(
        mk(() => new Response(body)).generate(req),
        (e: AiProviderError) => e.kind === 'bad_response',
      );
    }
  });
  it('times out and reports network errors', async () => {
    const slow = new OllamaProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: (_u, i) =>
        new Promise((_r, rej) =>
          i.signal?.addEventListener('abort', () =>
            rej(Object.assign(new Error('x'), { name: 'AbortError' })),
          ),
        ),
    });
    await assert.rejects(slow.generate({ ...req, timeoutMs: 20 }), (e: AiProviderError) => e.kind === 'timeout');
    const down = new OllamaProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(down.generate(req), (e: AiProviderError) => e.kind === 'network');
  });
});
