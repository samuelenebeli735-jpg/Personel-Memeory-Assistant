/**
 * Structured logging.
 *
 * Privacy rule: capture text, transcripts, tokens and passwords must never be
 * written to the log by default. `logMessageContent` opts in explicitly and is
 * intended for local development only.
 */
import type { AppConfig } from '../config/env.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
  silent: 100,
};

/** Keys whose values are replaced with a redaction marker. */
const REDACT_KEYS = new Set([
  'password',
  'token',
  'botToken',
  'apiKey',
  'secret',
  'sessionSecret',
  'authorization',
  'cookie',
  'rawText',
  'transcript',
  'body',
  'text',
]);

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  level: LogLevel;
  fatal(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  trace(msg: string, ctx?: LogContext): void;
  child(bindings: LogContext): Logger;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** When false, known content-bearing fields are redacted. */
  logMessageContent?: boolean;
  /** Sink for tests. Defaults to stdout/stderr via console. */
  sink?: (line: string, level: LogLevel) => void;
  bindings?: LogContext;
}

function redactValue(value: unknown, allowContent: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return allowContent ? value : '[redacted]';
  }
  return allowContent ? value : '[redacted]';
}

function serialise(key: string, value: unknown, allowContent: boolean): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (REDACT_KEYS.has(key) && !allowContent) {
    return redactValue(value, false);
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return redactObject(value as Record<string, unknown>, allowContent);
  }
  if (Array.isArray(value)) {
    return value.map((item) => serialise('', item, allowContent));
  }
  return value;
}

function redactObject(input: Record<string, unknown>, allowContent: boolean): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = serialise(key, value, allowContent);
  }
  return output;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const allowContent = options.logMessageContent ?? false;
  const bindings = options.bindings ?? {};
  const sink =
    options.sink ??
    ((line: string, lvl: LogLevel) => {
      if (lvl === 'error' || lvl === 'fatal') process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });

  const threshold = LEVEL_ORDER[level];

  const emit = (lvl: LogLevel, msg: string, ctx?: LogContext) => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const payload: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: lvl,
      msg,
      ...redactObject(bindings, allowContent),
    };
    if (ctx) Object.assign(payload, redactObject(ctx, allowContent));
    sink(JSON.stringify(payload), lvl);
  };

  return {
    level,
    fatal: (m, c) => emit('fatal', m, c),
    error: (m, c) => emit('error', m, c),
    warn: (m, c) => emit('warn', m, c),
    info: (m, c) => emit('info', m, c),
    debug: (m, c) => emit('debug', m, c),
    trace: (m, c) => emit('trace', m, c),
    child: (extra) =>
      createLogger({ ...options, level, logMessageContent: allowContent, bindings: { ...bindings, ...extra } }),
  };
}

export function loggerFromConfig(config: AppConfig, overrides: CreateLoggerOptions = {}): Logger {
  return createLogger({
    level: config.logLevel,
    logMessageContent: config.logMessageContent,
    ...overrides,
  });
}

export const silentLogger: Logger = createLogger({
  level: 'silent',
  sink: () => undefined,
});
