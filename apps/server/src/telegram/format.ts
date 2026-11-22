/**
 * Telegram message formatting.
 *
 * Plain text only — no `parse_mode` — so a capture containing markup characters
 * can never break a message or inject formatting. Every function here is pure and
 * unit tested.
 */
import type {
  CaptureDto,
  CaptureKind,
  IdeaDto,
  NoteDto,
  ProjectDto,
  ReminderDto,
  ReminderRecurrence,
  SearchResponse,
  TaskDto,
  TranscriptSource,
} from '@recall/shared';

import type { AiBlockReason } from '../ai/access.js';
import { describeRelative, formatLocalCompact, formatLocalHuman } from '../lib/time.js';
import { truncate } from '../lib/text.js';
import type { ReplyMarkup } from './client.js';
import type { AskOutcome } from '../services/ask-service.js';
import type { IngestOutcome } from '../services/capture-service.js';

const KIND_LABELS: Record<CaptureKind, string> = {
  TASK: 'task',
  IDEA: 'idea',
  NOTE: 'note',
  EVENT: 'appointment',
  OTHER: 'note (unsure)',
  UNKNOWN: 'unsure',
};

const TRANSCRIPT_SOURCE_LABELS: Record<TranscriptSource, string> = {
  SPEECH_PROVIDER: 'the configured speech provider',
  MANUAL: 'manual entry',
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

  if (capture.transcript) {
    lines.push('');
    lines.push(`Transcribed: ${quote(capture.transcript)}`);
    if (capture.transcriptSource) {
      lines.push(`(Transcribed by ${TRANSCRIPT_SOURCE_LABELS[capture.transcriptSource]})`);
    }
  }

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

export function formatIdeaList(ideas: IdeaDto[], timeZone: string, header: string): string {
  if (ideas.length === 0) return `${header}\n\nNo ideas saved yet.`;
  const shown = ideas.slice(0, 20);
  const lines = [header, ''];
  for (const idea of shown) {
    lines.push(`• ${truncate(idea.title, 90)}`);
    if (idea.body) lines.push(`   ${quote(idea.body, 120)}`);
    lines.push(
      `   ${formatLocalCompact(new Date(idea.createdAt), timeZone)}${idea.projectName ? ` · [${idea.projectName}]` : ''} · #${idea.id.slice(0, 6)}`,
    );
  }
  if (ideas.length > shown.length) lines.push('', `…and ${ideas.length - shown.length} more.`);
  return lines.join('\n');
}

export function formatNoteList(notes: NoteDto[], timeZone: string, header: string): string {
  if (notes.length === 0) return `${header}\n\nNo notes saved yet.`;
  const shown = notes.slice(0, 20);
  const lines = [header, ''];
  for (const note of shown) {
    lines.push(`• ${truncate(note.title ?? quote(note.body, 70), 90)}`);
    if (note.url) lines.push(`   ${truncate(note.url, 120)}`);
    lines.push(
      `   ${formatLocalCompact(new Date(note.createdAt), timeZone)}${note.projectName ? ` · [${note.projectName}]` : ''} · #${note.id.slice(0, 6)}`,
    );
  }
  if (notes.length > shown.length) lines.push('', `…and ${notes.length - shown.length} more.`);
  return lines.join('\n');
}

export function formatProjectList(projects: ProjectDto[], header: string): string {
  if (projects.length === 0) return `${header}\n\nNo projects yet.`;
  const lines = [header, ''];
  for (const project of projects.slice(0, 30)) {
    const open = project.counts.openTasks > 0 ? ` · ${project.counts.openTasks} open` : '';
    const archived = project.status === 'ARCHIVED' ? ' (archived)' : '';
    lines.push(`• ${truncate(project.name, 80)}${archived}${open}`);
    const parts: string[] = [];
    if (project.counts.notes > 0) parts.push(`${project.counts.notes} notes`);
    if (project.counts.ideas > 0) parts.push(`${project.counts.ideas} ideas`);
    if (project.counts.events > 0) parts.push(`${project.counts.events} appointments`);
    if (parts.length > 0) lines.push(`   ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

/**
 * Search results. Each row states the type and, when the match was not in the
 * title, which field matched — so a result is never unexplained.
 */
export function formatSearchResults(response: SearchResponse, header: string): string {
  if (response.items.length === 0) {
    return `${header}\n\nNothing matched. Try fewer or different words.`;
  }
  const lines = [header, ''];
  response.items.slice(0, 15).forEach((item, index) => {
    lines.push(
      `${index + 1}. ${item.type.toLowerCase()} · ${truncate(item.title, 80)}${item.status ? ` (${item.status.toLowerCase()})` : ''}`,
    );
    if (item.matchedOn.length > 0) lines.push(`   matched: ${item.matchedOn.join(', ')}`);
    if (item.snippet.length > 0 && !item.title.includes(item.snippet)) {
      lines.push(`   ${truncate(item.snippet, 140)}`);
    }
    lines.push(`   #${item.id.slice(0, 6)}`);
  });
  const shown = Math.min(15, response.items.length);
  if (response.total > shown) {
    lines.push('', `…${response.total - shown} more. Add words to narrow it down.`);
  }
  return lines.join('\n');
}

/**
 * An answer from `/ask`.
 *
 * The answer comes first; the records it was derived from follow, with the same
 * short id style as the other commands. A deterministic answer already names the
 * records, so the source list is the verifiable part rather than a second claim.
 */
export function formatAskAnswer(result: AskOutcome): string {
  const lines = [result.answer];
  if (result.evidence.length > 0) {
    lines.push('', 'Based on:');
    for (const item of result.evidence) {
      const status = item.status ? ` (${item.status.toLowerCase()})` : '';
      lines.push(
        `• ${item.type.toLowerCase()} · ${truncate(item.title, 80)}${status} #${item.id.slice(0, 6)}`,
      );
    }
  }
  return lines.join('\n');
}

function recurrenceLabel(recurrence: ReminderRecurrence): string {
  if (recurrence.frequency === 'DAILY') return 'repeats daily';
  if (recurrence.frequency === 'MONTHLY') return 'repeats monthly';
  const names = recurrence.weekdays
    .map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day] ?? '')
    .filter(Boolean)
    .join('/');
  return names ? `repeats weekly (${names})` : 'repeats weekly';
}

export function formatReminderLine(reminder: ReminderDto, timeZone: string, now?: Date): string {
  const due = new Date(reminder.remindAt);
  const isOverdue = reminder.status === 'SCHEDULED' && now !== undefined && due.getTime() <= now.getTime();
  const when = formatLocalHuman(due, timeZone);
  const parts = [
    `${isOverdue ? '⚠' : '•'} ${truncate(reminder.title, 80)}`,
    `${when}${isOverdue ? ' (due now)' : ''}`,
    ...(reminder.recurrence ? [recurrenceLabel(reminder.recurrence)] : []),
    ...(reminder.status === 'SCHEDULED' ? [] : [reminder.status.toLowerCase()]),
    `#${reminder.id.slice(0, 6)}`,
  ];
  return parts.join(' · ');
}

export function formatReminderList(
  reminders: ReminderDto[],
  timeZone: string,
  header: string,
  now?: Date,
): string {
  if (reminders.length === 0) {
    return `${header}\n\nNo reminders set. Try /remind tomorrow at 9am Call the office`;
  }
  const shown = reminders.slice(0, 20);
  const lines = [header, '', ...shown.map((r) => formatReminderLine(r, timeZone, now))];
  if (reminders.length > shown.length) lines.push('', `…and ${reminders.length - shown.length} more.`);
  lines.push('', 'Snooze one with /snooze 10m, or cancel it with /cancel <id>.');
  return lines.join('\n');
}

/** Confirmation for a newly created reminder, including any assumption made. */
export function formatReminderCreated(reminder: ReminderDto, timeZone: string, referenceNow: Date): string {
  const when = formatLocalHuman(new Date(reminder.remindAt), timeZone);
  const lines = [
    `Reminder set for ${when} (${describeRelative(new Date(reminder.remindAt), referenceNow, timeZone)}).`,
    `• ${quote(reminder.title, 160)}`,
    `#${reminder.id.slice(0, 6)}`,
  ];
  if (reminder.recurrence) lines.push(recurrenceLabel(reminder.recurrence));
  return lines.join('\n');
}

/** Returned when `/remind` had no usable time; nothing was created. */
export function formatRemindNeedsTime(): string {
  return [
    'When should I remind you? I could not find a time in that.',
    '',
    'Try:',
    '• /remind in 10 minutes Review the documentation',
    '• /remind tomorrow at 9am Call the office',
    '',
    'Nothing was created yet.',
  ].join('\n');
}

/** Returned when `/remind` had a time but nothing to remind about. */
export function formatRemindNeedsTitle(): string {
  return 'What should I remind you about? Add the words after the time, for example: /remind in 10 minutes Review the docs. Nothing was created yet.';
}

/** Returned when `/remind` was given a day but no time of day. */
export function formatRemindNeedsClockTime(dayText: string | null): string {
  const day = dayText ? ` for ${dayText}` : '';
  return `I have a day${day}, but no time of day. Reminders need a clock time so they are not sent at an invented hour — for example: /remind tomorrow at 9am Call the office. Nothing was created yet.`;
}

export function formatSnoozeUsage(): string {
  return [
    'How long should I snooze it for?',
    '',
    'Supported:',
    '• /snooze 10m',
    '• /snooze 1h',
    '• /snooze tomorrow 9am',
  ].join('\n');
}

export function formatSnoozeNothingUpcoming(): string {
  return 'There are no reminders to snooze right now.';
}

export function formatSnoozeAmbiguous(): string {
  return 'Which reminder? Send /reminders to see them, then /snooze 10m <id>.';
}

export function formatReminderSnoozed(reminder: ReminderDto, timeZone: string, label: string): string {
  return `Snoozed for ${label} — I will remind you at ${formatLocalHuman(new Date(reminder.remindAt), timeZone)}.\n• ${quote(reminder.title, 160)}`;
}

export function formatReminderCancelled(reminder: ReminderDto): string {
  return `Cancelled: ${quote(reminder.title, 160)}. The reminder is stopped; the task or note it came from was not touched.`;
}

export function formatCancelNothingUpcoming(): string {
  return 'There are no reminders to cancel right now.';
}

export function formatCancelNeedsId(): string {
  return 'Which reminder should I cancel? Send /reminders, then /cancel <id> — or arrange a new one with /remind.';
}

export function formatCancelAmbiguous(): string {
  return 'Which reminder? That id matches more than one. Send /reminders and use the full id after /cancel.';
}

export function formatReminderNotFound(prefix: string): string {
  return `I could not find a reminder matching "${prefix}". Send /reminders to see the current ones.`;
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
    '/tasks — open tasks (add "all" to include finished ones)',
    '/today — what is due today',
    '/overdue — what is past its deadline',
    '/remind <when> <what> — set a reminder, e.g. /remind tomorrow at 9am Call the office',
    '/reminders — your reminders (add "all" to include finished ones)',
    '/snooze <10m|1h|tomorrow 9am> [id] — snooze a reminder',
    '/cancel <id> — cancel a reminder',
    '/search <words> — search everything you have saved',
    '/ask <question> — ask about what you have saved, with sources',
    '/ideas — your ideas',
    '/notes — your notes and saved links',
    '/projects — your projects',
    '/inbox — captures that need review',
    '/undo — undo your most recent capture',
    '/settings — your configuration',
    '/help — this message',
    '',
    'You can also tap the buttons under any confirmation to change how something',
    'was classified.',
  ];
  if (!ownerConfigured) {
    lines.push('', 'Warning: no owner id is configured, so I cannot accept messages.');
  }
  return lines.join('\n');
}

/** The AI line of `/settings`: the provider only when it really receives text. */
function formatAiStatus(provider: string, reason: AiBlockReason | null): string {
  if (provider === 'none') return 'not configured (built-in parsing)';
  switch (reason) {
    case null:
      return provider;
    case 'not_configured':
      return `${provider} not available (built-in parsing)`;
    case 'disabled_in_settings':
      return `${provider} switched off in Settings (built-in parsing)`;
    case 'raw_text_not_allowed':
      return `${provider} not used: the server does not send your text (AI_ALLOW_RAW_TEXT is off; built-in parsing)`;
  }
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
  /**
   * Why AI is not used for personal text, from `aiForPersonalText`, or null
   * when it is. The line must never suggest AI is active when that rule says no.
   */
  aiBlockReason: AiBlockReason | null;
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
    `AI classification: ${formatAiStatus(input.aiProvider, input.aiBlockReason)}`,
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

export type VoiceStoreReason =
  | 'disabled'
  | 'too-long'
  | 'failed'
  | 'empty'
  | 'unsupported'
  | 'transcript-too-long';

const VOICE_REASON_TEXT: Record<VoiceStoreReason, string> = {
  disabled:
    'Transcription is not configured, so I kept it with a "not transcribed" marker. Add a caption or send the words as text and I will organise them.',
  'too-long':
    'It is longer than the configured transcription limit, so I did not send it for transcription. It is stored with a "not transcribed" marker — re-send a shorter clip or add a caption.',
  failed:
    'The speech provider could not transcribe it. Your audio message is stored with a "not transcribed" marker — send the words as text or add a caption.',
  empty:
    'The speech provider found no words in it. Your audio message is stored with a "not transcribed" marker — send the words as text or add a caption.',
  unsupported:
    'That audio format is not supported for transcription. Your message is stored with a "not transcribed" marker — send the words as text or add a caption.',
  'transcript-too-long':
    'The transcript was longer than the 8,000-character limit, so I did not store it. Your message is saved with a "not transcribed" marker — send the key points as text or a shorter clip.',
};

export function formatVoiceStored(
  durationSeconds: number | null,
  reason: VoiceStoreReason = 'disabled',
): string {
  const length = durationSeconds && durationSeconds > 0 ? ` (${Math.round(durationSeconds)}s)` : '';
  return `I saved your voice message${length}, but did not transcribe it. ${VOICE_REASON_TEXT[reason]}`;
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
