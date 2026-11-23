/**
 * Provider factories. Both return `null` when the feature is not configured,
 * which is the signal for callers to use their deterministic fallback rather
 * than failing.
 */
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../lib/logger.js';

import { AnthropicProvider, OpenAiCompatibleProvider, type ChatProviderOptions } from './chat-providers.js';
import type { AiProvider } from './types.js';

/** Each provider's own endpoint, used when AI_BASE_URL is empty. */
export const DEFAULT_AI_BASE_URLS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'https://api.openai.com/v1',
} as const;

/**
 * The endpoint a provider talks to. Empty means the provider's own default.
 *
 * Older `.env` templates set AI_BASE_URL to OpenAI's address for every
 * provider. Sent to Anthropic's SDK that would post Anthropic requests (and
 * the API key) to OpenAI, so an OpenAI address with the Anthropic provider is
 * ignored, as the previous code also did, and the operator is told once.
 */
export function resolveBaseUrl(config: AppConfig, logger?: Logger): string {
  const provider = config.ai.provider as keyof typeof DEFAULT_AI_BASE_URLS;
  const configured = config.ai.baseUrl;
  if (!configured) return DEFAULT_AI_BASE_URLS[provider];
  if (provider === 'anthropic' && /^https?:\/\/api\.openai\.com(\/|$)/i.test(configured)) {
    logger?.warn('AI_BASE_URL points at api.openai.com but AI_PROVIDER=anthropic; using https://api.anthropic.com. Clear AI_BASE_URL to silence this.');
    return DEFAULT_AI_BASE_URLS.anthropic;
  }
  return configured;
}

export function resolveAiProvider(config: AppConfig, logger: Logger): AiProvider | null {
  if (config.ai.provider === 'none') return null;
  if (!config.ai.apiKey) return null;
  // Configuration validation requires AI_MODEL with a provider; there is no
  // built-in default model that could be retired underneath the owner.
  if (!config.ai.model) return null;

  const options: ChatProviderOptions = {
    apiKey: config.ai.apiKey,
    model: config.ai.model,
    baseUrl: resolveBaseUrl(config, logger),
    timeoutMs: config.ai.timeoutMs,
    maxRetries: config.ai.maxRetries,
    allowRawText: config.ai.allowRawText,
    onEvent: (event) => logger[event.level](event.msg, event.context),
  };

  if (config.ai.provider === 'anthropic') {
    return new AnthropicProvider(options);
  }
  return new OpenAiCompatibleProvider(options, config.ai.provider === 'openai-compatible' ? 'openai-compatible' : 'openai');
}

export { AnthropicProvider, OpenAiCompatibleProvider };
export { extractJsonObject, parseClassification } from './chat-providers.js';
export * from './types.js';
