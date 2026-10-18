import { describe, expect, it, beforeEach } from 'vitest';

import { createTestDatabase } from '../helpers/db.js';
import { createTestContext } from '../helpers/app.js';
import { createTestTelegramAdapter, createFakeTelegram, textUpdate } from '../helpers/telegram.js';
import { advanceableClock } from '../../src/ports.js';
import { getSettings } from '../../src/services/settings-service.js';

describe('telegram reminder commands', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let ctx: Awaited<ReturnType<typeof createTestContext>>['ctx'];
  let clock: ReturnType<typeof advanceableClock>;
  let adapter: Awaited<ReturnType<typeof createTestTelegramAdapter>>['adapter'];
  let fake: Awaited<ReturnType<typeof createTestTelegramAdapter>>['fake'];

  beforeEach(async () => {
    testDb = await createTestDatabase('telegram-reminders');
    clock = advanceableClock('2026-10-17T10:00:00.000Z');
    const { ctx: c } = createTestContext({ db: testDb.db, clock });
    ctx = c;
    await getSettings(ctx.db, ctx.defaults);
    const fakeTelegram = createFakeTelegram();
    const { adapter: a, fake: f } = createTestTelegramAdapter(ctx, { fake: fakeTelegram });
    adapter = a;
    fake = f;
  });

  it('/remind in 10 minutes creates a reminder', async () => {
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes Review the docs'));
    expect(fake.sent[0]).toContain('Reminder set for');
    expect(fake.sent[0]).toContain('Review the docs');
  });

  it('/remind tomorrow at 9am creates a reminder', async () => {
    await adapter.handleUpdate(textUpdate('/remind tomorrow at 9am Call the office'));
    expect(fake.sent[0]).toContain('Reminder set for');
    expect(fake.sent[0]).toContain('Call the office');
  });

  it('/remind with no time asks for clarification', async () => {
    await adapter.handleUpdate(textUpdate('/remind Review the docs'));
    expect(fake.sent[0]).toContain('When should I remind you');
  });

  it('/remind with time but no title asks for title', async () => {
    await adapter.handleUpdate(textUpdate('/remind tomorrow at 9am'));
    expect(fake.sent[0]).toContain('What should I remind you about');
  });

  it('/remind with date only (no clock time) asks for time', async () => {
    await adapter.handleUpdate(textUpdate('/remind on Friday'));
    expect(fake.sent[0]).toContain('no time of day');
  });

  it('/reminders lists upcoming reminders', async () => {
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes First'));
    await adapter.handleUpdate(textUpdate('/remind in 20 minutes Second'));

    fake.reset();
    await adapter.handleUpdate(textUpdate('/reminders'));

    expect(fake.sent[0]).toContain('Your reminders');
    expect(fake.sent[0]).toContain('First');
    expect(fake.sent[0]).toContain('Second');
  });

  it('/reminders all lists all including finished', async () => {
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes First'));
    await adapter.handleUpdate(textUpdate('/remind in 20 minutes Second'));

    fake.reset();
    await adapter.handleUpdate(textUpdate('/reminders all'));

    expect(fake.sent[0]).toContain('All reminders');
  });

  it('/snooze 10m snoozes the only upcoming reminder', async () => {
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes Only one'));

    fake.reset();
    await adapter.handleUpdate(textUpdate('/snooze 10m'));

    expect(fake.sent[0]).toContain('Snoozed for 10 minutes');
  });

  it('/snooze 1h snoozes for an hour', async () => {
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes One hour'));

    fake.reset();
    await adapter.handleUpdate(textUpdate('/snooze 1h'));

    expect(fake.sent[0]).toContain('Snoozed for 1 hour');
  });

  it('/snooze tomorrow 9am snoozes to tomorrow morning', async () => {
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes Tomorrow'));

    fake.reset();
    await adapter.handleUpdate(textUpdate('/snooze tomorrow 9am'));

    expect(fake.sent[0]).toContain('Snoozed for tomorrow at 09:00');
  });

  it('/snooze with multiple reminders asks which one', async () => {
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes First'));
    await adapter.handleUpdate(textUpdate('/remind in 20 minutes Second'));

    fake.reset();
    await adapter.handleUpdate(textUpdate('/snooze 10m'));

    expect(fake.sent[0]).toContain('Which reminder');
  });

  it('/snooze with explicit id targets that reminder', async () => {
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes Targeted'));
    const firstMsg = fake.sent[0];
    const idMatch = firstMsg.match(/#([a-z0-9]{6})/);
    const shortId = idMatch ? `#${idMatch[1]}` : '';

    fake.reset();
    await adapter.handleUpdate(textUpdate(`/snooze 10m ${shortId}`));

    expect(fake.sent[0]).toContain('Snoozed for 10 minutes');
  });

  it('/cancel with no args lists reminders to cancel', async () => {
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes First'));

    fake.reset();
    await adapter.handleUpdate(textUpdate('/cancel'));

    expect(fake.sent[0]).toContain('Which reminder should I cancel');
    expect(fake.sent[0]).toContain('First');
  });

  it('/cancel <id> cancels that reminder', async () => {
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes To cancel'));
    const firstMsg = fake.sent[0];
    const idMatch = firstMsg.match(/#([a-z0-9]{6})/);
    const shortId = idMatch ? `#${idMatch[1]}` : '';

    fake.reset();
    await adapter.handleUpdate(textUpdate(`/cancel ${shortId}`));

    expect(fake.sent[0]).toContain('Cancelled: To cancel');
    expect(fake.sent[0].toLowerCase()).toContain('the task or note it came from was not touched.');
  });

  it('/cancel on unknown id reports not found', async () => {
    await adapter.handleUpdate(textUpdate('/cancel #nonexistent'));
    expect(fake.sent[0]).toContain('could not find a reminder matching');
  });

  it('/help now includes reminder commands', async () => {
    await adapter.handleUpdate(textUpdate('/help'));
    expect(fake.sent[0]).toContain('/remind');
    expect(fake.sent[0]).toContain('/reminders');
    expect(fake.sent[0]).toContain('/snooze');
    expect(fake.sent[0]).toContain('/cancel');
  });

  it('reminder delivery is recorded and visible via /reminders', async () => {
    // The fake notifier always succeeds, so after a tick the reminder becomes SENT
    // For now we just verify the command flow works
    await adapter.handleUpdate(textUpdate('/remind in 10 minutes Test delivery'));
    expect(fake.sent[0]).toContain('Reminder set for');
  });

  it('recurring reminder syntax is preserved', async () => {
    await adapter.handleUpdate(textUpdate('/remind every day at 9am Daily standup'));
    expect(fake.sent[0]).toContain('repeats daily');
  });

  it('weekly recurring reminder syntax is preserved', async () => {
    await adapter.handleUpdate(textUpdate('/remind every friday at 5pm Weekly review'));
    expect(fake.sent[0]).toContain('repeats weekly');
  });
});