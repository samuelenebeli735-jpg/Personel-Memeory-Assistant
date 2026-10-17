/**
 * Process entry point.
 *
 * Boot order matters: configuration → database → context → adapters → HTTP →
 * scheduler → Telegram. Any failure before the HTTP listener exits the process
 * with a non-zero status so a supervisor restarts it; failures *after* the
 * listener is up (e.g. Telegram) degrade the service instead of killing it.
 */
import { resolveAiProvider } from './ai/index.js';
import { type AppConfig, loadConfig } from './config/env.js';
import { createAppContext, type AppContext } from './context.js';
import { applySqlitePragmas, createDb, pingDatabase } from './db/client.js';
import { ConfigError } from './config/env.js';
import { buildServer, type RuntimeStatus } from './http/server.js';
import { loggerFromConfig, type Logger } from './lib/logger.js';
import { resolveTranscriber } from './stt/index.js';

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

  const ctx = createAppContext({ config, logger, db, ai, stt });

  const runtime: RuntimeStatus = {
    version: config.version,
    startedAt,
    schedulerStatus: () => ({ running: false, lastTickAt: null, dueNow: 0, scheduledTotal: 0 }),
    telegramStatus: () => ({
      enabled: config.telegram.enabled,
      mode: config.telegram.mode,
      configured: ctx.capabilities.telegramConfigured,
      ownerConfigured: config.telegram.ownerIds.length > 0,
    }),
  };

  const app = await buildServer(ctx, { runtime });
  await app.listen({ host: config.host, port: config.port });
  logger.info('http listening', { url: `http://${config.host}:${config.port}` });

  let closed = false;
  return {
    ctx,
    async close() {
      if (closed) return;
      closed = true;
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
