/**
 * Request-parsing helpers shared by the route modules.
 *
 * Every route validates its own input with Zod and turns a failure into a
 * `VALIDATION_ERROR` with field-level details. Keeping that in one place means
 * an invalid request always produces the same error shape, whichever resource it
 * was aimed at.
 */
import { z } from 'zod';

import { AppError } from '../lib/errors.js';

export function validationError(error: z.ZodError, message = 'Invalid request'): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    httpStatus: 400,
    details: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
  message?: string,
): z.output<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw validationError(parsed.error, message);
  return parsed.data as z.output<S>;
}

export function parseQuery<S extends z.ZodTypeAny>(
  schema: S,
  query: unknown,
  message?: string,
): z.output<S> {
  const parsed = schema.safeParse(query ?? {});
  if (!parsed.success) throw validationError(parsed.error, message);
  return parsed.data as z.output<S>;
}

const idParamsSchema = z.object({ id: z.string().min(1).max(64) });

export function parseIdParam(params: unknown): string {
  const parsed = idParamsSchema.safeParse(params);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data.id;
}

/** Accepts `?x=A,B`, repeated `?x=A&x=B`, or nothing. */
export function csvParam(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((part) => String(part).split(','))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? undefined : parts;
}

/** Validates a `?x=A,B` value against a known set. */
export function enumListParam<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T[] | undefined {
  const parts = csvParam(value);
  if (!parts) return undefined;
  for (const part of parts) {
    if (!allowed.includes(part as T)) {
      throw new AppError('VALIDATION_ERROR', `Unknown ${label}: ${part}`, { httpStatus: 400 });
    }
  }
  return parts as T[];
}

export function dateParam(value: unknown, label: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('VALIDATION_ERROR', `${label} is not a valid date: ${String(value)}`, {
      httpStatus: 400,
    });
  }
  return parsed;
}
