/**
 * Application context: the single dependency bag passed to services, routes,
 * the Telegram adapter and the scheduler. Constructing it explicitly (rather
 * than importing singletons) is what makes the integration tests possible.
 */
import { createAiStatus, withAiStatus, type AiStatus } from './ai/status.js';
import type { AiProvider } from './ai/types.js';
import { createRuleClassifier, type RuleClassifier } from './ai/rules-classifier.js';
import type { AppConfig, RuntimeCapabilities } from './config/env.js';
import { capabilitiesOf } from './config/env.js';
import { createDb, type Db } from './db/client.js';
import type { Logger } from './lib/logger.js';
import { loggerFromConfig } from './lib/logger.js';
import { nullNotifier, systemClock, type Clock, type Notifier } from './ports.js';
import { settingsDefaultsFromConfig, type SettingsDefaults } from './services/settings-service.js';
import type { Transcriber } from './stt/types.js';

export interface AppContext {
  readonly config: AppConfig;
  readonly capabilities: RuntimeCapabilities;
  readonly logger: Logger;
  readonly db: Db;
  readonly clock: Clock;
  readonly defaults: SettingsDefaults;
  /**
   * AI provider, or null when none is configured (rules-only mode). Wrapped so
   * every call updates `aiStatus`; use `aiForPersonalText` before sending it
   * the owner's text.
   */
  readonly ai: AiProvider | null;
  /** Last success / last failure of the AI provider, for the health report. */
  readonly aiStatus: AiStatus;
  /** Deterministic classifier, always available. */
  readonly rules: RuleClassifier;
  /** Speech-to-text, or null when unavailable. */
  readonly stt: Transcriber | null;
  /** Where proactive notifications are delivered. */
  readonly notifier: Notifier;
  /** Reminder delivery channel used by the scheduler ('telegram' | 'console' | 'none'). */
  readonly deliveryChannel: string;
}

export interface CreateContextOptions {
  config: AppConfig;
  logger?: Logger;
  db?: Db;
  clock?: Clock;
  ai?: AiProvider | null;
  stt?: Transcriber | null;
  notifier?: Notifier;
  deliveryChannel?: string;
}

export function createAppContext(options: CreateContextOptions): AppContext {
  const { config } = options;
  const logger = options.logger ?? loggerFromConfig(config);
  const notifier = options.notifier ?? nullNotifier();
  const clock = options.clock ?? systemClock;
  const aiStatus = createAiStatus();
  return {
    config,
    capabilities: capabilitiesOf(config),
    logger,
    db: options.db ?? createDb({ url: config.databaseUrl }),
    clock,
    defaults: settingsDefaultsFromConfig(config),
    ai: options.ai ? withAiStatus(options.ai, aiStatus, () => clock.now()) : null,
    aiStatus,
    rules: createRuleClassifier(),
    stt: options.stt ?? null,
    notifier,
    deliveryChannel: options.deliveryChannel ?? notifier.channel,
  };
}

export type { Db, Clock, Notifier };
