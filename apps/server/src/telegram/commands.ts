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
import type { AppContext } from '../context.js';
import { listCaptures, listInbox } from '../services/capture-service.js';
import { getSettings } from '../services/settings-service.js';
import type { ReplyMarkup } from './client.js';
import {
  formatCaptureList,
  formatHelp,
  formatSettingsSummary,
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

/** Commands that exist in the product plan but are not wired up yet. */
const NOT_YET: Record<string, string> = {
  today: 'Milestone 3',
  overdue: 'Milestone 3',
  tasks: 'Milestone 3',
  search: 'Milestone 3',
  find: 'Milestone 3',
  ideas: 'Milestone 3',
  notes: 'Milestone 3',
  projects: 'Milestone 3',
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
};

export const NOT_YET_COMMANDS: Readonly<Record<string, string>> = NOT_YET;

/** Message for a command the product will have but does not have yet. */
export function formatNotYet(command: string, milestone: string): string {
  return `/${command} is not available yet — it arrives with ${milestone}. For now I can save anything you send, plus /help, /inbox, /settings and /undo.`;
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
