/**
 * Briefing service — unit level.
 *
 * These tests pin the rules that make a briefing trustworthy without touching
 * the database: which sections exist, in which order, how a date is resolved
 * in the owner's zone, and what the rendered message may claim.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BRIEFING_SECTIONS,
  formatBriefingSummary,
  formatBriefingText,
  normalizeSectionIds,
  parseBriefingDate,
  type BriefingData,
  type BriefingSection,
} from '../../src/services/briefing-service.js';

function section(id: BriefingSection['id'], count: number): BriefingSection {
  return {
    id,
    title: id.charAt(0).toUpperCase() + id.slice(1),
    items: Array.from({ length: count }, (_, index) => ({
      type: 'TASK' as const,
      id: `${id}-${index}`,
      title: `Item ${index + 1}`,
      snippet: 'A snippet',
      timestamp: '2026-10-17T09:00:00.000Z',
      status: 'PENDING',
    })),
  };
}

describe('normalizeSectionIds', () => {
  it('keeps the configured order', () => {
    expect(normalizeSectionIds(['upcoming', 'today'])).toEqual(['upcoming', 'today']);
  });

  it('drops unknown ids', () => {
    expect(normalizeSectionIds(['today', 'not-a-section'])).toEqual(['today']);
  });

  it('drops duplicates', () => {
    expect(normalizeSectionIds(['today', 'today'])).toEqual(['today']);
  });

  it('normalises case and whitespace', () => {
    expect(normalizeSectionIds([' TODAY ', 'Ideas'])).toEqual(['today', 'ideas']);
  });

  it('falls back to the default sections when nothing usable is configured', () => {
    expect(normalizeSectionIds([])).toEqual([...DEFAULT_BRIEFING_SECTIONS]);
    expect(normalizeSectionIds(undefined)).toEqual([...DEFAULT_BRIEFING_SECTIONS]);
    expect(normalizeSectionIds(null)).toEqual([...DEFAULT_BRIEFING_SECTIONS]);
    expect(normalizeSectionIds(['nonsense'])).toEqual([...DEFAULT_BRIEFING_SECTIONS]);
  });
});

describe('parseBriefingDate', () => {
  it('resolves a calendar date to local midnight in the owner zone', () => {
    const instant = parseBriefingDate('2026-10-17', 'Africa/Lagos');
    expect(instant).not.toBeNull();
    // Lagos is UTC+1 year round: local midnight is 23:00 UTC the day before.
    expect(instant!.toISOString()).toBe('2026-10-16T23:00:00.000Z');
  });

  it('resolves the same date differently in a different zone', () => {
    const lagos = parseBriefingDate('2026-10-17', 'Africa/Lagos');
    const utc = parseBriefingDate('2026-10-17', 'UTC');
    expect(lagos!.toISOString()).not.toBe(utc!.toISOString());
    expect(utc!.toISOString()).toBe('2026-10-17T00:00:00.000Z');
  });

  it('returns null when no date is given', () => {
    expect(parseBriefingDate(undefined, 'UTC')).toBeNull();
    expect(parseBriefingDate(null, 'UTC')).toBeNull();
    expect(parseBriefingDate('   ', 'UTC')).toBeNull();
  });

  it('rejects a value that is not a calendar date', () => {
    expect(parseBriefingDate('17-10-2026', 'UTC')).toBeNull();
    expect(parseBriefingDate('2026-10-17T10:00', 'UTC')).toBeNull();
    expect(parseBriefingDate('today', 'UTC')).toBeNull();
    expect(parseBriefingDate('2026/10/17', 'UTC')).toBeNull();
  });

  it('rejects a date that does not exist', () => {
    expect(parseBriefingDate('2026-13-01', 'UTC')).toBeNull();
    expect(parseBriefingDate('2026-02-30', 'UTC')).toBeNull();
  });
});

describe('formatBriefingSummary', () => {
  it('says so plainly when there is nothing to report', () => {
    expect(formatBriefingSummary([section('today', 0), section('overdue', 0)])).toBe(
      'Nothing scheduled for this day.',
    );
  });

  it('counts the items of every non-empty section', () => {
    const summary = formatBriefingSummary([section('today', 2), section('overdue', 1)]);
    expect(summary).toBe('3 items: Today 2, Overdue 1.');
  });

  it('uses the singular for a single item', () => {
    expect(formatBriefingSummary([section('today', 1)])).toBe('1 item: Today 1.');
  });
});

describe('formatBriefingText', () => {
  const data: BriefingData = {
    date: '2026-10-17',
    timeZone: 'Africa/Lagos',
    sections: [section('today', 1), section('overdue', 0)],
    summary: '1 item: Today 1.',
    itemCount: 1,
  };

  it('starts with the date and the summary', () => {
    const text = formatBriefingText(data);
    expect(text.split('\n')[0]).toBe('Daily briefing — 2026-10-17');
    expect(text).toContain('1 item: Today 1.');
  });

  it('lists the items of a section that has content', () => {
    const text = formatBriefingText(data);
    expect(text).toContain('Today');
    expect(text).toContain('• Item 1');
  });

  it('omits a section that has no items', () => {
    const text = formatBriefingText(data);
    expect(text).not.toContain('Overdue');
  });

  it('shows the local time of a task', () => {
    const text = formatBriefingText(data);
    // 2026-10-17T09:00:00Z is 10:00 in Lagos (UTC+1).
    expect(text).toContain('Sat 17 Oct, 10:00 AM');
  });

  it('adds nothing that is not in the sections', () => {
    const text = formatBriefingText(data);
    const bullets = text.split('\n').filter((line) => line.startsWith('•'));
    expect(bullets).toHaveLength(1);
  });
});
