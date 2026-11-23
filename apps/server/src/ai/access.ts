/**
 * The one rule that decides whether the owner's personal text may go to the
 * AI provider. Classification and Ask both call it, so they can never disagree.
 *
 * A provider is used only when ALL of these hold:
 *  - a provider is configured (`ctx.ai`);
 *  - the owner's Settings switch `aiEnabled` is on;
 *  - the server allows personal text to leave (`AI_ALLOW_RAW_TEXT=true`,
 *    off by default).
 *
 * Either switch alone keeps every word on this machine. When the answer is
 * "no", callers use their deterministic behaviour quietly: this is a policy,
 * not a failure, so it is not logged per call.
 */
import type { AppConfig } from '../config/env.js';
import type { AiProvider } from './types.js';

export type AiBlockReason = 'not_configured' | 'disabled_in_settings' | 'raw_text_not_allowed';

export type AiAccess = { provider: AiProvider; reason: null } | { provider: null; reason: AiBlockReason };

export function aiForPersonalText(
  ctx: { ai: AiProvider | null; config: Pick<AppConfig, 'ai'> },
  settings: { aiEnabled: boolean },
): AiAccess {
  if (!ctx.ai) return { provider: null, reason: 'not_configured' };
  if (!settings.aiEnabled) return { provider: null, reason: 'disabled_in_settings' };
  if (!ctx.config.ai.allowRawText) return { provider: null, reason: 'raw_text_not_allowed' };
  return { provider: ctx.ai, reason: null };
}
