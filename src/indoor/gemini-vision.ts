import { AiProviderError } from '../ai/provider.js';

export interface VisionProvider {
  readonly name: string;
  /** Returns the model's raw text for a normalized (metadata-free) JPEG. */
  assess(input: {
    image: Buffer;
    mimeType: string;
    system: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<string>;
}

export class GeminiVisionProvider implements VisionProvider {
  readonly name = 'gemini';
  constructor(
    private readonly o: {
      apiKey: string;
      model: string;
      baseUrl?: string;
      fetchImpl?: (u: string, i: RequestInit) => Promise<Response>;
    },
  ) {}

  async assess(input: {
    image: Buffer;
    mimeType: string;
    system: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<string> {
    const f = this.o.fetchImpl ?? ((u, i) => fetch(u, i));
    const base = this.o.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), input.timeoutMs);
    let res: Response;
    try {
      res = await f(`${base}/v1beta/models/${encodeURIComponent(this.o.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.o.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [
            {
              role: 'user',
              parts: [
                { text: input.prompt },
                { inline_data: { mime_type: input.mimeType, data: input.image.toString('base64') } },
              ],
            },
          ],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 1200 },
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
      const j = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const t = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!t) throw new Error('empty');
      return t;
    } catch {
      throw new AiProviderError('bad_response');
    }
  }
}
