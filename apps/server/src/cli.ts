/**
 * Local command line.
 *
 * Deliberately small: it exists so the owner can capture and inspect without
 * Telegram or the dashboard, and so a misconfiguration can be diagnosed without
 * starting the whole service. It shares the exact service layer as every other
 * entry point — there is no second implementation of capture here.
 *
 * Usage:
 *   npm run recall -- doctor
 *   npm run recall -- capture "buy milk tomorrow"
 *   npm run recall -- inbox
 *   npm run recall -- serve
 */
import { loadConfig, type AppConfig } from './config/env.js';
import { ConfigError } from './config/env.js';
import { createAppContext, type AppContext } from './context.js';
import { applySqlitePragmas, createDb, pingDatabase } from './db/client.js';
import { start } from './index.js';
import { loggerFromConfig } from './lib/logger.js';
import { resolveAiProvider } from './ai/index.js';
import { resolveTranscriber } from './stt/index.js';
import { ingestCapture, listInbox } from './services/capture-service.js';
import { getSettings } from './services/settings-service.js';
import { formatCaptureConfirmation, formatCaptureList } from './telegram/format.js';

const USAGE = [
  'Recall command line',
  '',
  '  doctor                      check configuration and the database',
  '  capture <text>              store a capture and show the confirmation',
  '  inbox                       list captures that need review',
  '  serve                       start the HTTP server and any adapters',
].join('\n');

/** Builds a context for a one-shot command (no HTTP, no adapters). */
async function openContext(config: AppConfig): Promise<{ ctx: AppContext; close: () => Promise<void> }> {
  const logger = loggerFromConfig(config);
  const db = createDb({ url: config.databaseUrl });
  const ping = await pingDatabase(db);
  if (!ping.connected) {
    throw new Error(`database is not reachable (${config.databaseUrl}): ${ping.error}`);
  }
  await applySqlitePragmas(db);
  const ctx = createAppContext({
    config,
    logger,
    db,
    ai: resolveAiProvider(config, logger),
    stt: resolveTranscriber(config, logger),
  });
  return { ctx, close: async () => db.$disconnect() };
}

async function doctor(config: AppConfig): Promise<number> {
  const { ctx, close } = await openContext(config);
  try {
    const settings = await getSettings(ctx.db, ctx.defaults);
    const [captures, tasks, reminders] = await Promise.all([
      ctx.db.capture.count(),
      ctx.db.task.count(),
      ctx.db.reminder.count(),
    ]);
    process.stdout.write(
      [
        'Recall doctor',
        '',
        `  node env            ${config.nodeEnv}`,
        `  database            ${config.databaseUrl.replace(/[^/\\]+$/, '<file>')} (ok)`,
        `  time zone           ${settings.timeZone}`,
        `  telegram            ${config.telegram.enabled ? `${config.telegram.mode} mode` : 'disabled'}`,
        `  telegram token      ${ctx.capabilities.telegramConfigured ? 'configured' : 'not configured'}`,
        `  owners configured   ${config.telegram.ownerIds.length > 0 ? 'yes' : 'no'}`,
        `  ai provider         ${config.ai.provider}${ctx.ai ? '' : ' (no key, rules only)'}`,
        `  speech-to-text      ${config.stt.provider}${ctx.stt ? '' : ' (not configured)'}`,
        `  dashboard auth      ${ctx.capabilities.dashboardAuthConfigured ? 'configured' : 'not configured'}`,
        `  stored: captures ${captures}, tasks ${tasks}, reminders ${reminders}`,
      ].join('\n') + '\n',
    );
    return 0;
  } finally {
    await close();
  }
}

async function capture(config: AppConfig, text: string): Promise<number> {
  const { ctx, close } = await openContext(config);
  try {
    const settings = await getSettings(ctx.db, ctx.defaults);
    const outcome = await ingestCapture(ctx, { rawText: text, source: 'CLI', sourceRef: 'cli' });
    process.stdout.write(
      `${formatCaptureConfirmation(outcome, {
        timeZone: settings.timeZone,
        referenceNow: ctx.clock.now(),
      })}\n`,
    );
    process.stdout.write(`\ncapture id: ${outcome.capture.id}\n`);
    return 0;
  } finally {
    await close();
  }
}

async function inbox(config: AppConfig): Promise<number> {
  const { ctx, close } = await openContext(config);
  try {
    const settings = await getSettings(ctx.db, ctx.defaults);
    const captures = await listInbox(ctx.db, 25);
    process.stdout.write(
      `${formatCaptureList(captures, settings.timeZone, 'Inbox — waiting for review')}\n`,
    );
    return 0;
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  const [command = 'serve', ...rest] = process.argv.slice(2);

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 78;
      return;
    }
    throw error;
  }

  switch (command) {
    case 'doctor':
      process.exitCode = await doctor(config);
      return;
    case 'capture': {
      const text = rest.join(' ').trim();
      if (text.length === 0) {
        process.stderr.write('Give me something to capture: npm run recall -- capture "…"\n');
        process.exitCode = 2;
        return;
      }
      process.exitCode = await capture(config, text);
      return;
    }
    case 'inbox':
      process.exitCode = await inbox(config);
      return;
    case 'serve': {
      const logger = loggerFromConfig(config);
      const app = await start(config, logger);
      const shutdown = async () => {
        await app.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${USAGE}\n`);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Recall command failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
