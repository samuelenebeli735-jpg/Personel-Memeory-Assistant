import { describe, expect, it } from 'vitest';

import { createRuleClassifier, detectKind } from '../../src/ai/rules-classifier.js';
import type { ClassificationRequest } from '../../src/ai/types.js';

const TZ = 'Africa/Lagos';
const REFERENCE = new Date('2026-10-17T10:00:00.000Z'); // 11:00 local Saturday

const classifier = createRuleClassifier();

function classify(text: string, hint?: ClassificationRequest['hintKind']) {
  return classifier.classify({
    text,
    capturedAt: REFERENCE,
    referenceNow: REFERENCE,
    timeZone: TZ,
    morningDefaultTime: '09:00',
    eveningDefaultTime: '19:00',
    hintKind: hint ?? null,
  });
}

describe('deterministic kind detection', () => {
  it.each([
    ['I need to finish my project documentation tomorrow.', 'TASK'],
    ['Remind me to call someone at 4 PM.', 'TASK'],
    ['I have an idea for a website that helps students.', 'IDEA'],
    ['I should research PostgreSQL this weekend.', 'TASK'],
    ['Save this link for me: https://example.com/article', 'NOTE'],
    ['https://docs.example.com/guide', 'NOTE'],
    ['Dentist appointment on Tuesday at 10 AM', 'EVENT'],
    ['Meeting with the team tomorrow at 9am', 'EVENT'],
    ['The wifi password is on the fridge', 'OTHER'],
  ])('%j → %s', (text, expected) => {
    expect(detectKind(text).kind).toBe(expected);
  });

  it('never silently marks a question as actionable', () => {
    const result = classify('What were the things I wanted to do yesterday?');
    expect(result.kind).toBe('UNKNOWN');
    expect(result.needsReview).toBe(true);
    expect(result.dueAt).toBeNull();
  });

  it('lets the owner keep a question as a task when they choose the kind', () => {
    const result = classify('Is the dentist on Friday or Monday?', 'TASK');
    expect(result.kind).toBe('TASK');
    expect(result.needsReview).toBe(false);
    expect(result.title).toBeTruthy();
  });

  it('honours an explicit kind hint from a command', () => {
    const result = classify('Postgres full text search notes', 'IDEA');
    expect(result.kind).toBe('IDEA');
    expect(result.confidence).toBeGreaterThan(0.9);
  });
});

describe('field extraction', () => {
  it('extracts a due date from an explicit expression and keeps the raw text separate', () => {
    const result = classify('I need to finish my project documentation tomorrow.');
    expect(result.kind).toBe('TASK');
    // Date-only deadlines resolve to the end of the named local day.
    expect(result.dueAt).toBe('2026-10-18T22:59:59.999Z');
    expect(result.remindAt).toBeNull();
    expect(result.title).toMatch(/documentation/i);
    expect(result.title).not.toMatch(/tomorrow/i);
  });

  it('creates a reminder only when the user asked for one', () => {
    const withReminder = classify('Remind me to call someone at 4 PM.');
    expect(withReminder.remindAt).toBe('2026-10-17T15:00:00.000Z');

    const withoutReminder = classify('Finish the report at 4 PM');
    expect(withoutReminder.remindAt).toBeNull();
    expect(withoutReminder.dueAt).toBe('2026-10-17T15:00:00.000Z');
  });

  it('never invents a date when none was given', () => {
    const result = classify('I have an idea for a website that helps students.');
    expect(result.dueAt).toBeNull();
    expect(result.remindAt).toBeNull();
    expect(result.kind).toBe('IDEA');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('extracts inline tags and a category', () => {
    const result = classify('Pay the electricity bill #finance #home');
    expect(result.tags).toEqual(expect.arrayContaining(['finance', 'home']));
    expect(result.category).toBe('finance');
    expect(result.title).not.toContain('#finance');
  });

  it('detects priority words', () => {
    expect(classify('URGENT: submit the tax return').priority).toBe('URGENT');
    expect(classify('Someday learn to play the piano').priority).toBe('LOW');
    expect(classify('Buy cereal').priority).toBeNull();
  });

  it('keeps a URL in the description for link captures', () => {
    const result = classify('Save this link for me: https://example.com/post');
    expect(result.description).toContain('https://example.com/post');
  });

  it('reports an assumption when it fills in a vague time', () => {
    const result = classify('Take the bins out tomorrow morning');
    expect(result.rationale).toMatch(/09:00/);
    expect(result.needsReview).toBe(false);
  });

  it('lowers confidence and flags review when the time is ambiguous', () => {
    const result = classify('Something about the thing');
    expect(result.needsReview).toBe(true);
    expect(result.confidence).toBeLessThan(0.45);
  });

  it('never returns an empty title', () => {
    expect(classify('!').title).toBeTruthy();
  });
});
