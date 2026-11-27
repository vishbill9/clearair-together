import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FallbackProvider } from '../src/ai/fallback.js';
import { AiProviderError, type AiProvider } from '../src/ai/provider.js';

const req = { system: 's', user: 'u', maxTokens: 10, timeoutMs: 30_000 };
const ok = (text: string, seen: number[] = []): AiProvider => ({
  name: 'ok',
  async generate(r) {
    seen.push(r.timeoutMs);
    return text;
  },
});
const failing = (kind: AiProviderError['kind']): AiProvider => ({
  name: 'bad',
  async generate() {
    throw new AiProviderError(kind, 'x');
  },
});

describe('FallbackProvider', () => {
  it('uses the primary and caps its timeout', async () => {
    const seen: number[] = [];
    const p = new FallbackProvider(ok('a', seen), ok('b'), { primaryTimeoutMs: 12_000 });
    assert.equal(await p.generate(req), 'a');
    assert.deepEqual(seen, [12_000]);
  });

  it('falls back on a provider error and reports it', async () => {
    const kinds: string[] = [];
    const p = new FallbackProvider(failing('timeout'), ok('b'), {
      primaryTimeoutMs: 1000,
      onFallback: (e) => kinds.push(e.kind),
    });
    assert.equal(await p.generate(req), 'b');
    assert.deepEqual(kinds, ['timeout']);
  });

  it('throws the secondary error when both fail, and never swallows other errors', async () => {
    const both = new FallbackProvider(failing('timeout'), failing('server'), { primaryTimeoutMs: 1 });
    await assert.rejects(both.generate(req), (e: AiProviderError) => e.kind === 'server');
    const boom: AiProvider = {
      name: 'boom',
      async generate() {
        throw new TypeError('bug');
      },
    };
    await assert.rejects(
      new FallbackProvider(boom, ok('b'), { primaryTimeoutMs: 1 }).generate(req),
      TypeError,
    );
  });
});
