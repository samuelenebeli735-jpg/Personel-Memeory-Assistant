import { describe, expect, it } from 'vitest';

import { TelegramClient } from '../../src/telegram/client.js';
import { createTelegramNotifier } from '../../src/telegram/notifier.js';
import { createFakeTelegram } from '../helpers/telegram.js';

function build(options: { ownerIds?: string[]; onCall?: Parameters<typeof createFakeTelegram>[0]['onCall'] } = {}) {
  const fake = createFakeTelegram(options.onCall ? { onCall: options.onCall } : {});
  const client = new TelegramClient({ token: 'test-token', fetchImpl: fake.fetchImpl });
  const notifier = createTelegramNotifier({
    client,
    ownerIds: options.ownerIds ?? ['555000111'],
  });
  return { fake, client, notifier };
}

describe('telegram notifier', () => {
  it('delivers to the configured owner chat and reports the message id', async () => {
    const { fake, notifier } = build();
    const result = await notifier.send({ text: 'Reminder: call Ada', proactive: true });
    expect(result.ok).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(fake.sent).toEqual(['Reminder: call Ada']);
    expect(notifier.channel).toBe('telegram');
  });

  it('honours an explicit chat id over the default owner', async () => {
    const { fake, notifier } = build();
    await notifier.send({ chatId: '999', text: 'hello' });
    const call = fake.callsTo('sendMessage')[0];
    expect(call?.payload.chat_id).toBe('999');
  });

  it('turns button pairs into an inline keyboard', async () => {
    const { fake, notifier } = build();
    await notifier.send({
      text: 'Reminder',
      buttons: [['Snooze 10m', 'snooze:1:10', 'Done', 'done:1']],
    });
    const call = fake.callsTo('sendMessage')[0];
    expect(call?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Snooze 10m', callback_data: 'snooze:1:10' },
          { text: 'Done', callback_data: 'done:1' },
        ],
      ],
    });
  });

  it('is unavailable when no owner chat is configured', async () => {
    const { notifier, fake } = build({ ownerIds: [] });
    expect(notifier.isAvailable()).toBe(false);
    const result = await notifier.send({ text: 'anything' });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(fake.methods()).not.toContain('sendMessage');
  });

  it('reports a rate limit as retryable', async () => {
    const { notifier } = build({
      onCall: (method) =>
        method === 'sendMessage'
          ? { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } } }
          : undefined,
    });
    const result = await notifier.send({ text: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('treats a blocked bot as permanent so retries do not spin forever', async () => {
    const { notifier } = build({
      onCall: (method) =>
        method === 'sendMessage'
          ? { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }
          : undefined,
    });
    const result = await notifier.send({ text: 'hi' });
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it('treats a server error as retryable', async () => {
    const { notifier } = build({
      onCall: (method) =>
        method === 'sendMessage'
          ? { status: 500, body: { ok: false, error_code: 500, description: 'Internal Server Error' } }
          : undefined,
    });
    const result = await notifier.send({ text: 'hi' });
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('never throws when the network itself fails', async () => {
    const client = new TelegramClient({
      token: 'test-token',
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as typeof fetch,
    });
    const notifier = createTelegramNotifier({ client, ownerIds: ['1'] });
    const result = await notifier.send({ text: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });
});
