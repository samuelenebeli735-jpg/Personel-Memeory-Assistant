/**
 * Ask grounding — unit level.
 *
 * These tests pin the rules that make an answer trustworthy without touching
 * the database: which citations survive, which statements of an answer are
 * supported by the cited evidence, and what the deterministic fallback says.
 */
import { describe, expect, it } from 'vitest';

import type { EvidenceRecord } from '../../src/ai/types.js';
import {
  clocksIn,
  dateVocabulary,
  deterministicAnswer,
  groundAnswer,
  localWhen,
  NO_EVIDENCE_ANSWER,
  queryVariants,
  splitClaims,
  validateCitations,
} from '../../src/services/ask-service.js';
import type { SearchResultItem } from '@recall/shared';

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    type: 'TASK',
    id: 'task-1',
    title: 'Call the plumber',
    snippet: 'The plumber is booked for tomorrow morning',
    timestamp: '2026-10-17T09:00:00.000Z',
    status: 'PENDING',
    ...overrides,
  };
}

function searchItem(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    type: 'TASK',
    id: 'task-1',
    title: 'Call the plumber',
    snippet: 'The plumber is booked for tomorrow morning',
    timestamp: '2026-10-17T09:00:00.000Z',
    matchedOn: ['title'],
    ...overrides,
  };
}

describe('splitClaims', () => {
  it('splits an answer into statements', () => {
    expect(splitClaims('One thing. Another thing! A third?')).toEqual([
      'One thing.',
      'Another thing!',
      'A third?',
    ]);
  });

  it('ignores blank statements', () => {
    expect(splitClaims('  \n\n  ')).toEqual([]);
  });
});

describe('queryVariants', () => {
  it('drops the filler words of a natural question', () => {
    expect(queryVariants('what did I say about tiles')).toEqual(['say tiles', 'say', 'tiles']);
  });

  it('keeps a single-word question as one query', () => {
    expect(queryVariants('plumber')).toEqual(['plumber']);
  });

  it('keeps words that carry content even when they are short', () => {
    expect(queryVariants('tax return')).toEqual(['tax return', 'tax', 'return']);
  });

  it('keeps two-letter content words such as AI and ID', () => {
    expect(queryVariants('what did I say about AI')).toEqual(['say ai', 'say', 'ai']);
    expect(queryVariants('find my ID')).toEqual(['find id', 'find', 'id']);
  });

  it('falls back to the raw question when every word is filler', () => {
    expect(queryVariants('what is it')).toEqual(['what is it']);
  });

  it('returns nothing for an empty question', () => {
    expect(queryVariants('   ')).toEqual([]);
  });

  it('keeps the order of the content words', () => {
    expect(queryVariants('when did the plumber call happen')).toEqual([
      'plumber call happen',
      'plumber',
      'call',
      'happen',
    ]);
  });
});

describe('validateCitations', () => {
  const items = [searchItem({ id: 'a' }), searchItem({ id: 'b' })];

  it('keeps ids that are part of the evidence', () => {
    expect(validateCitations(['a', 'b'], items)).toEqual(['a', 'b']);
  });

  it('drops invented ids', () => {
    expect(validateCitations(['a', 'made-up'], items)).toEqual(['a']);
  });

  it('drops duplicates and non-strings', () => {
    expect(validateCitations(['a', 'a', 42, null, 'b'], items)).toEqual(['a', 'b']);
  });

  it('returns nothing when the provider cites nothing usable', () => {
    expect(validateCitations(undefined, items)).toEqual([]);
    expect(validateCitations([], items)).toEqual([]);
  });
});

describe('groundAnswer: reporting and framing words (R4-03 live finding)', () => {
  const ink = evidence({
    type: 'CAPTURE',
    id: 'cap-1',
    title: 'Buy blue printer ink from the stationery shop',
    snippet: 'Buy blue printer ink from the stationery shop',
  });

  it('keeps the exact live Gemini answer that used to be dropped', () => {
    const answer = 'You noted to buy blue printer ink from the stationery shop.';
    const result = groundAnswer(answer, [ink]);
    expect(result.dropped).toEqual([]);
    expect(result.answer).toBe(answer);
  });

  it('keeps other ordinary framing of a supported fact', () => {
    for (const answer of [
      'You said to buy blue printer ink.',
      'You mentioned blue printer ink from the stationery shop.',
      'You wrote: buy blue printer ink from the stationery shop.',
      'According to your records, you should buy blue printer ink.',
      'Your records indicate you will buy printer ink.',
      'You recorded that you should buy printer ink from the stationery shop.',
    ]) {
      const result = groundAnswer(answer, [ink]);
      expect(result.dropped, answer).toEqual([]);
      expect(result.answer, answer).toBe(answer);
    }
  });

  it('still rejects unsupported details hidden behind a framing verb', () => {
    for (const answer of [
      'You noted to buy red printer ink.', // wrong colour
      'You said to buy 3 cartridges of printer ink.', // number and item not in the record
      'You mentioned buying printer ink on Friday.', // a day the record does not state
      'You wrote that Ada will buy the printer ink.', // a person who is not in the record
      'According to your records, the shop is closed.', // a claim the record does not make
      'You noted not to buy printer ink.', // a negation the record does not contain
    ]) {
      const result = groundAnswer(answer, [ink]);
      expect(result.supported, answer).toEqual([]);
      expect(result.dropped, answer).toEqual([answer]);
    }
  });

  it('still drops a statement made only of framing words', () => {
    for (const answer of ['You noted it.', 'As you said.', 'According to your records.']) {
      expect(groundAnswer(answer, [ink]).supported, answer).toEqual([]);
    }
  });

  it('still requires citations: with nothing cited, a framed statement is dropped', () => {
    expect(groundAnswer('You noted to buy blue printer ink.', []).supported).toEqual([]);
  });
});

describe('groundAnswer', () => {
  it('keeps a statement the evidence supports', () => {
    const result = groundAnswer('The plumber is booked for tomorrow morning.', [evidence()]);
    expect(result.supported).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
    expect(result.answer).toBe('The plumber is booked for tomorrow morning.');
  });

  it('removes a statement the evidence does not support', () => {
    const result = groundAnswer('The house is on fire.', [evidence()]);
    expect(result.supported).toHaveLength(0);
    expect(result.dropped).toEqual(['The house is on fire.']);
    expect(result.answer).toBe('');
  });

  it('keeps the supported part of a mixed answer', () => {
    const result = groundAnswer(
      'The plumber is booked for tomorrow morning. The house is on fire.',
      [evidence()],
    );
    expect(result.supported).toHaveLength(1);
    expect(result.dropped).toEqual(['The house is on fire.']);
    expect(result.answer).toBe('The plumber is booked for tomorrow morning.');
  });

  it('removes a number that is not in the evidence', () => {
    const result = groundAnswer('You have 3 plumber appointments.', [evidence()]);
    expect(result.supported).toHaveLength(0);
  });

  it('keeps a number that is in the evidence', () => {
    const result = groundAnswer('The plumber quoted 3 hundred.', [
      evidence({ snippet: 'The plumber quoted 3 hundred for the repair' }),
    ]);
    expect(result.supported).toHaveLength(1);
  });

  it('does not match a number inside a longer number', () => {
    const result = groundAnswer('The plumber quoted 3 hundred.', [
      evidence({ snippet: 'The plumber quoted 13 hundred for the repair' }),
    ]);
    expect(result.supported).toHaveLength(0);
  });

  it('removes a negation the evidence does not contain', () => {
    const result = groundAnswer('The plumber is not coming.', [evidence()]);
    expect(result.supported).toHaveLength(0);
  });

  it('keeps a negation the evidence contains', () => {
    const result = groundAnswer('There is no plumber appointment.', [
      evidence({ snippet: 'no plumber appointment is booked' }),
    ]);
    expect(result.supported).toHaveLength(1);
  });

  it('removes a contraction-based negation', () => {
    const result = groundAnswer("The plumber isn't coming.", [evidence()]);
    expect(result.supported).toHaveLength(0);
  });

  it('removes a statement with nothing checkable in it', () => {
    const result = groundAnswer('Okay.', [evidence()]);
    expect(result.supported).toHaveLength(0);
  });

  it('removes every statement when nothing is cited', () => {
    const result = groundAnswer('The plumber is booked for tomorrow morning.', []);
    expect(result.supported).toHaveLength(0);
  });

  it('supports a word that only differs by its plural', () => {
    const result = groundAnswer('The invoices are late.', [
      evidence({ snippet: 'The invoice from March is late' }),
    ]);
    expect(result.supported).toHaveLength(1);
  });
});

describe('deterministicAnswer', () => {
  it('refuses when there is no evidence', () => {
    expect(deterministicAnswer([])).toBe(NO_EVIDENCE_ANSWER);
  });

  it('names the records it found', () => {
    const answer = deterministicAnswer([
      searchItem({ id: 'a', type: 'TASK', title: 'Call the plumber' }),
      searchItem({ id: 'b', type: 'NOTE', title: 'Budget notes' }),
    ]);
    expect(answer).toContain('2 relevant records');
    expect(answer).toContain('TASK: Call the plumber');
    expect(answer).toContain('NOTE: Budget notes');
  });

  it('uses the singular for one record', () => {
    const answer = deterministicAnswer([searchItem({ id: 'a' })]);
    expect(answer).toContain('1 relevant record:');
  });
});

describe('local dates in grounding (R1-03)', () => {
  // 2026-10-21T08:00Z is Wednesday 09:00 in Lagos and 04:00 in New York.
  const dentist: EvidenceRecord = {
    type: 'EVENT',
    id: 'e1',
    title: 'Dentist appointment',
    snippet: 'Dentist appointment',
    timestamp: '2026-10-21T08:00:00.000Z',
    status: null,
  };
  const lagos = { timeZone: 'Africa/Lagos', now: new Date('2026-10-20T10:00:00.000Z') };

  it('renders a record time in the owner zone', () => {
    expect(localWhen('2026-10-21T08:00:00.000Z', 'Africa/Lagos')).toBe('Wed 21 Oct 2026, 09:00');
    expect(localWhen('2026-10-21T08:00:00.000Z', 'America/New_York')).toBe('Wed 21 Oct 2026, 04:00');
  });

  it('lists the forms an answer may use for that time, including the relative day', () => {
    const words = dateVocabulary('2026-10-21T08:00:00.000Z', 'Africa/Lagos', lagos.now);
    for (const form of ['Wednesday', 'Oct', 'October', '21st', '2026-10-21', '09:00', '9am', 'tomorrow']) {
      expect(words).toContain(form);
    }
  });

  it('keeps date statements that match the cited record and drops others', () => {
    const answer =
      'Your dentist appointment is tomorrow at 9am. It is on 21 October 2026. It is on 22 October. It is at 10:00.';
    const result = groundAnswer(answer, [dentist], lagos);
    expect(result.supported).toEqual([
      'Your dentist appointment is tomorrow at 9am.',
      'It is on 21 October 2026.',
    ]);
    expect(result.dropped).toEqual(['It is on 22 October.', 'It is at 10:00.']);
  });

  it('uses the owner zone, so the Lagos time is wrong for a New York owner', () => {
    const result = groundAnswer('The dentist appointment is at 9am.', [dentist], { timeZone: 'America/New_York' });
    expect(result.supported).toEqual([]);
  });

  it('still drops every date without a zone (the pre-R1-03 behaviour)', () => {
    expect(groundAnswer('The dentist appointment is at 9am.', [dentist]).supported).toEqual([]);
  });

  it('adds the local time to the deterministic summary when a zone is known', () => {
    const item: SearchResultItem = { ...dentist, status: undefined, matchedOn: ['title'] } as SearchResultItem;
    expect(deterministicAnswer([item], 'Africa/Lagos')).toContain('Dentist appointment (Wed 21 Oct 2026, 09:00)');
    expect(deterministicAnswer([item])).not.toContain('2026');
  });
});

describe('clocksIn', () => {
  it('normalises every common clock form to 24-hour HH:MM and ignores dates', () => {
    expect(clocksIn('at 9am, 9:00 pm, 21:00, 12am and 12 pm on 2026-10-21')).toEqual([
      '09:00',
      '21:00',
      '21:00',
      '00:00',
      '12:00',
    ]);
  });
});
