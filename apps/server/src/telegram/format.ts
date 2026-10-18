/**
 * Telegram message formatting.
 *
 * Plain text only — no `parse_mode` — so a capture containing markup characters
 * can never break a message or inject formatting. Every function here is pure and
 * unit tested.
 */
import type { CaptureDto, CaptureKind, ReminderDto, TaskDto } from '@recall/shared';

import { describeRelative, formatLocalCompact, formatLocalHuman } from '../lib/time.js';
import { truncate } from '../lib/text.js';
import type { ReplyMarkup } from './client.js';
import type { IngestOutcome } from '../services/capture-service.js';

const KIND_LABELS: Record<CaptureKind, string> = {
  TASK: 'task',
  IDEA: 'idea',
  NOTE: 'note',
  EVENT: 'appointment',
  OTHER: 'note (unsure)',
  UNKNOWN: 'unsure',
};

export function kindLabel(kind: CaptureKind): string {
  return KIND_LABELS[kind];
}

function quote(text: string, max = 160): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** "a task", "an idea", "an appointment" — the confirmation should read naturally. */
function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;
}

/** Inline keyboard to correct a classification. */
export function kindCorrectionButtons(captureId: string): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'Task', callback_data: `k:${captureId}:TASK` },
        { text: 'Idea', callback_data: `k:${captureId}:IDEA` },
        { text: 'Note', callback_data: `k:${captureId}:NOTE` },
      ],
      [
        { text: 'Appointment', callback_data: `k:${captureId}:EVENT` },
        { text: 'Undo', callback_data: `u:${captureId}` },
      ],
    ],
  };
}

export function undoConfirmButtons(captureId: string): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'Yes, undo it', callback_data: `U:${captureId}` },
        { text: 'Keep it', callback_data: `K:${captureId}` },
      ],
    ],
  };
}

export interface ConfirmationContext {
  timeZone: string;
  referenceNow: Date;
}

/**
 * The confirmation shown after a capture is saved.
 *
 * It always states what Recall understood, including any assumption it made, so
 * a wrong guess is immediately visible rather than silent.
 */
export function formatCaptureConfirmation(
  outcome: IngestOutcome,
  context: ConfirmationContext,
): string {
  const { capture } = outcome;

  if (outcome.duplicate) {
    return `Already saved (${formatLocalCompact(new Date(capture.capturedAt), context.timeZone)}). Nothing was duplicated.`;
  }

  const lines: string[] = [];
  const head =
    capture.kind === 'UNKNOWN'
      ? 'Saved this:'
      : `Saved as ${withArticle(kindLabel(capture.kind))}:`;
  const created = outcome.created[0];
  lines.push(head);
  lines.push(created ? `• ${quote(created.title)}` : `• ${quote(capture.rawText)}`);

  const classification = outcome.classification;
  if (classification) {
    if (classification.dueAt) {
      const parsed = new Date(classification.dueAt);
      const isReminder = Boolean(classification.remindAt);
      lines.push(
        `${isReminder ? 'Reminder' : 'Due'}: ${formatLocalHuman(parsed, context.timeZone)} (${describeRelative(
          parsed,
          context.referenceNow,
          context.timeZone,
        )})`,
      );
    }
    if (classification.priority) lines.push(`Priority: ${classification.priority.toLowerCase()}`);
    if (classification.tags.length > 0) {
      lines.push(`Tags: ${classification.tags.map((t) => `#${t}`).join(' ')}`);
    }
  }

  if (outcome.remindersScheduled > 0) lines.push('A reminder is set.');

  if (outcome.aiError) {
    lines.push('');
    lines.push('(The AI provider was unavailable, so I used built-in parsing. Nothing was lost.)');
  }

  if (outcome.processingError) {
    lines.push('');
    lines.push('I saved your message but could not organise it yet. It is in your inbox and I will retry.');
  }

  if (outcome.dedupeSuspicion) {
    lines.push('');
    lines.push(
      `Note: you captured something very similar on ${formatLocalCompact(
        new Date(outcome.dedupeSuspicion.capturedAt),
        context.timeZone,
      )}.`,
    );
  }

  if (outcome.clarification) {
    lines.push('');
    lines.push(outcome.clarification);
  }

  if (capture.needsReview && !outcome.clarification) {
    lines.push('');
    lines.push('This one is in your inbox for review. Tap a type below if I got it wrong.');
  }

  return lines.join('\n');
}

export function formatTaskLine(task: TaskDto, timeZone: string): string {
  const parts: string[] = [];
  const marker =
    task.status === 'COMPLETED'
      ? '✓'
      : task.status === 'CANCELLED'
        ? '✗'
        : task.status === 'IN_PROGRESS'
          ? '▶'
          : '•';
  parts.push(`${marker} ${truncate(task.title, 90)}`);
  if (task.dueAt) {
    const due = new Date(task.dueAt);
    parts.push(task.isOverdue ? `OVERDUE (${formatLocalCompact(due, timeZone)})` : `due ${formatLocalCompact(due, timeZone)}`);
  }
  if (task.priority === 'URGENT' || task.priority === 'HIGH') parts.push(task.priority.toLowerCase());
  if (task.projectName) parts.push(`[${task.projectName}]`);
  parts.push(`#${task.id.slice(0, 6)}`);
  return parts.join(' · ');
}

export function formatTaskList(tasks: TaskDto[], timeZone: string, header: string): string {
  if (tasks.length === 0) return `${header}\n\nNothing here. 🎉`;
  const shown = tasks.slice(0, 20);
  const lines = [header, '', ...shown.map((task) => formatTaskLine(task, timeZone))];
  if (tasks.length > shown.length) lines.push('', `…and ${tasks.length - shown.length} more.`);
  return lines.join('\n');
}

export function formatCaptureLine(capture: CaptureDto, timeZone: string): string {
  return [
    `${kindLabel(capture.kind)} · ${formatLocalCompact(new Date(capture.capturedAt), timeZone)}`,
    `   ${quote(capture.rawText, 120)}`,
    `   #${capture.id.slice(0, 6)}${capture.needsReview ? ' · needs review' : ''}`,
  ].join('\n');
}

export function formatCaptureList(captures: CaptureDto[], timeZone: string, header: string): string {
  if (captures.length === 0) return `${header}\n\nNothing found.`;
  return [header, '', ...captures.slice(0, 15).map((c) => formatCaptureLine(c, timeZone))].join('\n');
}

export function formatReminderLine(reminder: ReminderDto, timeZone: string): string {
  const when = formatLocalHuman(new Date(reminder.remindAt), timeZone);
  const status = reminder.status === 'SCHEDULED' ? '' : ` (${reminder.status.toLowerCase()})`;
  return `• ${truncate(reminder.title, 80)} · ${when}${status} · #${reminder.id.slice(0, 6)}`;
}

export function formatReminderList(reminders: ReminderDto[], timeZone: string, header: string): string {
  if (reminders.length === 0) return `${header}\n\nNo reminders set.`;
  return [header, '', ...reminders.slice(0, 20).map((r) => formatReminderLine(r, timeZone))].join('\n');
}

export function formatHelp(ownerConfigured: boolean): string {
  const lines = [
    'Recall — your memory assistant',
    '',
    'Just send me a message and I will keep it. I work out whether it is a task,',
    'an idea, a note or an appointment, and I confirm what I understood.',
    '',
    'Examples:',
    '• I need to finish the project documentation tomorrow',
    '• Remind me to call Ada at 4 PM',
    '• I have an idea for a website that helps students',
    '• Save this link for me: https://example.com/post',
    '',
    'Commands',
    '/inbox — captures that need review',
    '/undo — undo your most recent capture',
    '/settings — your configuration',
    '/help — this message',
    '',
    'You can also tap the buttons under any confirmation to change how something',
    'was classified.',
    '',
    'Task lists, search, reminders and questions about what you saved are on the',
    'way in the next milestones.',
  ];
  if (!ownerConfigured) {
    lines.push('', 'Warning: no owner id is configured, so I cannot accept messages.');
  }
  return lines.join('\n');
}

export function formatSettingsSummary(input: {
  displayName: string | null;
  timeZone: string;
  morningDefaultTime: string;
  eveningDefaultTime: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  maxNotificationsPerDay: number;
  briefingEnabled: boolean;
  briefingTime: string;
  aiProvider: string;
  aiEnabled: boolean;
  sttProvider: string;
  ownerIds: readonly string[];
}): string {
  const lines = [
    'Your Recall settings',
    '',
    `Time zone: ${input.timeZone}`,
    `Morning default: ${input.morningDefaultTime} · Evening default: ${input.eveningDefaultTime}`,
    `Quiet hours: ${input.quietHoursStart && input.quietHoursEnd ? `${input.quietHoursStart}–${input.quietHoursEnd}` : 'not set'}`,
    `Daily notification cap: ${input.maxNotificationsPerDay === 0 ? 'unlimited' : input.maxNotificationsPerDay}`,
    `Daily briefing: ${input.briefingEnabled ? `on at ${input.briefingTime}` : 'off'}`,
    `AI classification: ${input.aiProvider === 'none' ? 'not configured (built-in parsing)' : input.aiProvider + (input.aiEnabled ? '' : ' (disabled)')}`,
    `Voice transcription: ${input.sttProvider === 'none' ? 'not configured' : input.sttProvider}`,
    `Owner ids: ${input.ownerIds.length > 0 ? input.ownerIds.join(', ') : 'NONE — the bot is closed'}`,
    '',
    'Change these in the web dashboard, or edit .env and restart.',
  ];
  return lines.join('\n');
}

export function formatUnsupportedMessage(kind: string): string {
  return `I cannot store ${kind} messages yet. Notes, ideas, tasks, appointments and voice messages all work — send me one of those.`;
}

/** Voice is stored (with a marker) in this milestone; transcription comes later. */
export function formatVoiceStored(durationSeconds: number | null): string {
  const length = durationSeconds && durationSeconds > 0 ? ` (${Math.round(durationSeconds)}s)` : '';
  return [
    `I saved your voice message${length}, but I cannot transcribe it yet — it is kept with a`,
    '"not transcribed yet" marker so nothing is lost. Transcription arrives in a',
    'later update; until then, add a caption and I will read that instead.',
  ].join(' ');
}

export function formatKindUpdated(kind: CaptureKind): string {
  return `Updated — I will treat this as ${kindLabel(kind)}. Your original message is unchanged.`;
}

export function formatUndone(removedCount: number): string {
  return removedCount > 0
    ? `Undone. I removed the capture and ${removedCount} item${removedCount === 1 ? '' : 's'} created from it.`
    : 'Undone. I removed the capture. Nothing had been created from it.';
}

export function formatKept(): string {
  return 'Kept it. Nothing was deleted.';
}

export function formatNeedsText(): string {
  return 'I did not find any text in that. Send me some words and I will save them.';
}

export function formatCallbackProblem(message: string): string {
  return truncate(message, 180);
}

export function formatUnauthorized(): string {
  return 'This bot is private. I can only accept messages from its owner.';
}

export function formatError(kind: 'capture' | 'generic'): string {
  return kind === 'capture'
    ? 'Something went wrong while saving that. Your message was not stored — please send it again.'
    : 'Something went wrong. Please try again.';
}
