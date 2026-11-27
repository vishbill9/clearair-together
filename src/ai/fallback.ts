import { AiProviderError, type AiProvider, type AiRequest } from './provider.js';

export interface FallbackOptions {
  /** Upper bound for the first provider, so a slow upstream leaves time for the second one. */
  primaryTimeoutMs: number;
  /** Called with content-free details when the first provider fails and the second is tried. */
  onFallback?: (error: AiProviderError) => void;
}

/** Tries `primary`, then `secondary` when the primary fails with a provider error. */
export class FallbackProvider implements AiProvider {
  readonly name: string;

  constructor(
    private readonly primary: AiProvider,
    private readonly secondary: AiProvider,
    private readonly options: FallbackOptions,
  ) {
    this.name = `${primary.name}+${secondary.name}`;
  }

  async generate(req: AiRequest): Promise<string> {
    try {
      return await this.primary.generate({
        ...req,
        timeoutMs: Math.min(req.timeoutMs, this.options.primaryTimeoutMs),
      });
    } catch (e) {
      if (!(e instanceof AiProviderError)) throw e;
      this.options.onFallback?.(e);
      return this.secondary.generate(req);
    }
  }
}
