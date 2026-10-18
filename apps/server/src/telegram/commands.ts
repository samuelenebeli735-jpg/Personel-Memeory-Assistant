/**
 * Telegram command registry.
 *
 * A command is a pure function of the application context plus the invocation
 * text; it returns the reply to send. Keeping commands out of the message
 * handler means the same logic is unit-testable without a fake Telegram client,
 * and adding a command is one entry in one map.
 *
 * Only commands that are actually implemented are registered. Commands that
 * belong to a later milestone reply with a plain "not yet" note instead of
 * pretending to work.
 */
import { searchQuerySchema, type SearchQuery } from '@recall/shared';

import type { AppContext } from '../context.js';
import { localDayRange } from '../lib/time.js';
import { listCaptures, listInbox } from '../services/capture-service.js';
import { findIdeas } from '../services/idea-service.js';
import { findNotes } from '../services/note-service.js';
import { listProjects } from '../services/project-service.js';
import { searchAll } from '../services/search-service.js';
import { getSettings } from '../services/settings-service.js';
import { findTasks } from '../services/task-service.js';
import type { ReplyMarkup } from './client.js';
import {
  formatCaptureList,
  formatHelp,
  formatIdeaList,
  formatNoteList,
  formatProjectList,
  formatSearchResults,
  formatSettingsSummary,
  formatTaskList,
  undoConfirmButtons,
} from './format.js';

export interface CommandReply {
  text: string;
  markup?: ReplyMarkup;
}

export interface CommandInvocation {
  ctx: AppContext;
  /** Command name without the leading slash and without any @botname suffix. */
  command: string;
  /** Text after the command, trimmed. Empty when the command took no argument. */
  args: string;
  chatId: number | string;
}

export type CommandHandler = (invocation: CommandInvocation) => Promise<CommandReply>;

/**
 * Parses `/command@BotName args` into its parts.
 * Returns null when the text is not a command at all.
 */
export function parseCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  if (!head) return null;
  const command = head.slice(1).split('@')[0]?.toLowerCase() ?? '';
  if (command.length === 0) return null;
  return { command, args: rest.join(' ').trim() };
}

const help: CommandHandler = async ({ ctx }) => ({
  text: formatHelp(ctx.config.telegram.ownerIds.length > 0),
});

const settings: CommandHandler = async ({ ctx }) => {
  const row = await getSettings(ctx.db, ctx.defaults);
  return {
    text: formatSettingsSummary({
      displayName: row.displayName,
      timeZone: row.timeZone,
      morningDefaultTime: row.morningDefaultTime,
      eveningDefaultTime: row.eveningDefaultTime,
      quietHoursStart: row.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd,
      maxNotificationsPerDay: row.maxNotificationsPerDay,
      briefingEnabled: row.briefingEnabled,
      briefingTime: row.briefingTime,
      aiProvider: ctx.config.ai.provider,
      aiEnabled: row.aiEnabled && ctx.ai !== null,
      sttProvider: ctx.config.stt.provider,
      ownerIds: ctx.config.telegram.ownerIds,
    }),
  };
};

const inbox: CommandHandler = async ({ ctx }) => {
  const captures = await listInbox(ctx.db, 25);
  return { text: formatCaptureList(captures, ctx.defaults.timeZone, 'Inbox — waiting for review') };
};

/**
 * `/undo` never deletes on its own: it shows what would be removed and waits for
 * the confirmation callback. Deleting straight from a command would make an
 * accidental send destructive.
 */
const undo: CommandHandler = async ({ ctx }) => {
  const [latest] = await listCaptures(ctx.db, { limit: 1, order: 'desc' });
  if (!latest) return { text: 'There is nothing to undo.' };
  const title = latest.links[0]?.title ?? latest.rawText;
  return {
    text: [
      'Undo the most recent capture?',
      '',
      `${latest.kind.toLowerCase()} · ${title.slice(0, 120)}`,
      '',
      'This removes it and anything created from it.',
    ].join('\n'),
    markup: undoConfirmButtons(latest.id),
  };
};

/** Reads the owner's time zone, creating the settings row when it is missing. */
async function timeZoneOf(ctx: AppContext): Promise<string> {
  const row = await getSettings(ctx.db, ctx.defaults);
  return row.timeZone;
}

const tasks: CommandHandler = async ({ ctx, args }) => {
  const now = ctx.clock.now();
  const includeFinished = args.trim().toLowerCase() === 'all';
  const open = await findTasks(
    ctx.db,
    {
      ...(includeFinished ? {} : { openOnly: true }),
      sort: includeFinished ? 'updatedAt' : 'dueAt',
      order: 'asc',
      limit: 25,
    },
    now,
  );
  const header = includeFinished ? 'All tasks' : 'Open tasks';
  return { text: formatTaskList(open, await timeZoneOf(ctx), header) };
};

const today: CommandHandler = async ({ ctx }) => {
  const now = ctx.clock.now();
  const timeZone = await timeZoneOf(ctx);
  const range = localDayRange(now, timeZone);
  const due = await findTasks(
    ctx.db,
    {
      status: ['PENDING', 'IN_PROGRESS'],
      dueAfter: range.startUtc,
      dueBefore: range.endUtc,
      sort: 'dueAt',
      order: 'asc',
      limit: 25,
    },
    now,
  );
  return { text: formatTaskList(due, timeZone, `Due today (${range.localDate})`) };
};

const overdue: CommandHandler = async ({ ctx }) => {
  const now = ctx.clock.now();
  const late = await findTasks(
    ctx.db,
    { overdueOnly: true, sort: 'dueAt', order: 'asc', limit: 25 },
    now,
  );
  return { text: formatTaskList(late, await timeZoneOf(ctx), 'Past due') };
};

const search: CommandHandler = async ({ ctx, args }) => {
  const term = args.trim();
  if (term.length === 0) {
    return { text: 'What should I look for? Send /search followed by some words.' };
  }
  const query: SearchQuery = searchQuerySchema.parse({
    q: term,
    limit: 10,
    sort: 'relevance',
    order: 'desc',
  });
  const response = await searchAll(ctx.db, query);
  return { text: formatSearchResults(response, `Search — "${term}"`) };
};

const ideas: CommandHandler = async ({ ctx, args }) => ({
  text: formatIdeaList(
    await findIdeas(ctx.db, {
      ...(args.trim().length > 0 ? { q: args.trim() } : {}),
      limit: 20,
      sort: 'createdAt',
      order: 'desc',
    }),
    await timeZoneOf(ctx),
    'Your ideas',
  ),
});

const notes: CommandHandler = async ({ ctx, args }) => ({
  text: formatNoteList(
    await findNotes(ctx.db, {
      ...(args.trim().length > 0 ? { q: args.trim() } : {}),
      limit: 20,
      sort: 'createdAt',
      order: 'desc',
    }),
    await timeZoneOf(ctx),
    'Your notes',
  ),
});

const projects: CommandHandler = async ({ ctx }) => ({
  text: formatProjectList(await listProjects(ctx.db, { limit: 50 }), 'Your projects'),
});

/** Commands that exist in the product plan but are not wired up yet. */
const NOT_YET: Record<string, string> = {
  reminders: 'Milestone 4',
  remind: 'Milestone 4',
  snooze: 'Milestone 4',
  cancel: 'Milestone 4',
  ask: 'Milestone 7',
};

export const COMMANDS: Record<string, CommandHandler> = {
  start: help,
  help,
  settings,
  inbox,
  undo,
  tasks,
  today,
  overdue,
  search,
  find: search,
  ideas,
  notes,
  projects,
};

export const NOT_YET_COMMANDS: Readonly<Record<string, string>> = NOT_YET;

/** Message for a command the product will have but does not have yet. */
export function formatNotYet(command: string, milestone: string): string {
  return `/${command} is not available yet — it arrives with ${milestone}. For now I can save anything you send, and /tasks, /today, /overdue, /search, /ideas, /notes, /projects, /inbox, /settings and /undo all work.`;
}

export function formatUnknownCommand(command: string): string {
  return `I do not know /${command}. Send /help to see what I can do.`;
}

/** Dispatches a parsed command, or explains why it did nothing. */
export async function runCommand(invocation: CommandInvocation): Promise<CommandReply> {
  const handler = COMMANDS[invocation.command];
  if (handler) return handler(invocation);
  const milestone = NOT_YET[invocation.command];
  if (milestone) return { text: formatNotYet(invocation.command, milestone) };
  return { text: formatUnknownCommand(invocation.command) };
}
