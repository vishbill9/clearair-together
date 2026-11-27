import { postJson, type FetchLike } from './http.js';
import { AiProviderError, type AiProvider, type AiRequest } from './provider.js';

export interface OllamaOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * Ollama Cloud (https://ollama.com/api/chat), non-streaming.
 * Cloud models do not support structured outputs, so the JSON contract is enforced by the
 * prompt and then validated by Zod and the safety policy in AssistantService, as for any provider.
 */
export class OllamaProvider implements AiProvider {
  readonly name = 'ollama';
  private readonly baseUrl: string;
  constructor(private readonly o: OllamaOptions) {
    this.baseUrl = (o.baseUrl ?? 'https://ollama.com').replace(/\/$/, '');
  }

  async generate(req: AiRequest): Promise<string> {
    const reply = await postJson<{ message?: { content?: unknown } }>({
      url: `${this.baseUrl}/api/chat`,
      headers: { authorization: `Bearer ${this.o.apiKey}` },
      body: {
        model: this.o.model,
        stream: false,
        think: false,
        options: { temperature: 0.2, num_predict: req.maxTokens },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      },
      timeoutMs: req.timeoutMs,
      fetchImpl: this.o.fetchImpl,
    });
    const out = reply.message?.content;
    if (typeof out !== 'string' || !out.trim()) throw new AiProviderError('bad_response', 'empty');
    return out;
  }
}
