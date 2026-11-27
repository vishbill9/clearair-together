import { AiProviderError, type AiProvider, type AiRequest } from './provider.js';

export interface OllamaOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Ollama Cloud (https://ollama.com/api/chat), non-streaming.
 * Cloud models do not support structured outputs, so the JSON contract is enforced by the
 * prompt and then validated by Zod and the safety policy in AssistantService - same as any provider.
 */
export class OllamaProvider implements AiProvider {
  readonly name = 'ollama';
  private readonly baseUrl: string;
  private readonly fetchImpl: NonNullable<OllamaOptions['fetchImpl']>;
  constructor(private readonly o: OllamaOptions) {
    this.baseUrl = (o.baseUrl ?? 'https://ollama.com').replace(/\/$/, '');
    this.fetchImpl = o.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  async generate(req: AiRequest): Promise<string> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.o.apiKey}`,
        },
        body: JSON.stringify({
          model: this.o.model,
          stream: false,
          think: false,
          options: { temperature: 0.2, num_predict: req.maxTokens },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
        signal: ctl.signal,
        redirect: 'error',
      });
    } catch (e) {
      throw new AiProviderError((e as Error)?.name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new AiProviderError('auth');
    if (res.status === 429) throw new AiProviderError('rate_limited');
    if (res.status >= 500) throw new AiProviderError('server');
    if (!res.ok) throw new AiProviderError('bad_response');
    const text = await res.text();
    if (text.length > 200_000) throw new AiProviderError('bad_response');
    try {
      const j = JSON.parse(text) as { message?: { content?: unknown } };
      const out = j.message?.content;
      if (typeof out !== 'string' || !out.trim()) throw new Error('empty');
      return out;
    } catch {
      throw new AiProviderError('bad_response');
    }
  }
}
