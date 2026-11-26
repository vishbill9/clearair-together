export interface AiRequest {
  system: string;
  /** Untrusted user text is passed separately and wrapped as data by the adapter. */
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

export class AiProviderError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'auth' | 'rate_limited' | 'server' | 'bad_response' | 'network',
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
