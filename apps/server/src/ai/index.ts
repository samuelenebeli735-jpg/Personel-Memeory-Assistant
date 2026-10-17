/**
 * Provider factories. Both return `null` when the feature is not configured,
 * which is the signal for callers to use their deterministic fallback rather
 * than failing.
 */
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../lib/logger.js';

import { AnthropicProvider, OpenAiCompatibleProvider, type ChatProviderOptions } from './chat-providers.js';
import type { AiProvider } from './types.js';

export function resolveAiProvider(config: AppConfig, logger: Logger): AiProvider | null {
  if (config.ai.provider === 'none') return null;
  if (!config.ai.apiKey) return null;

  const defaultModel =
    config.ai.provider === 'anthropic' ? 'claude-3-5-haiku-latest' : 'gpt-4o-mini';
  const model = config.ai.model ?? defaultModel;

  const options: ChatProviderOptions = {
    apiKey: config.ai.apiKey,
    model,
    baseUrl:
      config.ai.provider === 'anthropic' && config.ai.baseUrl.includes('api.openai.com')
        ? 'https://api.anthropic.com'
        : config.ai.baseUrl,
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
