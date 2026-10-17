/**
 * Prisma client access.
 *
 * A single client is created per process, but tests build isolated clients
 * against a throwaway SQLite file, so the factory is exported too.
 */
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

export type Db = PrismaClient;

export interface CreateDbOptions {
  /** Overrides DATABASE_URL. Relative `file:` paths resolve against `prismaDir`. */
  url?: string;
  /** Directory that relative `file:` URLs resolve against. */
  prismaDir?: string;
  logQueries?: boolean;
}

const DEFAULT_PRISMA_DIR = path.resolve(process.cwd(), 'prisma');

export function resolveDatabaseUrl(url: string, prismaDir: string): string {
  if (!url.startsWith('file:')) return url;
  const raw = url.slice('file:'.length);
  if (path.isAbsolute(raw)) return `file:${raw}`;
  return `file:${path.resolve(prismaDir, raw)}`;
}

export function createDb(options: CreateDbOptions = {}): Db {
  const url = options.url ?? process.env.DATABASE_URL ?? 'file:./dev.db';
  const prismaDir = options.prismaDir ?? DEFAULT_PRISMA_DIR;
  const client = new PrismaClient({
    datasources: { db: { url: resolveDatabaseUrl(url, prismaDir) } },
    log: options.logQueries ? [{ emit: 'stdout', level: 'query' }] : undefined,
  });
  return client as unknown as Db;
}

/** Verifies connectivity with a trivial query and reports latency. */
export async function pingDatabase(
  db: Db,
): Promise<{ connected: boolean; latencyMs: number | null; error?: string }> {
  const started = process.hrtime.bigint();
  try {
    await db.$queryRaw`SELECT 1`;
    const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    return { connected: true, latencyMs: Math.round(latencyMs * 100) / 100 };
  } catch (error) {
    return {
      connected: false,
      latencyMs: null,
      error: error instanceof Error ? error.message : 'unknown database error',
    };
  }
}

/**
 * Enables SQLite WAL + foreign keys + a busy timeout for concurrent access.
 * `$queryRawUnsafe` is used because PRAGMA statements return rows, which
 * `$executeRawUnsafe` rejects.
 */
export async function applySqlitePragmas(db: Db): Promise<void> {
  await db.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await db.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
  await db.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
  await db.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
}

export interface TransactionOptions {
  timeoutMs?: number;
  maxWaitMs?: number;
}

/** Wraps `db.$transaction` with explicit, bounded timeouts. */
export function withTransaction<T>(
  db: Db,
  fn: (tx: Db) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return db.$transaction(fn as never, {
    timeout: options.timeoutMs ?? 15_000,
    maxWait: options.maxWaitMs ?? 5_000,
  }) as Promise<T>;
}
