// Tests for the token-overlap util. The fixtures are the LITERAL strings from the
// 2026-07-02 dev-panel traces — the exact duplicates/rephrases/drift the rails must catch,
// and the exact near-misses they must leave alone.

import { describe, expect, it } from 'vitest';
import {
  contentWords,
  jaccard,
  NEAR_DUPLICATE,
  overlapRatio,
  sharesContent,
  STALE_REPLY,
  stemmedJaccard,
  stemmedOverlapRatio,
  verbMaskedJaccard,
  WORD_SET_MATCH,
} from './overlap';

describe('contentWords', () => {
  it('keeps loop keywords — `while` and `for` are course content, not stopwords', () => {
    const w = contentWords('Identify when a `while` loop is suitable');
    expect(w.has('while')).toBe(true);
    expect(w.has('suitable')).toBe(true);
    expect(w.has('a')).toBe(false);
    expect(w.has('is')).toBe(false);
  });

  it('normalizes plurals and backticks so `loops` ≡ loop', () => {
    const w = contentWords('Compare `while` loops with for loops');
    expect(w.has('loop')).toBe(true);
    expect(w.has('loops')).toBe(false);
  });

  it('BACKTICKED operators bypass the stopword filter — they are code, not English', () => {
    expect(contentWords('combine conditions using `and`').has('and')).toBe(true);
    expect(contentWords('negate conditions using `not`').has('not')).toBe(true);
    expect(contentWords('check with `==` first').has('==')).toBe(true);
    // …but PLAIN-ENGLISH stopwords are still dropped.
    expect(contentWords('loops and conditions').has('and')).toBe(false);
  });

  it('operator-only distinctions survive the strict dedupe tier (the thrice-lost and/or split)', () => {
    const a = 'Create logical statements that use `and` to combine conditions';
    const b = 'Create logical statements that use `or` to combine conditions';
    expect(jaccard(a, b)).toBeLessThan(WORD_SET_MATCH);
  });
});

describe('overlapRatio (containment — coverage-audit guards)', () => {
  it('flags the trace duplicates: singular/plural restatements of the same step', () => {
    const a = 'Identify when `while` loops are suitable';
    const b = 'Identify when a `while` loop is suitable';
    expect(overlapRatio(a, b)).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
  });

  it('sees a wordwise-subset as fully contained (right for "is this missing part already covered?")', () => {
    const a = 'Understand the risk of infinite loops';
    const b = 'Understand the risk of infinite loops and explain how to prevent them';
    expect(overlapRatio(a, b)).toBe(1);
  });

  it('does NOT flag the distinct condition steps from the trace', () => {
    const a = "Identify the condition that controls the loop's repetition";
    const b = "Explain how the condition affects the loop's behavior";
    expect(overlapRatio(a, b)).toBeLessThan(NEAR_DUPLICATE);
  });
});

describe('jaccard (symmetric — parent-rephrase rejection)', () => {
  it('flags the trace rephrase: a child identical to its parent', () => {
    const parent = 'Define what a `while` loop is.';
    const child = 'Define what a `while` loop is';
    expect(jaccard(child, parent)).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
  });

  it('does NOT flag a genuinely narrower child inside a long parent (containment would)', () => {
    const parent = 'Understand when to exit a loop early with `break`.';
    const child = 'understand break';
    expect(overlapRatio(child, parent)).toBe(1); // containment says "same"
    expect(jaccard(child, parent)).toBeLessThan(NEAR_DUPLICATE); // jaccard says "narrower"
  });

  it('does NOT flag a real split from the trace', () => {
    const parent = 'Explain the purpose and structure of a `while` loop.';
    const child = 'Break down the components of a `while` loop.';
    expect(jaccard(child, parent)).toBeLessThan(NEAR_DUPLICATE);
  });
});

describe('WORD_SET_MATCH tier (sub-goal dedupe)', () => {
  it('word-swapped duplicates from the if/else trace are the same word set', () => {
    const a = 'Explain the difference between assignment and equality in programming';
    const b = 'Explain the difference between equality and assignment in programming';
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(WORD_SET_MATCH);
  });

  it('progressive range() variants from the for-loops trace are NOT the same word set', () => {
    const stop = 'Demonstrate range with stop parameter';
    const startStop = 'Demonstrate range with start and stop parameters';
    const startStopStep = 'Demonstrate range with start, stop and step parameters';
    expect(jaccard(stop, startStop)).toBeLessThan(WORD_SET_MATCH);
    expect(jaccard(startStop, startStopStep)).toBeLessThan(WORD_SET_MATCH);
    // …even though containment calls the shorter one fully contained:
    expect(overlapRatio(stop, startStopStep)).toBe(1);
  });
});

describe('verbMaskedJaccard (setup-verb-swapped duplicates — the counters trace)', () => {
  it('flags the trace duplicates the plain tiers missed: same nouns, swapped setup verbs', () => {
    const a = 'create a variable named counter and assign it a initial value';
    const b = 'assign an initial value to the counter variable';
    expect(jaccard(a, b)).toBeLessThan(NEAR_DUPLICATE); // why every plain tier missed it live
    expect(verbMaskedJaccard(a, b)).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
  });

  it('returns 0 for progressive range() variants — no setup verbs, so the 0.8 would be real nouns', () => {
    expect(
      verbMaskedJaccard(
        'Demonstrate range with stop parameter',
        'Demonstrate range with start and stop parameters',
      ),
    ).toBe(0);
  });

  it('returns 0 when backticked code tokens differ (the thrice-lost and/or split must survive)', () => {
    const a = 'Create logical statements that use `and` to combine conditions';
    const b = 'Create logical statements that use `or` to combine conditions';
    expect(verbMaskedJaccard(a, b)).toBe(0);
  });

  it('returns 0 when only one side has a setup verb (create vs update is a real progression)', () => {
    expect(verbMaskedJaccard('create a counter variable', 'update the counter variable')).toBe(0);
  });

  it('returns 0 when digit tokens differ — the for-loops trace regression (range variants both start with "create")', () => {
    const a = 'create a for loop that iterates over the range from 0 to stop-1';
    const b = 'create a for loop that iterates over the range from start to stop-1';
    expect(verbMaskedJaccard(a, b)).toBe(0); // digits {0,1} vs {1}: parameters, a real distinction
  });
});

describe('digit handling in contentWords', () => {
  it('pure-digit tokens are never content — per-number "splits" collapse as word-identical', () => {
    expect(contentWords('create a range that includes 10').has('10')).toBe(false);
    // The live leak: 0-8 collapsed (single chars) but "includes 10" survived as a milestone.
    expect(jaccard('create a range that includes 0', 'create a range that includes 10')).toBe(1);
  });
});

describe('stemmed tiers (inflection-tolerant, low-stakes decisions only)', () => {
  it('stemmedOverlapRatio matches inflection variants — "initialize" ≈ "initial value" (coverage audit)', () => {
    const req = 'initialize the counter';
    const step = 'assign an initial value to the counter variable';
    expect(overlapRatio(req, step)).toBeLessThan(NEAR_DUPLICATE); // why the unstemmed tier is not enough
    expect(stemmedOverlapRatio(req, step)).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
  });

  it('a requirement the steps genuinely miss stays below the covered threshold', () => {
    // The live loss: "update the counter …" must NOT look covered by the running-total step.
    expect(
      stemmedOverlapRatio('update the counter inside the loop', 'update the running total inside the loop'),
    ).toBeLessThan(NEAR_DUPLICATE);
  });

  it('STALE_REPLY: the live circular turn scores as repetition; a fresh example does not', () => {
    const prev =
      "Let's see — if we start with 0 and add 2 each time, the total would go 0, 2, 4, 6, and so on. What do you think would happen if we started at 5 instead?";
    const circular =
      "What if we started at 5 and added 2 each time? Let's see — 5, 7, 9... What do you think would happen if we started at 0 instead?";
    const fresh =
      'Not quite — picture a piggy bank: every coin drops in and changes the total, like total = total + coin. If total is 5 and the coin is 3, what is total now?';
    expect(stemmedJaccard(circular, prev)).toBeGreaterThanOrEqual(STALE_REPLY);
    expect(stemmedJaccard(fresh, prev)).toBeLessThan(STALE_REPLY);
  });
});

describe('sharesContent (transition on-topic check)', () => {
  it('a reply about the milestone shares content', () => {
    expect(
      sharesContent('Now, about infinite loops — what stops one?', 'Understand the risk of infinite loops'),
    ).toBe(true);
  });

  it('total drift shares nothing', () => {
    expect(sharesContent('Let me explain this idea. What do you think it means?', 'Prevent infinite loops.')).toBe(
      false,
    );
  });

  it('the OBSERVED drift (while-vs-for question on the components milestone) passes the check — the imperative prompt is the primary defense there', () => {
    // Documented limitation: the rail catches TOTAL drift only.
    expect(
      sharesContent(
        "You're right! Now, what's the difference between a `while` loop and a `for` loop?",
        'Break down the components of a `while` loop.',
      ),
    ).toBe(true);
  });
});
