/**
 * Test configuration builder.
 *
 * Deliberately does NOT read the developer's `.env`: tests must be hermetic and
 * must never touch a real database or a real bot token.
 */
import type { FastifyInstance } from 'fastify';

import { configSchema, type AppConfig } from '../../src/config/env.js';
import { createAppContext, type AppContext } from '../../src/context.js';
import { buildServer, type RuntimeStatus } from '../../src/http/server.js';
import { createLogger, type Logger } from '../../src/lib/logger.js';
import { advanceableClock, recordingNotifier, type AdvanceableClock, type Notifier } from '../../src/ports.js';
import type { AiProvider } from '../../src/ai/types.js';
import type { Transcriber } from '../../src/stt/types.js';
import type { Db } from '../../src/db/client.js';

export const TEST_PASSWORD = 'test-password-1234';
export const TEST_SESSION_SECRET = 'test-session-secret-that-is-long-enough';
export const TEST_TIME_ZONE = 'Africa/Lagos';

export type EnvOverrides = Record<string, string | undefined>;

export function testEnv(overrides: EnvOverrides = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'file:./unused.db',
    TELEGRAM_OWNER_IDS: '555000111',
    TELEGRAM_ENABLED: 'false',
    DASHBOARD_PASSWORD: TEST_PASSWORD,
    SESSION_SECRET: TEST_SESSION_SECRET,
    CORS_ORIGINS: 'http://localhost:5173',
    DEFAULT_TIME_ZONE: TEST_TIME_ZONE,
    DEFAULT_MORNING_TIME: '09:00',
    DEFAULT_EVENING_TIME: '19:00',
    AI_PROVIDER: 'none',
    // Tests inject fake AI providers (never a real service) and opt in to
    // sending text to them. Production defaults to false; the privacy tests
    // override this to prove both switches are enforced.
    AI_ALLOW_RAW_TEXT: 'true',
    STT_PROVIDER: 'none',
    LOG_MESSAGE_CONTENT: 'false',
  };
  return { ...base, ...overrides };
}

export function testConfig(overrides: EnvOverrides = {}): AppConfig {
  const env = testEnv(overrides);
  const parsed = configSchema.safeParse(envToInput(env));
  if (!parsed.success) {
    throw new Error(
      `Test config invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

/** Mirrors `envToConfigInput` but without xml-style nesting surprises. */
function envToInput(env: NodeJS.ProcessEnv) {
  const list = (value: string | undefined) =>
    (value ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    logMessageContent: env.LOG_MESSAGE_CONTENT,
    trustProxy: env.TRUST_PROXY,
    testRateLimitPerMinute: env.RECALL_TEST_RATE_LIMIT_PER_MINUTE,
    databaseUrl: env.DATABASE_URL,
    telegram: {
      enabled: env.TELEGRAM_ENABLED,
      botToken: env.TELEGRAM_BOT_TOKEN,
      mode: env.TELEGRAM_MODE,
      webhookUrl: env.TELEGRAM_WEBHOOK_URL,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      ownerIds: list(env.TELEGRAM_OWNER_IDS),
    },
    dashboard: {
      password: env.DASHBOARD_PASSWORD,
      sessionSecret: env.SESSION_SECRET,
      sessionTtlHours: env.SESSION_TTL_HOURS,
      corsOrigins: list(env.CORS_ORIGINS),
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
      maxAudioBytes: env.STT_MAX_AUDIO_BYTES,
      audioDir: env.STT_AUDIO_DIR,
    },
  };
}

export function testLogger(overrides: Record<string, unknown> = {}): Logger {
  return createLogger({ level: 'silent', sink: () => undefined, ...overrides });
}

export interface TestContextOptions {
  db: Db;
  overrides?: EnvOverrides;
  clock?: AdvanceableClock;
  ai?: AiProvider | null;
  stt?: Transcriber | null;
  notifier?: Notifier;
  config?: AppConfig;
}

export function createTestContext(options: TestContextOptions): {
  ctx: AppContext;
  clock: AdvanceableClock;
  notifier: Notifier & { sent: { text: string; chatId?: string }[] };
} {
  const clock = options.clock ?? advanceableClock('2026-10-17T10:00:00.000Z');
  const notifier = (options.notifier ?? recordingNotifier()) as Notifier & {
    sent: { text: string; chatId?: string }[];
  };
  const ctx = createAppContext({
    config: options.config ?? testConfig(options.overrides),
    db: options.db,
    clock,
    logger: testLogger(),
    ai: options.ai ?? null,
    stt: options.stt ?? null,
    notifier,
  });
  return { ctx, clock, notifier };
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  clock: AdvanceableClock;
  runtime: RuntimeStatus;
  login: () => Promise<string>;
  close: () => Promise<void>;
}

/** Boots the real Fastify app against a test database. */
export async function createTestApp(
  db: Db,
  options: { overrides?: EnvOverrides; clock?: AdvanceableClock; ai?: AiProvider | null } = {},
): Promise<TestApp> {
  const { ctx, clock } = createTestContext({ db, overrides: options.overrides, clock: options.clock, ai: options.ai });
  const runtime: RuntimeStatus = {
    version: 'test',
    startedAt: clock.now(),
    schedulerStatus: () => ({
      running: false,
      lastTickAt: null,
      dueNow: 0,
      scheduledTotal: 0,
      stalled: false,
      stallLimitSeconds: 0,
    }),
    telegramStatus: () => ({
      enabled: false,
      mode: 'polling',
      configured: false,
      ownerConfigured: true,
    }),
  };
  const app = await buildServer(ctx, { runtime, enableRateLimit: false });
  await app.ready();

  return {
    app,
    ctx,
    clock,
    runtime,
    async login() {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: TEST_PASSWORD },
      });
      if (response.statusCode !== 200) {
        throw new Error(`Login failed in test setup: ${response.statusCode} ${response.body}`);
      }
      const setCookie = response.headers['set-cookie'];
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (!raw) throw new Error('Login did not set a session cookie');
      return raw.split(';')[0]!;
    },
    async close() {
      await app.close();
    },
  };
}
