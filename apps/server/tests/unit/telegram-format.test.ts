import { describe, expect, it } from 'vitest';

import type { Classification, CaptureDto } from '@recall/shared';

import type { IngestOutcome } from '../../src/services/capture-service.js';
import { parseCommand } from '../../src/telegram/commands.js';
import {
  buttonsToReplyMarkup,
} from '../../src/telegram/notifier.js';
import {
  formatCaptureConfirmation,
  formatHelp,
  kindCorrectionButtons,
  undoConfirmButtons,
} from '../../src/telegram/format.js';

const referenceNow = new Date('2026-10-17T10:00:00.000Z');

function capture(overrides: Partial<CaptureDto> = {}): CaptureDto {
  return {
    id: 'cap_1',
    source: 'TELEGRAM',
    externalId: 'telegram:1:2',
    rawText: 'call Ada at 4pm',
    kind: 'TASK',
    status: 'CLASSIFIED',
    confidence: 0.8,
    needsReview: false,
    classificationRationale: null,
    transcript: null,
    transcriptSource: null,
    capturedAt: '2026-10-17T10:00:00.000Z',
    processedAt: '2026-10-17T10:00:00.000Z',
    deletedAt: null,
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
    tags: [],
    links: [{ type: 'TASK', id: 'task_1', title: 'Call Ada' }],
    ...overrides,
  };
}

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    kind: 'TASK',
    title: 'Call Ada',
    description: null,
    category: null,
    tags: [],
    priority: null,
    dueAt: '2026-10-17T15:00:00.000Z',
    remindAt: null,
    projectName: null,
    confidence: 0.8,
    needsReview: false,
    rationale: null,
    ...overrides,
  };
}

function outcome(overrides: Partial<IngestOutcome> = {}): IngestOutcome {
  return {
    capture: capture(),
    created: [{ type: 'TASK', id: 'task_1', title: 'Call Ada' }],
    duplicate: false,
    classification: classification(),
    provider: 'rules',
    aiError: null,
    needsReview: false,
    processingError: null,
    remindersScheduled: 0,
    dedupeSuspicion: null,
    clarification: null,
    ...overrides,
  };
}

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/help')).toEqual({ command: 'help', args: '' });
  });

  it('strips the @botname suffix Telegram adds in groups', () => {
    expect(parseCommand('/settings@RecallBot')).toEqual({ command: 'settings', args: '' });
  });

  it('keeps the arguments', () => {
    expect(parseCommand('/find  quarterly report ')).toEqual({
      command: 'find',
      args: 'quarterly report',
    });
  });

  it('is case-insensitive and ignores leading whitespace', () => {
    expect(parseCommand('  /HELP ')?.command).toBe('help');
  });

  it('returns null for ordinary text', () => {
    expect(parseCommand('buy milk')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });
});

describe('formatCaptureConfirmation', () => {
  it('names the kind and the resolved time, in the owner\'s zone', () => {
    const text = formatCaptureConfirmation(outcome(), {
      timeZone: 'Africa/Lagos',
      referenceNow,
    });
    expect(text).toContain('Saved as a task');
    expect(text).toContain('Call Ada');
    // 15:00 UTC is 16:00 in Africa/Lagos (UTC+1).
    expect(text).toContain('16:00');
  });

  it('uses the right article for idea and appointment', () => {
    const idea = formatCaptureConfirmation(
      outcome({
        capture: capture({ kind: 'IDEA' }),
        created: [{ type: 'IDEA', id: 'idea_1', title: 'A study-group site' }],
      }),
      { timeZone: 'Africa/Lagos', referenceNow },
    );
    expect(idea).toContain('Saved as an idea');

    const event = formatCaptureConfirmation(
      outcome({
        capture: capture({ kind: 'EVENT' }),
        created: [{ type: 'EVENT', id: 'event_1', title: 'Dentist' }],
      }),
      { timeZone: 'Africa/Lagos', referenceNow },
    );
    expect(event).toContain('Saved as an appointment');
  });

  it('does not pretend to know the kind when it is UNKNOWN', () => {
    const text = formatCaptureConfirmation(
      outcome({ capture: capture({ kind: 'UNKNOWN' }), created: [] }),
      { timeZone: 'Africa/Lagos', referenceNow },
    );
    expect(text).toContain('Saved this:');
    expect(text).not.toContain('Saved as an unsure');
  });

  it('says a duplicate was not stored twice', () => {
    const text = formatCaptureConfirmation(outcome({ duplicate: true }), {
      timeZone: 'Africa/Lagos',
      referenceNow,
    });
    expect(text).toMatch(/Already saved/);
    expect(text).toMatch(/Nothing was duplicated/);
  });

  it('is explicit when the AI provider was unavailable', () => {
    const text = formatCaptureConfirmation(outcome({ aiError: 'openai: timeout' }), {
      timeZone: 'Africa/Lagos',
      referenceNow,
    });
    expect(text).toMatch(/AI provider was unavailable/);
  });

  it('reports a processing failure without pretending the item exists', () => {
    const text = formatCaptureConfirmation(
      outcome({ processingError: 'db is locked', created: [] }),
      { timeZone: 'Africa/Lagos', referenceNow },
    );
    expect(text).toMatch(/could not organise it yet/);
  });

  it('mentions a scheduled reminder only when one was actually set', () => {
    expect(
      formatCaptureConfirmation(outcome({ remindersScheduled: 1 }), {
        timeZone: 'Africa/Lagos',
        referenceNow,
      }),
    ).toContain('A reminder is set.');
    expect(
      formatCaptureConfirmation(outcome({ remindersScheduled: 0 }), {
        timeZone: 'Africa/Lagos',
        referenceNow,
      }),
    ).not.toContain('A reminder is set.');
  });

  it('flags a very similar recent capture', () => {
    const text = formatCaptureConfirmation(
      outcome({
        dedupeSuspicion: {
          captureId: 'cap_0',
          rawText: 'call Ada at 4pm',
          capturedAt: '2026-10-17T09:00:00.000Z',
        },
      }),
      { timeZone: 'Africa/Lagos', referenceNow },
    );
    expect(text).toMatch(/very similar/);
  });
});

describe('inline keyboards', () => {
  it('offers one callback per kind plus undo', () => {
    const keys = kindCorrectionButtons('cap_1').inline_keyboard.flat();
    expect(keys.map((k) => k.callback_data)).toEqual([
      'k:cap_1:TASK',
      'k:cap_1:IDEA',
      'k:cap_1:NOTE',
      'k:cap_1:EVENT',
      'u:cap_1',
    ]);
  });

  it('keeps callback data inside Telegram\'s 64-byte limit for a real cuid', () => {
    const id = 'clx0a1b2c3d4e5f6g7h8i9j0';
    for (const key of kindCorrectionButtons(id).inline_keyboard.flat()) {
      expect(Buffer.byteLength(key.callback_data, 'utf8')).toBeLessThanOrEqual(64);
    }
    for (const key of undoConfirmButtons(id).inline_keyboard.flat()) {
      expect(Buffer.byteLength(key.callback_data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('offers an explicit confirm and cancel for undo', () => {
    const keys = undoConfirmButtons('cap_1').inline_keyboard.flat();
    expect(keys).toEqual([
      { text: 'Yes, undo it', callback_data: 'U:cap_1' },
      { text: 'Keep it', callback_data: 'K:cap_1' },
    ]);
  });
});

describe('buttonsToReplyMarkup', () => {
  it('pairs label and callback data, two per row when supplied', () => {
    const markup = buttonsToReplyMarkup([
      ['Snooze 10m', 's:1:10', 'Done', 'd:1'],
      ['Cancel', 'c:1'],
    ]);
    expect(markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Snooze 10m', callback_data: 's:1:10' },
          { text: 'Done', callback_data: 'd:1' },
        ],
        [{ text: 'Cancel', callback_data: 'c:1' }],
      ],
    });
  });

  it('returns undefined when there is nothing to show', () => {
    expect(buttonsToReplyMarkup(undefined)).toBeUndefined();
    expect(buttonsToReplyMarkup([])).toBeUndefined();
    expect(buttonsToReplyMarkup([[]])).toBeUndefined();
  });

  it('ignores a dangling label with no callback data', () => {
    expect(buttonsToReplyMarkup([['Orphan']])).toBeUndefined();
  });
});

describe('formatHelp', () => {
  it('advertises only commands that exist today', () => {
    const text = formatHelp(true);
    expect(text).toContain('/inbox');
    expect(text).toContain('/undo');
    expect(text).toContain('/settings');
    expect(text).toContain('/help');
    // These arrive in later milestones and must not be advertised as working.
    expect(text).not.toContain('/tasks —');
    expect(text).not.toContain('/ask —');
  });

  it('warns when no owner is configured', () => {
    expect(formatHelp(false)).toMatch(/no owner id is configured/);
  });
});
