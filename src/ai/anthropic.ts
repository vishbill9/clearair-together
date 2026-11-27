import { postJson, type FetchLike } from './http.js';
import { AiProviderError, type AiProvider, type AiRequest } from './provider.js';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/** Anthropic Messages API; returns the concatenated text blocks. */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly baseUrl: string;
  constructor(private readonly o: AnthropicOptions) {
    this.baseUrl = o.baseUrl ?? 'https://api.anthropic.com';
  }

  async generate(req: AiRequest): Promise<string> {
    const reply = await postJson<{ content?: Array<{ type: string; text?: string }> }>({
      url: `${this.baseUrl}/v1/messages`,
      headers: { 'x-api-key': this.o.apiKey, 'anthropic-version': '2023-06-01' },
      body: {
        model: this.o.model,
        max_tokens: req.maxTokens,
        temperature: 0.2,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      },
      timeoutMs: req.timeoutMs,
      fetchImpl: this.o.fetchImpl,
    });
    const out = (reply.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (!out) throw new AiProviderError('bad_response', 'empty');
    return out;
  }
}
