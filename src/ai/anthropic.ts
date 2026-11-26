import { AiProviderError, type AiProvider, type AiRequest } from './provider.js';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly baseUrl: string;
  private readonly fetchImpl: NonNullable<AnthropicOptions['fetchImpl']>;
  constructor(private readonly o: AnthropicOptions) {
    this.baseUrl = o.baseUrl ?? 'https://api.anthropic.com';
    this.fetchImpl = o.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  async generate(req: AiRequest): Promise<string> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.o.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.o.model,
          max_tokens: req.maxTokens,
          temperature: 0.2,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
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
      const j = JSON.parse(text) as { content?: Array<{ type: string; text?: string }> };
      const out = (j.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (!out) throw new Error('empty');
      return out;
    } catch {
      throw new AiProviderError('bad_response');
    }
  }
}
