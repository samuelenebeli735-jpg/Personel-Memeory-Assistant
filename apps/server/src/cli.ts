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
 *   npm run recall -- backup --out backups --keep 14
 *   npm run recall -- verify-backup backups/recall-<timestamp>.db
 *   npm run recall -- serve
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type AppConfig } from './config/env.js';
import { ConfigError } from './config/env.js';
import { createAppContext, type AppContext } from './context.js';
import { applySqlitePragmas, createDb, pingDatabase } from './db/client.js';
import { start } from './index.js';
import { loggerFromConfig } from './lib/logger.js';
import { resolveAiProvider } from './ai/index.js';
import { resolveTranscriber } from './stt/index.js';
import { createBackup, DEFAULT_BACKUP_KEEP, verifyDatabaseBackup } from './services/backup-service.js';
import { ingestCapture, listInbox } from './services/capture-service.js';
import { getSettings } from './services/settings-service.js';
import { formatCaptureConfirmation, formatCaptureList } from './telegram/format.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Source and compiled layouts are both `<repo>/apps/server/{src,dist}`. */
const REPO_ROOT = path.resolve(here, '../../..');
const DEFAULT_BACKUP_DIR = path.join(REPO_ROOT, 'backups');

const USAGE = [
  'Recall command line',
  '',
  '  doctor                      check configuration and the database',
  '  capture <text>              store a capture and show the confirmation',
  '  inbox                       list captures that need review',
  '  backup [--out <dir>] [--keep <n>]',
  '                              consistent database snapshot + JSON export',
  '  verify-backup <file>        integrity, foreign-key, migration and row-count check',
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

function parseBackupOptions(args: string[]): { outDir: string; keep: number } {
  let outDir = DEFAULT_BACKUP_DIR;
  let keep = DEFAULT_BACKUP_KEEP;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === '--out') {
      if (!value) throw new Error('--out needs a directory');
      outDir = path.resolve(REPO_ROOT, value);
      index += 1;
      continue;
    }
    if (option === '--keep') {
      if (!value || !/^\d+$/.test(value)) throw new Error('--keep needs a whole number');
      keep = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown backup option: ${option ?? ''}`);
  }
  if (keep < 1) throw new Error('--keep must be at least 1');
  return { outDir, keep };
}

async function backup(config: AppConfig, args: string[]): Promise<number> {
  let options: { outDir: string; keep: number };
  try {
    options = parseBackupOptions(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }

  const { ctx, close } = await openContext(config);
  try {
    const result = await createBackup(ctx, options);
    const counts = result.verification.counts;
    process.stdout.write(
      [
        'Recall backup',
        '',
        `  database      ${result.databasePath}`,
        `  export        ${result.exportPath}`,
        `  integrity     ${result.verification.integrity}`,
        `  foreign keys  ${result.verification.foreignKeyViolations} violation(s)`,
        `  migrations    ${result.verification.appliedMigrations} applied, ${result.verification.unfinishedMigrations} unfinished`,
        `  rows          captures ${counts.captures}, tasks ${counts.tasks}, notes ${counts.notes}, ideas ${counts.ideas}, events ${counts.events}, projects ${counts.projects}, reminders ${counts.reminders}`,
        `  retention     keep ${options.keep}${result.pruned.length > 0 ? `, removed ${result.pruned.length} old file(s)` : ''}`,
      ].join('\n') + '\n',
    );
    return 0;
  } finally {
    await close();
  }
}

async function verifyBackup(filePath: string | undefined): Promise<number> {
  if (!filePath) {
    process.stderr.write(`Give the backup to verify: npm run recall -- verify-backup <file>\n`);
    return 2;
  }
  const verification = await verifyDatabaseBackup(path.resolve(REPO_ROOT, filePath));
  const counts = verification.counts;
  process.stdout.write(
    [
      'Recall backup verification',
      '',
      `  integrity     ${verification.integrity}`,
      `  foreign keys  ${verification.foreignKeyViolations} violation(s)`,
      `  migrations    ${verification.appliedMigrations} applied, ${verification.unfinishedMigrations} unfinished`,
      `  rows          captures ${counts.captures}, tasks ${counts.tasks}, notes ${counts.notes}, ideas ${counts.ideas}, events ${counts.events}, projects ${counts.projects}, reminders ${counts.reminders}`,
    ].join('\n') + '\n',
  );
  return verification.unfinishedMigrations === 0 ? 0 : 1;
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
    case 'backup':
      process.exitCode = await backup(config, rest);
      return;
    case 'verify-backup':
      process.exitCode = await verifyBackup(rest[0]);
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
