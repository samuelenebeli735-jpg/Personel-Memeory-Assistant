/**
 * Process entry point.
 *
 * Boot order matters: configuration → database → context → adapters → HTTP →
 * scheduler → Telegram. Any failure before the HTTP listener exits the process
 * with a non-zero status so a supervisor restarts it; failures *after* the
 * listener is up (e.g. Telegram) degrade the service instead of killing it.
 */
import { resolveAiProvider } from './ai/index.js';
import { type AppConfig, capabilitiesOf, loadConfig } from './config/env.js';
import { createAppContext, type AppContext } from './context.js';
import { applySqlitePragmas, createDb, pingDatabase } from './db/client.js';
import { ConfigError } from './config/env.js';
import { buildServer, type RuntimeStatus } from './http/server.js';
import { loggerFromConfig, type Logger } from './lib/logger.js';
import { createReminderScheduler, type ReminderScheduler } from './services/reminder-scheduler.js';
import { resolveTranscriber } from './stt/index.js';
import { TelegramClient } from './telegram/client.js';
import { createTelegramAdapter, type TelegramAdapter } from './telegram/handler.js';
import { createTelegramNotifier } from './telegram/notifier.js';
import { startTelegramPolling, type PollingController } from './telegram/polling.js';

export interface StartedApp {
  ctx: AppContext;
  close(): Promise<void>;
}

export async function start(config: AppConfig, logger: Logger): Promise<StartedApp> {
  const startedAt = new Date();

  logger.info('starting recall', {
    version: config.version,
    nodeEnv: config.nodeEnv,
    host: config.host,
    port: config.port,
    timeZone: config.locale.timeZone,
    aiProvider: config.ai.provider,
    sttProvider: config.stt.provider,
    telegramEnabled: config.telegram.enabled,
  });

  const db = createDb({ url: config.databaseUrl });
  const ping = await pingDatabase(db);
  if (!ping.connected) {
    throw new Error(
      `Database is not reachable (${config.databaseUrl.replace(/[^/\\]+$/, '<file>')}): ${ping.error}`,
    );
  }
  try {
    await applySqlitePragmas(db);
  } catch (error) {
    logger.warn('could not apply sqlite pragmas', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
  logger.info('database ready', { latencyMs: ping.latencyMs });

  const ai = resolveAiProvider(config, logger);
  const stt = resolveTranscriber(config, logger);
  if (!ai) logger.info('ai provider disabled - deterministic classification only');
  if (!stt) logger.info('speech-to-text disabled - voice capture will be stored untranscribed');

  const capabilities = capabilitiesOf(config);
  const telegramClient =
    config.telegram.enabled && capabilities.telegramConfigured
      ? new TelegramClient({
          token: config.telegram.botToken ?? '',
          onEvent: (event) => logger[event.level](event.msg, event.context),
        })
      : null;
  if (config.telegram.enabled && !telegramClient) {
    logger.warn('telegram is enabled but no usable bot token is configured - the adapter stays off');
  }

  // The notifier must exist before the context because the scheduler (Milestone 4)
  // reaches Telegram only through it.
  const notifier =
    telegramClient && config.telegram.ownerIds.length > 0
      ? createTelegramNotifier({
          client: telegramClient,
          ownerIds: config.telegram.ownerIds,
          logger,
        })
      : null;

  const ctx = createAppContext({
    config,
    logger,
    db,
    ai,
    stt,
    ...(notifier ? { notifier, deliveryChannel: notifier.channel } : {}),
  });

  const adapter: TelegramAdapter | null = telegramClient
    ? createTelegramAdapter(ctx, { client: telegramClient })
    : null;

  // The scheduler is database-backed: this object only owns the tick loop.
  const scheduler: ReminderScheduler = createReminderScheduler(ctx);

  const runtime: RuntimeStatus = {
    version: config.version,
    startedAt,
    schedulerStatus: () => scheduler.status(),
    telegramStatus: () => ({
      enabled: config.telegram.enabled,
      mode: config.telegram.mode,
      configured: ctx.capabilities.telegramConfigured,
      ownerConfigured: config.telegram.ownerIds.length > 0,
    }),
  };

  const app = await buildServer(ctx, {
    runtime,
    ...(adapter && config.telegram.mode === 'webhook'
      ? { telegramWebhook: (input) => adapter.handleWebhook(input) }
      : {}),
  });
  await app.listen({ host: config.host, port: config.port });
  logger.info('http listening', { url: `http://${config.host}:${config.port}` });

  let polling: PollingController | null = null;
  if (adapter) {
    if (config.telegram.mode === 'webhook') {
      const url = config.telegram.webhookUrl;
      if (url) {
        try {
          await adapter.client.setWebhook({
            url,
            ...(config.telegram.webhookSecret ? { secretToken: config.telegram.webhookSecret } : {}),
          });
          logger.info('telegram webhook registered', { url });
        } catch (error) {
          logger.error('could not register the telegram webhook', {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        logger.warn('TELEGRAM_MODE=webhook but TELEGRAM_WEBHOOK_URL is empty - not registered');
      }
    } else {
      polling = startTelegramPolling(ctx, adapter.client, adapter);
      logger.info('telegram polling started', {
        pollTimeoutSeconds: config.telegram.pollTimeoutSeconds,
      });
    }
  } else {
    logger.info('telegram adapter disabled');
  }

  // Recovery runs before the first tick: overdue reminders inside the grace
  // window fire once, older ones are marked missed instead of flooding.
  await scheduler.start();

  let closed = false;
  return {
    ctx,
    async close() {
      if (closed) return;
      closed = true;
      scheduler.stop();
      if (polling) {
        polling.stop();
        // A long poll can hold the request open; do not let shutdown hang on it.
        await Promise.race([
          polling.done,
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
      await app.close();
      await db.$disconnect();
    },
  };
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write(
        '\nFix the values in .env (see .env.example) and start again.\n',
      );
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw error;
  }

  const logger = loggerFromConfig(config);
  const app = await start(config, logger);

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly || process.env.RECALL_FORCE_MAIN === '1') {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Failed to start Recall: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
