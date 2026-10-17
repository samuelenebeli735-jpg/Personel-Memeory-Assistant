/**
 * Environment loading + strict validation.
 *
 * Rules honoured here:
 *  - Credentials come only from the environment; nothing is hard-coded.
 *  - Placeholder values from `.env.example` are rejected when a feature is
 *    actually turned on, so a local config can never masquerade as production.
 *  - Validation errors never echo the secret value itself.
 */
import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * IANA zone check using the platform's own time-zone database. Avoids a regex
 * that happily accepts nonsense such as "Mars/Olympus".
 */
function isValidIanaZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const PLACEHOLDERS = new Set([
  '',
  'changeme',
  'change-me',
  'secret',
  'password',
  'your-token-here',
  '123456789',
  'placeholder',
]);

/**
 * Loads `.env` from the current working directory and up to four ancestor
 * directories (so both the repo root and the workspace folder work).
 * Existing `process.env` values always win.
 */
export function loadEnvFiles(startDir: string = process.cwd()): string[] {
  const loaded: string[] = [];
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate, override: false, quiet: true });
      loaded.push(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return loaded;
}

/* -------------------------------------------------------------------------- */
/* Coercion helpers (env values are always strings)                            */
/* -------------------------------------------------------------------------- */

function envBool(defaultValue: boolean) {
  return z.preprocess((raw) => {
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    if (typeof raw === 'boolean') return raw;
    const value = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return raw; // let zod report the invalid value
  }, z.boolean());
}

function envInt(defaultValue: number, opts: { min?: number; max?: number } = {}) {
  let schema = z.number().int();
  if (opts.min !== undefined) schema = schema.min(opts.min);
  if (opts.max !== undefined) schema = schema.max(opts.max);
  return z.preprocess((raw) => {
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    const num = Number(raw);
    return Number.isNaN(num) ? raw : num;
  }, schema);
}

function envStr(defaultValue = '') {
  return z.preprocess(
    (raw) => (raw === undefined || raw === null ? defaultValue : String(raw).trim()),
    z.string(),
  );
}

function envOptionalStr() {
  return z.preprocess((raw) => {
    if (raw === undefined || raw === null) return null;
    const value = String(raw).trim();
    return value === '' ? null : value;
  }, z.string().nullable());
}

/** A value that is required once its owning feature is enabled. */
const hhmmRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

function isPlaceholder(value: string | null): boolean {
  if (value === null) return true;
  const normalised = value.trim().toLowerCase();
  if (PLACEHOLDERS.has(normalised)) return true;
  // Long runs of the same character are obviously fake too ("aaaa....").
  return /^(.)\1{7,}$/.test(normalised);
}

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

export const configSchema = z
  .object({
    nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
    host: envStr('127.0.0.1'),
    // 0 lets the operating system pick a free port (used by tests).
    port: envInt(4000, { min: 0, max: 65535 }),
    logLevel: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** When false (default) capture text / transcripts never reach the logs. */
    logMessageContent: envBool(false),

    databaseUrl: envStr('file:./dev.db'),

    telegram: z.object({
      enabled: envBool(false),
      botToken: envOptionalStr(),
      mode: z.enum(['polling', 'webhook']).default('polling'),
      webhookUrl: envOptionalStr(),
      webhookSecret: envOptionalStr(),
      ownerIds: z.array(z.string().min(1)).default([]),
      pollTimeoutSeconds: envInt(30, { min: 1, max: 50 }),
    }),

    dashboard: z.object({
      password: envOptionalStr(),
      sessionSecret: envOptionalStr(),
      sessionTtlHours: envInt(168, { min: 1, max: 24 * 365 }),
      corsOrigins: z.array(z.string()).default([]),
      cookieSecure: envBool(false),
    }),

    locale: z.object({
      timeZone: envStr('Africa/Lagos'),
      morningDefaultTime: envStr('09:00'),
      eveningDefaultTime: envStr('19:00'),
      quietHoursStart: envOptionalStr(),
      quietHoursEnd: envOptionalStr(),
      maxNotificationsPerDay: envInt(0, { min: 0, max: 200 }),
      reminderOverdueGraceHours: envInt(12, { min: 1, max: 168 }),
      reminderMaxAttempts: envInt(5, { min: 1, max: 20 }),
      reminderRetryBaseSeconds: envInt(30, { min: 5, max: 3600 }),
      schedulerIntervalSeconds: envInt(20, { min: 5, max: 3600 }),
      briefingEnabled: envBool(false),
      briefingTime: envStr('07:30'),
    }),

    ai: z.object({
      provider: z.enum(['none', 'openai', 'openai-compatible', 'anthropic']).default('none'),
      apiKey: envOptionalStr(),
      baseUrl: envStr('https://api.openai.com/v1'),
      model: envOptionalStr(),
      timeoutMs: envInt(15000, { min: 1000, max: 120000 }),
      maxRetries: envInt(2, { min: 0, max: 5 }),
      allowRawText: envBool(true),
    }),

    stt: z.object({
      provider: z.enum(['none', 'openai']).default('none'),
      apiKey: envOptionalStr(),
      baseUrl: envStr('https://api.openai.com/v1'),
      model: envStr('whisper-1'),
      retainAudio: envBool(false),
      maxAudioSeconds: envInt(180, { min: 5, max: 3600 }),
    }),

    version: envStr('0.1.0'),
  })
  .superRefine((value, ctx) => {
    if (value.nodeEnv === 'production') {
      if (!value.dashboard.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dashboard', 'password'],
          message: 'DASHBOARD_PASSWORD is required in production',
        });
      }
      if (!value.dashboard.sessionSecret || value.dashboard.sessionSecret.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dashboard', 'sessionSecret'],
          message: 'SESSION_SECRET must be at least 32 characters in production',
        });
      }
      if (value.telegram.enabled && value.telegram.mode === 'webhook') {
        if (!value.telegram.webhookUrl?.startsWith('https://')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['telegram', 'webhookUrl'],
            message: 'TELEGRAM_WEBHOOK_URL must be an https URL in production',
          });
        }
        if (isPlaceholder(value.telegram.webhookSecret)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['telegram', 'webhookSecret'],
            message: 'TELEGRAM_WEBHOOK_SECRET is required for webhook mode',
          });
        }
      }
      if (!value.dashboard.cookieSecure) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dashboard', 'cookieSecure'],
          message: 'COOKIE_SECURE must be true in production (HTTPS required)',
        });
      }
    }
    if (value.telegram.enabled) {
      if (isPlaceholder(value.telegram.botToken)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['telegram', 'botToken'],
          message: 'TELEGRAM_BOT_TOKEN is required when TELEGRAM_ENABLED=true',
        });
      }
      if (value.telegram.ownerIds.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['telegram', 'ownerIds'],
          message: 'TELEGRAM_OWNER_IDS is required when TELEGRAM_ENABLED=true',
        });
      }
    }
    for (const key of ['morningDefaultTime', 'eveningDefaultTime', 'briefingTime'] as const) {
      if (!hhmmRegex.test(value.locale[key])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['locale', key],
          message: `Expected HH:MM (24h), received ${JSON.stringify(value.locale[key]).slice(0, 12)}`,
        });
      }
    }
    for (const key of ['quietHoursStart', 'quietHoursEnd'] as const) {
      const v = value.locale[key];
      if (v !== null && !hhmmRegex.test(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['locale', key],
          message: `Expected HH:MM (24h) or empty`,
        });
      }
    }
    if ((value.locale.quietHoursStart === null) !== (value.locale.quietHoursEnd === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locale', 'quietHoursStart'],
        message: 'QUIET_HOURS_START and QUIET_HOURS_END must be set together',
      });
    }
    if (value.ai.provider !== 'none' && isPlaceholder(value.ai.apiKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ai', 'apiKey'],
        message: 'AI_API_KEY is required when AI_PROVIDER is not "none"',
      });
    }
    if (value.stt.provider !== 'none' && isPlaceholder(value.stt.apiKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stt', 'apiKey'],
        message: 'STT_API_KEY is required when STT_PROVIDER is not "none"',
      });
    }
    if (!isValidIanaZone(value.locale.timeZone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locale', 'timeZone'],
        message: 'DEFAULT_TIME_ZONE must be an IANA zone such as Africa/Lagos',
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

/** Convenience flags derived from the validated configuration. */
export interface RuntimeCapabilities {
  readonly aiEnabled: boolean;
  readonly sttEnabled: boolean;
  readonly telegramEnabled: boolean;
  readonly telegramConfigured: boolean;
  readonly dashboardAuthConfigured: boolean;
}

export function capabilitiesOf(config: AppConfig): RuntimeCapabilities {
  const telegramConfigured = !isPlaceholder(config.telegram.botToken);
  return {
    aiEnabled: config.ai.provider !== 'none' && !isPlaceholder(config.ai.apiKey),
    sttEnabled: config.stt.provider !== 'none' && !isPlaceholder(config.stt.apiKey),
    telegramEnabled: config.telegram.enabled,
    telegramConfigured,
    dashboardAuthConfigured:
      !isPlaceholder(config.dashboard.password) && !isPlaceholder(config.dashboard.sessionSecret),
  };
}

/**
 * Reads the raw environment into the schema's input shape.
 * Kept separate so tests can build config from a plain object.
 */
export function envToConfigInput(env: NodeJS.ProcessEnv = process.env) {
  const ownerIds = (env.TELEGRAM_OWNER_IDS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    logMessageContent: env.LOG_MESSAGE_CONTENT,
    databaseUrl: env.DATABASE_URL,
    telegram: {
      enabled: env.TELEGRAM_ENABLED,
      botToken: env.TELEGRAM_BOT_TOKEN,
      mode: env.TELEGRAM_MODE,
      webhookUrl: env.TELEGRAM_WEBHOOK_URL,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      ownerIds,
    },
    dashboard: {
      password: env.DASHBOARD_PASSWORD,
      sessionSecret: env.SESSION_SECRET,
      sessionTtlHours: env.SESSION_TTL_HOURS,
      corsOrigins,
      cookieSecure: env.COOKIE_SECURE,
    },
    locale: {
      timeZone: env.DEFAULT_TIME_ZONE,
      morningDefaultTime: env.DEFAULT_MORNING_TIME,
      eveningDefaultTime: env.DEFAULT_EVENING_TIME,
      quietHoursStart: env.QUIET_HOURS_START,
      quietHoursEnd: env.QUIET_HOURS_END,
      maxNotificationsPerDay: env.MAX_NOTIFICATIONS_PER_DAY,
      reminderOverdueGraceHours: env.REMINDER_OVERDUE_GRACE_HOURS,
      reminderMaxAttempts: env.REMINDER_MAX_ATTEMPTS,
      reminderRetryBaseSeconds: env.REMINDER_RETRY_BASE_SECONDS,
      schedulerIntervalSeconds: env.SCHEDULER_INTERVAL_SECONDS,
      briefingEnabled: env.BRIEFING_ENABLED,
      briefingTime: env.BRIEFING_TIME,
    },
    ai: {
      provider: env.AI_PROVIDER,
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL,
      model: env.AI_MODEL,
      timeoutMs: env.AI_TIMEOUT_MS,
      maxRetries: env.AI_MAX_RETRIES,
      allowRawText: env.AI_ALLOW_RAW_TEXT,
    },
    stt: {
      provider: env.STT_PROVIDER,
      apiKey: env.STT_API_KEY,
      baseUrl: env.STT_BASE_URL,
      model: env.STT_MODEL,
      retainAudio: env.STT_RETAIN_AUDIO,
      maxAudioSeconds: env.STT_MAX_AUDIO_SECONDS,
    },
  };
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Also read `.env` files from disk. Disabled in unit tests. */
  loadFiles?: boolean;
  cwd?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  if (options.loadFiles !== false) {
    loadEnvFiles(options.cwd ?? process.cwd());
  }
  const env = options.env ?? process.env;
  const parsed = configSchema.safeParse(envToConfigInput(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const where = issue.path.join('.');
      return where ? `${where}: ${issue.message}` : issue.message;
    });
    throw new ConfigError(issues);
  }
  return parsed.data;
}

/** Absolute path of the SQLite file, or null for non-file databases. */
export function sqliteFilePath(databaseUrl: string, schemaDir: string): string | null {
  if (!databaseUrl.startsWith('file:')) return null;
  const raw = databaseUrl.slice('file:'.length);
  return path.isAbsolute(raw) ? raw : path.resolve(schemaDir, raw);
}
