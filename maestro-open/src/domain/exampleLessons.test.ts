// Tests for the course-reference parser — the app's only content source. If this parser
// drifts (drops goals, mangles text, lets non-teaching lessons through), every session
// starts from bad input, so we pin the contract against the real markdown file.

import { describe, expect, it } from 'vitest';
import { exampleLessonBriefs, getExampleBriefById, pickRandomExampleBrief } from './exampleLessons';

describe('exampleLessonBriefs (parsed from the real reference file)', () => {
  it('parses exactly the 10 teachable concept lessons', () => {
    expect(exampleLessonBriefs).toHaveLength(10);
    expect(exampleLessonBriefs.map((b) => b.id)).toEqual([
      'w3-l1', 'w3-l2', 'w3-l3', 'w3-l4', 'w3-l5', 'w3-l6', 'w3-l7', 'w3-l8', 'w3-l9', 'w3-l10',
    ]);
  });

  it('excludes the Challenge and Review lessons (meta outcomes, not teachable)', () => {
    for (const b of exampleLessonBriefs) {
      expect(b.title).not.toMatch(/^(challenge|review)\b/i);
    }
  });

  it('every brief has a title, metadata, and at least one goal', () => {
    for (const b of exampleLessonBriefs) {
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.program).toBe('Masterschool Fellowship');
      expect(b.course).toBe('Week 3 — Decisions and Loops');
      expect(b.goals.length).toBeGreaterThanOrEqual(1);
      for (const g of b.goals) {
        expect(g.statement.length).toBeGreaterThan(10);
      }
    }
  });

  it('preserves goal text VERBATIM — backticked code tokens stay intact', () => {
    const logicalOps = exampleLessonBriefs.find((b) => b.id === 'w3-l2')!;
    expect(logicalOps.goals[0].statement).toBe(
      'Combine comparisons with `and`, `or`, and `not` to form compound conditions.',
    );
    const whileLesson = exampleLessonBriefs.find((b) => b.id === 'w3-l8')!;
    expect(whileLesson.title).toBe('Meet the `while` loop');
    expect(whileLesson.goals).toHaveLength(3);
  });

  it('goal ids are ordered g1..gN within each lesson', () => {
    for (const b of exampleLessonBriefs) {
      expect(b.goals.map((g) => g.id)).toEqual(b.goals.map((_, i) => `g${i + 1}`));
    }
  });
});

describe('pickRandomExampleBrief', () => {
  it('always returns one of the parsed briefs', () => {
    for (let i = 0; i < 50; i++) {
      expect(exampleLessonBriefs).toContain(pickRandomExampleBrief());
    }
  });
});

describe('getExampleBriefById', () => {
  it('returns the matching brief for a known id and undefined for an unknown one', () => {
    expect(getExampleBriefById('w3-l8')).toBe(exampleLessonBriefs.find((b) => b.id === 'w3-l8'));
    expect(getExampleBriefById('nope')).toBeUndefined();
  });
});
