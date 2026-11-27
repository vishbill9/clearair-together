import type { Config } from '../config.js';
import { PLANT_RESPONSE_SCHEMA } from '../plants/chat.js';
import { AnthropicProvider } from './anthropic.js';
import { FallbackProvider } from './fallback.js';
import { GeminiTextProvider } from './gemini-text.js';
import { OllamaProvider } from './ollama.js';
import type { AiProvider, AiProviderError } from './provider.js';

/** Gemini gets this long before the plant chat falls back to the assistant model. */
const PLANT_PRIMARY_TIMEOUT_MS = 12_000;

/** The model behind the assistant, as chosen by `config.aiProvider`; null when none is configured. */
export function assistantProvider(config: Config): AiProvider | null {
  const { ollama } = config;
  if (config.aiProvider === 'ollama' && ollama.apiKey) {
    return new OllamaProvider({ apiKey: ollama.apiKey, model: ollama.model, baseUrl: ollama.baseUrl });
  }
  if (config.aiProvider === 'anthropic' && config.anthropicApiKey) {
    return new AnthropicProvider({ apiKey: config.anthropicApiKey, model: config.aiModel });
  }
  return null;
}

/** Gemini answers plant questions; when it fails or is slow, the assistant model (if any) answers instead. */
export function plantChatProvider(
  config: Config,
  assistant: AiProvider | null,
  onFallback: (e: AiProviderError) => void,
): AiProvider | null {
  const { geminiApiKey, chatModel } = config.live;
  if (!geminiApiKey || !chatModel) return null;
  const gemini = new GeminiTextProvider({
    apiKey: geminiApiKey,
    model: chatModel,
    responseSchema: PLANT_RESPONSE_SCHEMA,
  });
  if (!assistant) return gemini;
  return new FallbackProvider(gemini, assistant, { primaryTimeoutMs: PLANT_PRIMARY_TIMEOUT_MS, onFallback });
}
