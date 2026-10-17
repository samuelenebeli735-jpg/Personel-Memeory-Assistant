/**
 * Owner settings. Exactly one row exists (`id = "singleton"`); it is created on
 * first access from the validated environment configuration so the database is
 * never seeded with invented personal data.
 */
import type { SettingsDto, SettingsUpdateInput } from '@recall/shared';
import { DEFAULT_TIME_ZONE } from '@recall/shared';

import type { AppConfig, RuntimeCapabilities } from '../config/env.js';
import type { Db } from '../db/client.js';
import { ValidationError } from '../lib/errors.js';
import { isValidTimeZone } from '../lib/time.js';

export const SETTINGS_ID = 'singleton';

const DEFAULT_SECTIONS = ['today', 'overdue', 'upcoming'];

export type SettingsRow = {
  id: string;
  displayName: string | null;
  timeZone: string;
  morningDefaultTime: string;
  eveningDefaultTime: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  maxNotificationsPerDay: number;
  briefingEnabled: boolean;
  briefingTime: string;
  briefingSections: string;
  reminderOverdueGraceHours: number;
  aiEnabled: boolean;
  locale: string;
  createdAt: Date;
  updatedAt: Date;
};

export interface SettingsDefaults {
  timeZone: string;
  morningDefaultTime: string;
  eveningDefaultTime: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  maxNotificationsPerDay: number;
  briefingEnabled: boolean;
  briefingTime: string;
  reminderOverdueGraceHours: number;
  locale: string;
}

export function settingsDefaultsFromConfig(config: AppConfig): SettingsDefaults {
  return {
    timeZone: config.locale.timeZone || DEFAULT_TIME_ZONE,
    morningDefaultTime: config.locale.morningDefaultTime,
    eveningDefaultTime: config.locale.eveningDefaultTime,
    quietHoursStart: config.locale.quietHoursStart,
    quietHoursEnd: config.locale.quietHoursEnd,
    maxNotificationsPerDay: config.locale.maxNotificationsPerDay,
    briefingEnabled: config.locale.briefingEnabled,
    briefingTime: config.locale.briefingTime,
    reminderOverdueGraceHours: config.locale.reminderOverdueGraceHours,
    locale: 'en',
  };
}

export function parseBriefingSections(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) return parsed;
  } catch {
    /* fall through to default */
  }
  return [...DEFAULT_SECTIONS];
}

/** Reads the singleton row, creating it (from config defaults) when absent. */
export async function getSettings(db: Db, defaults: SettingsDefaults): Promise<SettingsRow> {
  const existing = await db.userSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (existing) return existing as SettingsRow;
  const created = await db.userSettings.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: {
      id: SETTINGS_ID,
      timeZone: defaults.timeZone,
      morningDefaultTime: defaults.morningDefaultTime,
      eveningDefaultTime: defaults.eveningDefaultTime,
      quietHoursStart: defaults.quietHoursStart,
      quietHoursEnd: defaults.quietHoursEnd,
      maxNotificationsPerDay: defaults.maxNotificationsPerDay,
      briefingEnabled: defaults.briefingEnabled,
      briefingTime: defaults.briefingTime,
      briefingSections: JSON.stringify(DEFAULT_SECTIONS),
      reminderOverdueGraceHours: defaults.reminderOverdueGraceHours,
      locale: defaults.locale,
    },
  });
  return created as SettingsRow;
}

export async function updateSettings(
  db: Db,
  patch: SettingsUpdateInput,
  defaults: SettingsDefaults,
): Promise<SettingsRow> {
  await getSettings(db, defaults);

  if (patch.timeZone !== undefined && !isValidTimeZone(patch.timeZone)) {
    throw new ValidationError(`Unknown time zone: ${patch.timeZone}`);
  }
  if ((patch.quietHoursStart === null) !== (patch.quietHoursEnd === null)) {
    throw new ValidationError('quietHoursStart and quietHoursEnd must be set together');
  }

  const data: Record<string, unknown> = {};
  const assign = <K extends keyof SettingsUpdateInput>(key: K) => {
    if (patch[key] !== undefined) data[key] = patch[key];
  };
  assign('displayName');
  assign('timeZone');
  assign('morningDefaultTime');
  assign('eveningDefaultTime');
  assign('quietHoursStart');
  assign('quietHoursEnd');
  assign('maxNotificationsPerDay');
  assign('briefingEnabled');
  assign('briefingTime');
  assign('reminderOverdueGraceHours');
  assign('aiEnabled');
  assign('locale');
  if (patch.briefingSections !== undefined) {
    data.briefingSections = JSON.stringify(patch.briefingSections);
  }

  const updated = await db.userSettings.update({ where: { id: SETTINGS_ID }, data });
  return updated as SettingsRow;
}

export function toSettingsDto(
  row: SettingsRow,
  capabilities: RuntimeCapabilities,
  ownerIds: readonly string[] = [],
): SettingsDto {
  return {
    displayName: row.displayName,
    timeZone: row.timeZone,
    morningDefaultTime: row.morningDefaultTime,
    eveningDefaultTime: row.eveningDefaultTime,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    maxNotificationsPerDay: row.maxNotificationsPerDay,
    briefingEnabled: row.briefingEnabled,
    briefingTime: row.briefingTime,
    briefingSections: parseBriefingSections(row.briefingSections),
    reminderOverdueGraceHours: row.reminderOverdueGraceHours,
    aiEnabled: row.aiEnabled,
    locale: row.locale,
    telegramOwnerConfigured: ownerIds.length > 0,
    aiProviderConfigured: capabilities.aiEnabled,
    sttProviderConfigured: capabilities.sttEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}
