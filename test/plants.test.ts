import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, json, type Harness } from './helpers/app.js';
import { AiProviderError, type AiProvider, type AiRequest } from '../src/ai/provider.js';
import { GeminiTextProvider } from '../src/ai/gemini-text.js';
import { PLANTS } from '../src/plants/catalog.js';
import { claimsAirCleaning, isIngestionConcern } from '../src/plants/chat.js';

let reply = '{"answer":"Try a pothos near a window.","cautions":["Toxic to pets."]}';
let last: AiRequest | null = null;
let fail: AiProviderError | null = null;
const provider: AiProvider = {
  name: 'stub',
  async generate(req) {
    last = req;
    if (fail) throw fail;
    return reply;
  },
};

let h: Harness;
before(async () => {
  h = await createHarness({
    env: { GOOGLE_GEMINI_API_KEY: 'g-test', GOOGLE_GEMINI_CHAT_MODEL: 'chat-test' },
    plantProvider: provider,
  });
});
after(async () => {
  await h.close();
});

describe('plant catalog', () => {
  it('has complete entries, unique ids and never claims air cleaning', () => {
    assert.equal(new Set(PLANTS.map((p) => p.id)).size, PLANTS.length);
    for (const p of PLANTS) {
      assert.ok(p.name && p.botanical && p.water && p.petNote && p.why && p.light.length > 0);
      assert.equal(claimsAirCleaning(`${p.why} ${p.petNote}`), false, p.id);
    }
    assert.ok(PLANTS.some((p) => p.petSafe) && PLANTS.some((p) => !p.petSafe));
  });
  it('is served with an honest note', async () => {
    const r = await h.agent().get('/api/v1/plants');
    assert.equal(r.statusCode, 200);
    const d = json(r).data;
    assert.equal(d.plants.length, PLANTS.length);
    assert.match(d.note, /very little/);
  });
});

describe('safety helpers', () => {
  it('detects plant ingestion by pets or children', () => {
    assert.equal(isIngestionConcern('my cat ate a pothos leaf'), true);
    assert.equal(isIngestionConcern('The toddler chewed my plant'), true);
    assert.equal(isIngestionConcern('How often do I water a pothos?'), false);
  });
  it('flags air-cleaning claims but not honest denials', () => {
    assert.equal(claimsAirCleaning('Snake plants purify the air in your bedroom.'), true);
    assert.equal(claimsAirCleaning('This plant removes toxins from the air.'), true);
    assert.equal(claimsAirCleaning('Plants will not clean your air in any real way.'), false);
    assert.equal(claimsAirCleaning('Water it weekly and give it bright light.'), false);
  });
});

describe('plant chat', () => {
  const ask = (body: unknown) => h.agent().post('/api/v1/plants/chat', body);

  it('returns a validated answer and sends household hints inside tags', async () => {
    reply = '{"answer":"Try a pothos near a window.","cautions":["Toxic to pets."]}';
    const r = await ask({ question: 'Easy plant for a dim room?', light: 'low', pets: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(json(r).data.kind, 'answer');
    assert.deepEqual(json(r).data.cautions, ['Toxic to pets.']);
    assert.match(last!.user, /<user_question>Easy plant for a dim room\?<\/user_question>/);
    assert.match(last!.user, /cats or dogs/);
    assert.match(last!.system, /NEVER say or imply that a plant cleans/);
  });

  it('tolerates extra keys, fenced JSON, long text and too many cautions by trimming', async () => {
    reply =
      '```json\n' +
      JSON.stringify({
        answer: 'a'.repeat(2000),
        cautions: ['c'.repeat(500), '2', '3', '4', '5'],
        extra: 1,
      }) +
      '\n```';
    const d = json(await ask({ question: 'Tell me about ferns' })).data;
    assert.equal(d.kind, 'answer');
    assert.ok(d.answer.length <= 1400);
    assert.equal(d.cautions.length, 4);
    assert.ok(d.cautions[0].length <= 240);
  });

  it('withholds an answer that claims plants clean the air', async () => {
    reply = '{"answer":"A snake plant purifies the air and removes formaldehyde.","cautions":[]}';
    const r = await ask({ question: 'Which plant cleans my air?' });
    assert.equal(json(r).data.kind, 'safety');
    assert.equal(json(r).data.blocked, true);
    assert.doesNotMatch(r.body, /formaldehyde/);
  });

  it('withholds answers that quote an AQI number or a link', async () => {
    reply = '{"answer":"Your AQI is 187 so keep the plant inside.","cautions":[]}';
    assert.equal(json(await ask({ question: 'Should the fern go outside?' })).data.kind, 'safety');
    reply = '{"answer":"See https://example.com/plants for more.","cautions":[]}';
    assert.equal(json(await ask({ question: 'Where can I read more?' })).data.kind, 'safety');
  });

  it('answers a pet or child eating a plant with urgent guidance and no model call', async () => {
    last = null;
    const r = await ask({ question: 'My dog ate part of my peace lily' });
    assert.equal(json(r).data.kind, 'urgent');
    assert.match(json(r).data.answer, /vet|poison/i);
    assert.equal(last, null);
  });

  it('maps provider and format failures to safe errors and validates input', async () => {
    reply = 'not json at all';
    assert.equal((await ask({ question: 'Hello plants?' })).statusCode, 502);
    reply = '{"cautions":["no answer field"]}';
    assert.equal((await ask({ question: 'Hello plants?' })).statusCode, 502);
    fail = new AiProviderError('timeout');
    assert.equal((await ask({ question: 'Hello plants?' })).statusCode, 503);
    fail = null;
    assert.equal((await ask({ question: '' })).statusCode, 400);
    assert.equal((await ask({ question: 'x'.repeat(601) })).statusCode, 400);
    assert.equal((await ask({ question: 'fine question', admin: true })).statusCode, 400);
    assert.equal(
      (await h.agent().post('/api/v1/plants/chat', { question: 'hi there' }, { csrf: false })).statusCode,
      403,
    );
  });

  it('is not configured without a chat model, but urgent help still works', async () => {
    const off = await createHarness({ plantProvider: null });
    try {
      const a = off.agent();
      assert.equal(
        (await a.post('/api/v1/plants/chat', { question: 'Which plant is easy?' })).statusCode,
        503,
      );
      assert.equal(
        json(await a.post('/api/v1/plants/chat', { question: 'cat ate my fern' })).data.kind,
        'urgent',
      );
    } finally {
      await off.close();
    }
  });
});

describe('Gemini text adapter', () => {
  const req: AiRequest = { system: 's', user: 'u', maxTokens: 100, timeoutMs: 100 };
  const mk = (r: () => Response) =>
    new GeminiTextProvider({ apiKey: 'k-secret', model: 'm/odel', fetchImpl: async () => r() });
  it('uses the key header (never the URL) and returns text', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = new GeminiTextProvider({
      apiKey: 'k-secret',
      model: 'm1',
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }));
      },
    });
    assert.equal(await p.generate(req), '{"a":1}');
    assert.ok(!seen!.url.includes('k-secret'));
    assert.equal((seen!.init.headers as Record<string, string>)['x-goog-api-key'], 'k-secret');
    assert.match(seen!.url, /models\/m1:generateContent$/);
  });
  it('reports a truncated or empty reply with a safe reason and ignores thought parts', async () => {
    const body = (parts: unknown, finishReason = 'STOP') =>
      JSON.stringify({ candidates: [{ finishReason, content: { parts } }] });
    await assert.rejects(
      mk(() => new Response(body([{ text: '{"a":' }], 'MAX_TOKENS'))).generate(req),
      (e: AiProviderError) => e.detail === 'finish:MAX_TOKENS',
    );
    await assert.rejects(
      mk(() => new Response(body([{ text: 'thinking...', thought: true }]))).generate(req),
      (e: AiProviderError) => e.kind === 'bad_response' && /^empty:/.test(e.detail ?? ''),
    );
    const ok = await mk(
      () => new Response(body([{ text: 'hmm', thought: true }, { text: '{"x":1}' }])),
    ).generate(req);
    assert.equal(ok, '{"x":1}');
  });
  it('sends the response schema when configured', async () => {
    let sent = '';
    const p = new GeminiTextProvider({
      apiKey: 'k',
      model: 'm',
      responseSchema: { type: 'OBJECT' },
      fetchImpl: async (_u, i) => {
        sent = String(i.body);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }));
      },
    });
    await p.generate(req);
    assert.equal(JSON.parse(sent).generationConfig.responseSchema.type, 'OBJECT');
  });
  it('maps errors', async () => {
    for (const [s, k] of [
      [401, 'auth'],
      [429, 'rate_limited'],
      [500, 'server'],
      [400, 'bad_response'],
    ] as const) {
      await assert.rejects(
        mk(() => new Response('{}', { status: s })).generate(req),
        (e: AiProviderError) => e.kind === k,
      );
    }
    await assert.rejects(
      mk(() => new Response('{}')).generate(req),
      (e: AiProviderError) => e.kind === 'bad_response',
    );
  });
});
