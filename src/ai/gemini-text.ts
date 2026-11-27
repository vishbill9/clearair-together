import { AiProviderError, type AiProvider, type AiRequest } from './provider.js';

export interface GeminiTextOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Text-only Gemini (generateContent). Asks for JSON; the caller still validates every reply. */
export class GeminiTextProvider implements AiProvider {
  readonly name = 'gemini';
  constructor(private readonly o: GeminiTextOptions) {}

  async generate(req: AiRequest): Promise<string> {
    const f = this.o.fetchImpl ?? ((u, i) => fetch(u, i));
    const base = this.o.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
    let res: Response;
    try {
      res = await f(`${base}/v1beta/models/${encodeURIComponent(this.o.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.o.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json',
            maxOutputTokens: req.maxTokens,
          },
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
    try {
      const text = await res.text();
      if (text.length > 200_000) throw new Error('too large');
      const j = JSON.parse(text) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const out = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!out.trim()) throw new Error('empty');
      return out;
    } catch {
      throw new AiProviderError('bad_response');
    }
  }
}
