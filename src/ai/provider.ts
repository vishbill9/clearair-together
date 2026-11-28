export interface AiRequest {
  system: string;
  /** Untrusted user text is passed separately and wrapped as data by the adapter. */
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

/** A model call failed. `kind` drives the public error; `detail` is a content-free reason for logs. */
export class AiProviderError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'auth' | 'rate_limited' | 'server' | 'bad_response' | 'network',
    /** Short, content-free reason (for example `finish:MAX_TOKENS`) that is safe to log. */
    public readonly detail?: string,
  ) {
    super(`AI provider error: ${kind}`);
  }
}

/** Server-side only. Implementations must never expose keys or raw upstream bodies. */
export interface AiProvider {
  readonly name: string;
  /** Returns the model's raw text. Validation happens in the caller. */
  generate(req: AiRequest): Promise<string>;
}
