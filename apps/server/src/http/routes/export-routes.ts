/**
 * Export and restore API.
 *
 * `GET /export` streams the whole database as one JSON bundle.
 *
 * `POST /restore` takes `{ bundle, dryRun, maxRowsPerTable }` as JSON under the
 * server-wide 2 MB body limit. It is **dry-run by default**: without
 * `{"dryRun": false}` it reports what it would insert and writes nothing.
 *
 * `POST /restore/file` is what the dashboard uses (R2-06). The request body is
 * the export file's exact bytes, up to 25 MB on this route only (decision D5):
 *
 * 1. The session is checked in `onRequest`, before any of the body is read.
 * 2. The server computes SHA-256 over exactly the bytes it received and
 *    refuses with 409 unless it equals `?sha256=` (the browser's own hash).
 * 3. It decodes the bytes as strict UTF-8, parses JSON and validates the
 *    bundle, then runs the restore on that same parsed value.
 * 4. A dry run returns a `checkToken`: an HMAC of the hash, keyed with the
 *    session secret. Applying (`dryRun=false`) requires that token, recomputed
 *    from the bytes received now. So the server itself proves the file it
 *    applies is byte-for-byte the file it checked, without storing anything.
 *
 * Restore is additive (see `services/export-service.ts`): it never overwrites or
 * deletes, so an accidental call on a live database cannot destroy data, and
 * running the same file twice adds nothing the second time.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExportBundleDto, RestoreFileReportDto, RestoreReportDto } from '@recall/shared';

import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { parseBody } from '../validation.js';
import { createSessionGuard } from '../session-guard.js';
import { exportAll, restoreBundle } from '../../services/export-service.js';

/** Largest export file `POST /restore/file` accepts (decision D5). */
export const RESTORE_FILE_LIMIT_BYTES = 25 * 1024 * 1024;

const restoreBodySchema = z.object({
  bundle: z.unknown(),
  dryRun: z.boolean().default(true),
  maxRowsPerTable: z.number().int().min(1).max(100_000).optional(),
});

const SHA256_HEX = /^[0-9a-f]{64}$/;

const restoreFileQuerySchema = z.object({
  dryRun: z.enum(['true', 'false']).default('true'),
  sha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SHA256_HEX, "Send the file's SHA-256 as 64 hex characters"),
  checkToken: z.string().trim().regex(SHA256_HEX).optional(),
  maxRowsPerTable: z.coerce.number().int().min(1).max(100_000).optional(),
});

/** Binds a dry run's result to the exact bytes it checked. */
export function restoreCheckToken(secret: string, sha256: string): string {
  return createHmac('sha256', secret).update(`recall-restore-check:v1:${sha256}`).digest('hex');
}

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(given, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function fileMismatch(message: string, receivedSha256: string): AppError {
  return new AppError('RESTORE_FILE_MISMATCH', message, {
    httpStatus: 409,
    details: { receivedSha256 },
  });
}

function parseExportFile(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'This file is not UTF-8 text, so it is not a Recall export.', {
      httpStatus: 400,
    });
  }
  // A byte-order mark is part of the hashed bytes but not of the JSON.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('VALIDATION_ERROR', 'This file isn\u2019t valid JSON, so it is not a Recall export.', {
      httpStatus: 400,
    });
  }
}

export async function registerExportRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/export', async (): Promise<ExportBundleDto> => exportAll(ctx));

  app.post('/restore', async (request): Promise<RestoreReportDto> => {
    const body = parseBody(restoreBodySchema, request.body, 'Invalid restore request');
    const { report } = await restoreBundle(ctx.db, body.bundle, {
      dryRun: body.dryRun,
      ...(body.maxRowsPerTable === undefined ? {} : { maxRowsPerTable: body.maxRowsPerTable }),
    });
    return report;
  });

  // An encapsulated scope so the raw-bytes parser and the 25 MB limit apply
  // to this one route; every other route keeps JSON parsing and the 2 MB limit.
  await app.register(async (scope) => {
    scope.addHook('onRequest', createSessionGuard(ctx));
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: RESTORE_FILE_LIMIT_BYTES },
      (_request, body, done) => done(null, body),
    );

    scope.post(
      '/restore/file',
      { bodyLimit: RESTORE_FILE_LIMIT_BYTES },
      async (request): Promise<RestoreFileReportDto> => {
        const parsedQuery = restoreFileQuerySchema.safeParse(request.query ?? {});
        if (!parsedQuery.success) {
          throw new AppError('VALIDATION_ERROR', 'Invalid restore request', {
            httpStatus: 400,
            details: parsedQuery.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          });
        }
        const query = parsedQuery.data;
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          throw new AppError('VALIDATION_ERROR', 'Send the export file as the request body.', {
            httpStatus: 400,
          });
        }

        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== query.sha256) {
          throw fileMismatch(
            'The file Recall received is not the file you chose. Choose it again and check it.',
            sha256,
          );
        }

        const dryRun = query.dryRun === 'true';
        const secret = ctx.config.dashboard.sessionSecret;
        if (!secret) {
          throw new AppError('UNAUTHORIZED', 'Dashboard authentication is not configured', {
            httpStatus: 503,
          });
        }
        const expectedToken = restoreCheckToken(secret, sha256);
        if (!dryRun && (query.checkToken === undefined || !tokensMatch(expectedToken, query.checkToken))) {
          throw fileMismatch(
            'This file has not been checked, or it changed since it was checked. Check it again before restoring.',
            sha256,
          );
        }

        const parsed = parseExportFile(bytes);
        const { report } = await restoreBundle(ctx.db, parsed, {
          dryRun,
          ...(query.maxRowsPerTable === undefined ? {} : { maxRowsPerTable: query.maxRowsPerTable }),
        });
        // restoreBundle validated the shape, so these fields exist.
        const bundle = parsed as { schemaVersion: number; exportedAt: string };
        return {
          ...report,
          file: {
            sha256,
            bytes: bytes.length,
            schemaVersion: bundle.schemaVersion,
            exportedAt: bundle.exportedAt,
            checkToken: dryRun ? expectedToken : null,
          },
        };
      },
    );
  });
}
