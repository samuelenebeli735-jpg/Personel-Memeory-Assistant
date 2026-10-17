import type { Logger } from '../lib/logger.js';
import type { AppConfig } from '../config/env.js';
import { OpenAiTranscriber } from './openai-transcriber.js';
import type { Transcriber } from './types.js';

export function resolveTranscriber(config: AppConfig, _logger?: Logger): Transcriber | null {
  if (config.stt.provider === 'none' || !config.stt.apiKey) return null;
  return new OpenAiTranscriber({
    apiKey: config.stt.apiKey,
    model: config.stt.model,
    baseUrl: config.stt.baseUrl,
    timeoutMs: 60_000,
    maxRetries: 1,
  });
}

export { OpenAiTranscriber };
export * from './types.js';
