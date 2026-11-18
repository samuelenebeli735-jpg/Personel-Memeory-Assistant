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
  deterministicAnswer,
  groundAnswer,
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
