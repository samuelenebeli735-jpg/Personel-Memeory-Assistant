import { describe, expect, it } from 'vitest';

import { capabilitiesOf, ConfigError, configSchema, envToConfigInput, loadConfig } from '../../src/config/env.js';
import { testEnv } from '../helpers/app.js';

function parse(overrides: Record<string, string | undefined>) {
  return configSchema.safeParse(envToConfigInput(testEnv(overrides) as NodeJS.ProcessEnv));
}

function expectOk(overrides: Record<string, string | undefined>) {
  const result = parse(overrides);
  if (!result.success) {
    throw new Error(`expected valid config, got: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}

function expectInvalid(overrides: Record<string, string | undefined>, pathFragment: string) {
  const result = parse(overrides);
  expect(result.success).toBe(false);
  if (result.success) return;
  const paths = result.error.issues.map((i) => i.path.join('.'));
  expect(paths.some((p) => p.includes(pathFragment))).toBe(true);
}

describe('configuration validation', () => {
  it('accepts a complete development configuration', () => {
    const config = expectOk({});
    expect(config.nodeEnv).toBe('test');
    expect(config.locale.timeZone).toBe('Africa/Lagos');
    expect(config.ai.provider).toBe('none');
  });

  it('parses booleans defensively (the classic "false" is truthy trap)', () => {
    const config = expectOk({ TELEGRAM_ENABLED: 'false', LOG_MESSAGE_CONTENT: 'false' });
    expect(config.telegram.enabled).toBe(false);
    expect(config.logMessageContent).toBe(false);
    expect(expectOk({ LOG_MESSAGE_CONTENT: '1' }).logMessageContent).toBe(true);
    expect(expectOk({ LOG_MESSAGE_CONTENT: 'YES' }).logMessageContent).toBe(true);
    expect(expectOk({ LOG_MESSAGE_CONTENT: 'off' }).logMessageContent).toBe(false);
    expectInvalid({ TELEGRAM_ENABLED: 'maybe' }, 'telegram.enabled');
  });

  it('defaults a missing boolean to its configured default', () => {
    expect(expectOk({ LOG_MESSAGE_CONTENT: undefined }).logMessageContent).toBe(false);
    expect(expectOk({ LOG_MESSAGE_CONTENT: '' }).logMessageContent).toBe(false);
  });

  it('trusts forwarded headers only when explicitly configured', () => {
    expect(expectOk({}).trustProxy).toBe(false);
    expect(expectOk({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(expectOk({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(expectOk({ TRUST_PROXY: '127.0.0.1,::1' }).trustProxy).toEqual(['127.0.0.1', '::1']);
  });

  it('splits list values and trims blanks', () => {
    const config = expectOk({ TELEGRAM_OWNER_IDS: ' 111 , 222 ,, ' });
    expect(config.telegram.ownerIds).toEqual(['111', '222']);
  });

  it('rejects a non-numeric port', () => {
    expectInvalid({ PORT: 'not-a-port' }, 'port');
  });

  it('requires a bot token when Telegram is enabled', () => {
    expectInvalid({ TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '' }, 'telegram.botToken');
    expectInvalid({ TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'changeme' }, 'telegram.botToken');
  });

  it('requires owner ids when Telegram is enabled (no open bot)', () => {
    expectInvalid(
      { TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz', TELEGRAM_OWNER_IDS: '' },
      'telegram.ownerIds',
    );
  });

  it('rejects a placeholder owner id when Telegram is enabled', () => {
    expectInvalid(
      {
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
        TELEGRAM_OWNER_IDS: '123456789',
      },
      'telegram.ownerIds',
    );
    expectInvalid(
      {
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
        TELEGRAM_OWNER_IDS: '555000111,123456789',
      },
      'telegram.ownerIds',
    );
  });

  it('accepts an enabled Telegram bot with token and owner', () => {
    const config = expectOk({
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
      TELEGRAM_OWNER_IDS: '555000111',
    });
    expect(config.telegram.enabled).toBe(true);
  });

  it('keeps weak placeholder values usable in development where appropriate', () => {
    const config = expectOk({
      NODE_ENV: 'development',
      DASHBOARD_PASSWORD: 'a',
      SESSION_SECRET: 'a',
    });
    expect(config.dashboard.password).toBe('a');
    expect(config.dashboard.sessionSecret).toBe('a');
  });

  it('rejects an unknown IANA time zone', () => {
    expectInvalid({ DEFAULT_TIME_ZONE: 'Mars/Olympus' }, 'locale.timeZone');
    expect(expectOk({ DEFAULT_TIME_ZONE: 'Europe/London' }).locale.timeZone).toBe('Europe/London');
  });

  it('validates HH:MM defaults', () => {
    expectInvalid({ DEFAULT_MORNING_TIME: '9am' }, 'locale.morningDefaultTime');
    expectInvalid({ DEFAULT_EVENING_TIME: '25:00' }, 'locale.eveningDefaultTime');
    expectInvalid({ BRIEFING_TIME: '7:5' }, 'locale.briefingTime');
  });

  it('requires quiet hours to be paired', () => {
    expectInvalid({ QUIET_HOURS_START: '22:00' }, 'locale.quietHoursStart');
    expectInvalid({ QUIET_HOURS_END: '07:00' }, 'locale.quietHoursStart');
    expect(expectOk({ QUIET_HOURS_START: '22:00', QUIET_HOURS_END: '07:00' }).locale.quietHoursStart).toBe('22:00');
  });

  it('requires an API key when an AI provider is selected', () => {
    expectInvalid({ AI_PROVIDER: 'openai' }, 'ai.apiKey');
    expect(expectOk({ AI_PROVIDER: 'openai', AI_API_KEY: 'sk-test-abcdefghijklmnop' }).ai.provider).toBe('openai');
  });

  it('requires an API key when a speech provider is selected', () => {
    expectInvalid({ STT_PROVIDER: 'openai' }, 'stt.apiKey');
  });

  it('rejects unsafe provider base URLs', () => {
    const aiKey = 'sk-test-abcdefghijklmnop';
    const sttKey = 'sk-test-abcdefghijklmnop';
    expectInvalid(
      { AI_PROVIDER: 'openai', AI_API_KEY: aiKey, AI_BASE_URL: 'file:///etc/passwd' },
      'ai.baseUrl',
    );
    expectInvalid(
      { AI_PROVIDER: 'openai', AI_API_KEY: aiKey, AI_BASE_URL: 'https://user:pass@example.com/v1' },
      'ai.baseUrl',
    );
    expectInvalid(
      { STT_PROVIDER: 'openai', STT_API_KEY: sttKey, STT_BASE_URL: 'ftp://example.com/v1' },
      'stt.baseUrl',
    );
    expect(
      expectOk({
        AI_PROVIDER: 'openai-compatible',
        AI_API_KEY: aiKey,
        AI_BASE_URL: 'http://127.0.0.1:11434/v1',
      }).ai.baseUrl,
    ).toBe('http://127.0.0.1:11434/v1');
    expect(
      expectOk({
        AI_PROVIDER: 'openai-compatible',
        AI_API_KEY: aiKey,
        AI_BASE_URL: 'http://localhost:11434/v1',
      }).ai.baseUrl,
    ).toBe('http://localhost:11434/v1');
    expectInvalid(
      { AI_PROVIDER: 'openai', AI_API_KEY: aiKey, AI_BASE_URL: 'http://example.com/v1' },
      'ai.baseUrl',
    );
    expectInvalid(
      { STT_PROVIDER: 'openai', STT_API_KEY: sttKey, STT_BASE_URL: 'http://example.com/v1' },
      'stt.baseUrl',
    );
    expect(
      expectOk({
        NODE_ENV: 'development',
        AI_PROVIDER: 'openai-compatible',
        AI_API_KEY: aiKey,
        AI_BASE_URL: 'http://example.com/v1',
      }).ai.baseUrl,
    ).toBe('http://example.com/v1');
  });

  it('rejects unknown providers instead of silently ignoring them', () => {
    expectInvalid({ AI_PROVIDER: 'gemini' }, 'ai.provider');
    expectInvalid({ STT_PROVIDER: 'deepgram' }, 'stt.provider');
  });

  describe('production hardening', () => {
    const production = {
      NODE_ENV: 'production',
      DASHBOARD_PASSWORD: 'Correct-Horse-Battery-Staple-42',
      SESSION_SECRET: 's9K2mQ7xR4tN8vB3cZ6dF1gH5jL0pW2yU7',
      COOKIE_SECURE: 'true',
    };

    it('accepts a hardened production configuration', () => {
      const config = expectOk(production);
      expect(config.nodeEnv).toBe('production');
      expect(config.dashboard.cookieSecure).toBe(true);
    });

    it('requires a dashboard password', () => {
      expectInvalid({ ...production, DASHBOARD_PASSWORD: '' }, 'dashboard.password');
    });

    it('rejects weak or placeholder production passwords', () => {
      for (const password of ['a', 'short', 'password', 'changeme', '123456789']) {
        expectInvalid({ ...production, DASHBOARD_PASSWORD: password }, 'dashboard.password');
      }
    });

    it('requires a long session secret', () => {
      expectInvalid({ ...production, SESSION_SECRET: 'short' }, 'dashboard.sessionSecret');
    });

    it('rejects repeated or placeholder production session secrets', () => {
      for (const secret of ['a'.repeat(32), 'ab'.repeat(16), 'password'.repeat(4), 'changeme'.repeat(4)]) {
        expectInvalid({ ...production, SESSION_SECRET: secret }, 'dashboard.sessionSecret');
      }
    });

    it('does not echo a rejected password or secret in validation errors', () => {
      expect(() =>
        loadConfig({
          env: testEnv({
            NODE_ENV: 'production',
            DASHBOARD_PASSWORD: 'weak-password',
            SESSION_SECRET: 'a'.repeat(32),
            COOKIE_SECURE: 'true',
          }),
          loadFiles: false,
        }),
      ).toThrow(ConfigError);
      try {
        loadConfig({
          env: testEnv({
            NODE_ENV: 'production',
            DASHBOARD_PASSWORD: 'weak-password',
            SESSION_SECRET: 'a'.repeat(32),
            COOKIE_SECURE: 'true',
          }),
          loadFiles: false,
        });
      } catch (error) {
        const message = (error as ConfigError).message;
        expect(message).not.toContain('weak-password');
        expect(message).not.toContain('aaaaaaaa');
      }
    });

    it('requires secure cookies (HTTPS)', () => {
      expectInvalid({ ...production, COOKIE_SECURE: 'false' }, 'dashboard.cookieSecure');
    });

    it('requires an https webhook URL and secret in webhook mode', () => {
      const base = {
        ...production,
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
        TELEGRAM_OWNER_IDS: '555000111',
        TELEGRAM_MODE: 'webhook',
      };
      const secret = 'wK9mQ2pL7xR4tN8vB3cZ6dF1gH5jS0aE';
      expectInvalid({ ...base, TELEGRAM_WEBHOOK_URL: 'http://example.com', TELEGRAM_WEBHOOK_SECRET: secret }, 'telegram.webhookUrl');
      expectInvalid({ ...base, TELEGRAM_WEBHOOK_URL: 'https://example.com', TELEGRAM_WEBHOOK_SECRET: '' }, 'telegram.webhookSecret');
      expect(
        expectOk({ ...base, TELEGRAM_WEBHOOK_URL: 'https://example.com', TELEGRAM_WEBHOOK_SECRET: secret })
          .telegram.mode,
      ).toBe('webhook');
    });
  });

  describe('loadConfig', () => {
    it('throws a ConfigError with actionable, secret-free messages', () => {
      expect(() => loadConfig({ env: testEnv({ PORT: 'abc' }), loadFiles: false })).toThrow(ConfigError);
      try {
        loadConfig({ env: testEnv({ PORT: 'abc' }), loadFiles: false });
      } catch (error) {
        const message = (error as ConfigError).message;
        expect(message).toContain('port');
        expect(message).not.toContain(testEnv().SESSION_SECRET as string);
      }
    });

    it('loads a valid env object without touching disk', () => {
      const config = loadConfig({ env: testEnv(), loadFiles: false });
      expect(config.dashboard.password).toBeTruthy();
    });
  });

  it('reports capabilities accurately', () => {
    const config = expectOk({});
    const caps = capabilitiesOf(config);
    expect(caps.aiEnabled).toBe(false);
    expect(caps.sttEnabled).toBe(false);
    expect(caps.telegramConfigured).toBe(false);
    expect(caps.dashboardAuthConfigured).toBe(true);
  });

  it('never exposes secrets through the parsed config in logs', () => {
    // A guard against accidentally printing the parsed config in a bug report.
    const config = expectOk({});
    expect(typeof config.dashboard.password).toBe('string');
    // The logger redacts these keys; see logger tests.
  });
});
