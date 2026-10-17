/**
 * Error taxonomy. Every failure surfaced to a user maps onto one of these so the
 * adapters can respond with a safe, non-leaking message.
 */

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;
  /** Safe to show the end user (never contains secrets). */
  readonly userMessage: string;

  constructor(
    code: string,
    userMessage: string,
    options: { httpStatus?: number; details?: unknown; cause?: unknown; internal?: string } = {},
  ) {
    super(options.internal ?? userMessage, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.httpStatus = options.httpStatus ?? 500;
    this.details = options.details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, { httpStatus: 400, details });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(what: string, id?: string) {
    super('NOT_FOUND', id ? `${what} not found: ${id}` : `${what} not found`, { httpStatus: 404 });
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Not authorized') {
    super('UNAUTHORIZED', message, { httpStatus: 401 });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not permitted') {
    super('FORBIDDEN', message, { httpStatus: 403 });
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, { httpStatus: 409 });
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super('RATE_LIMITED', message, { httpStatus: 429 });
    this.name = 'RateLimitError';
  }
}

/** A provider (AI, STT, Telegram) failed. Callers must not lose user data. */
export class ProviderError extends AppError {
  readonly provider: string;
  readonly retryable: boolean;

  constructor(
    provider: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown; details?: unknown } = {},
  ) {
    super('PROVIDER_ERROR', message, {
      httpStatus: 503,
      details: options.details,
      cause: options.cause,
      internal: `[${provider}] ${message}`,
    });
    this.name = 'ProviderError';
    this.provider = provider;
    this.retryable = options.retryable ?? true;
  }
}

/** Zod → ValidationError, keeping the field paths for the client. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError('INTERNAL_ERROR', 'Something went wrong on the server', {
      internal: error.message,
      cause: error,
    });
  }
  return new AppError('INTERNAL_ERROR', 'Something went wrong on the server');
}
