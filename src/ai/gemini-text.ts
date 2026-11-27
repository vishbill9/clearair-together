import { postJson, type FetchLike } from './http.js';
import { AiProviderError, type AiProvider, type AiRequest } from './provider.js';

export interface GeminiTextOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Gemini JSON schema (OpenAPI subset) that constrains the reply shape. */
  responseSchema?: Record<string, unknown>;
  fetchImpl?: FetchLike;
}

interface GeminiReply {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
  promptFeedback?: { blockReason?: string };
}

/** Joins the answer text, skipping "thought" parts so reasoning never reaches the user. */
function geminiText(reply: GeminiReply): string {
  const c = reply.candidates?.[0];
  const parts = c?.content?.parts ?? [];
  const out = parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
  if (!out.trim()) throw new AiProviderError('bad_response', `empty:${emptyReason(reply)}`);
  if (c?.finishReason === 'MAX_TOKENS') throw new AiProviderError('bad_response', 'finish:MAX_TOKENS');
  return out;
}

const emptyReason = (reply: GeminiReply) =>
  reply.promptFeedback?.blockReason ?? reply.candidates?.[0]?.finishReason ?? 'none';

/** Text-only Gemini (generateContent). Asks for JSON; the caller still validates every reply. */
export class GeminiTextProvider implements AiProvider {
  readonly name = 'gemini';
  constructor(private readonly o: GeminiTextOptions) {}

  async generate(req: AiRequest): Promise<string> {
    const base = this.o.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const schema = this.o.responseSchema ? { responseSchema: this.o.responseSchema } : {};
    const reply = await postJson<GeminiReply>({
      url: `${base}/v1beta/models/${encodeURIComponent(this.o.model)}:generateContent`,
      headers: { 'x-goog-api-key': this.o.apiKey },
      body: {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: 'application/json',
          ...schema,
          maxOutputTokens: req.maxTokens,
        },
      },
      timeoutMs: req.timeoutMs,
      fetchImpl: this.o.fetchImpl,
    });
    return geminiText(reply);
  }
}
