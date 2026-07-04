// Tests for the free-text salvage parsers — the single most safety-critical deterministic
// code in the engine: every advance/trap decision flows through parseAchieved, and every
// plan/suggestion through extractJson/parseStringList. (See weak-spot #3: fragile parsing
// → false advances / false traps.)

import { describe, expect, it } from 'vitest';
import { extractJson, parseAchieved, parseStringList } from './json';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('repairs full-width commas (the model drifted into a CJK ， mid-JSON, observed live)', () => {
    expect(extractJson('{"a": 1，"b": 2}')).toEqual({ a: 1, b: 2 });
  });

  it('parses a bare JSON array', () => {
    expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"achieved": true}\n```')).toEqual({ achieved: true });
  });

  it('finds the first balanced object inside surrounding prose', () => {
    expect(extractJson('Sure! Here is the JSON: {"x": "y"} — hope that helps.')).toEqual({ x: 'y' });
  });

  it('handles nested objects', () => {
    expect(extractJson('{"a": {"b": [1, {"c": 2}]}}')).toEqual({ a: { b: [1, { c: 2 }] } });
  });

  it('is not fooled by braces inside string values', () => {
    expect(extractJson('{"s": "a } b { c"}')).toEqual({ s: 'a } b { c' });
  });

  it('is not fooled by escaped quotes inside strings', () => {
    expect(extractJson('{"s": "say \\"hi\\" now"}')).toEqual({ s: 'say "hi" now' });
  });

  it('returns null for prose with no JSON', () => {
    expect(extractJson('The student seems to understand loops quite well.')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractJson('')).toBeNull();
  });

  // ── small-model repair path (only runs after strict parsing fails) ─────────────
  it('repairs trailing commas', () => {
    expect(extractJson('{"achieved": false, "evidence": "none",}')).toEqual({ achieved: false, evidence: 'none' });
  });

  it('repairs unquoted keys', () => {
    expect(extractJson('{achieved: true, evidence: "said it"}')).toEqual({ achieved: true, evidence: 'said it' });
  });

  it('repairs single-quoted keys and values', () => {
    expect(extractJson("{'achieved': true, 'evidence': 'quoted'}")).toEqual({ achieved: true, evidence: 'quoted' });
  });

  it('repairs Python-style literals', () => {
    expect(extractJson('{"achieved": True, "evidence": None}')).toEqual({ achieved: true, evidence: null });
  });

  it('recovers a truncated object (generation cut off by max_tokens)', () => {
    expect(extractJson('{"a": 1')).toEqual({ a: 1 });
    expect(extractJson('{"achieved": true, "evidence": "the student expl')).toEqual({
      achieved: true,
      evidence: 'the student expl',
    });
  });

  it('recovers a truncated array of objects', () => {
    expect(extractJson('{"alsoAchieved": [{"id": "m3", "evidence": "wrote a loo')).toEqual({
      alsoAchieved: [{ id: 'm3', evidence: 'wrote a loo' }],
    });
  });
});

describe('parseStringList', () => {
  it('parses a JSON array of strings', () => {
    expect(parseStringList('["a", "b", "c", "d"]')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('parses plain one-per-line output', () => {
    expect(parseStringList('First option\nSecond option')).toEqual(['First option', 'Second option']);
  });

  it('strips numbering and bullets', () => {
    expect(parseStringList('1. It repeats\n- Show me\n• Not sure')).toEqual(['It repeats', 'Show me', 'Not sure']);
  });

  it('strips wrapping quotes and trailing commas', () => {
    expect(parseStringList('"Maybe it loops?",\n\'I am lost\'')).toEqual(['Maybe it loops?', 'I am lost']);
  });

  it('skips header/preamble lines ending with a colon', () => {
    expect(parseStringList('Here are 4 options:\nOption one\nOption two')).toEqual(['Option one', 'Option two']);
  });

  it('REGRESSION: a trailing backtick is content, not a wrapper — keep it verbatim', () => {
    expect(parseStringList('Understand `break`\nUse `continue` to skip')).toEqual([
      'Understand `break`',
      'Use `continue` to skip',
    ]);
  });

  it('still strips a true wrapping backtick pair', () => {
    expect(parseStringList('`wrapped in code ticks`\nplain line')).toEqual(['wrapped in code ticks', 'plain line']);
  });

  it('drops very long lines (runaway prose) but keeps full refine-step descriptions', () => {
    const long = 'x'.repeat(300);
    const step = 'Understand the risk of infinite loops and explain how a loop condition must eventually change to prevent them in a program.';
    expect(parseStringList(`${long}\n${step}\nShort one`)).toEqual([step, 'Short one']);
  });

  it('REGRESSION: leading digits that are content (not numbering) survive verbatim', () => {
    expect(parseStringList('0 means the loop stops\n3.14 is pi\n7 % 2 gives 1')).toEqual([
      '0 means the loop stops',
      '3.14 is pi',
      '7 % 2 gives 1',
    ]);
  });

  it('returns [] when nothing is usable', () => {
    expect(parseStringList('')).toEqual([]);
  });

  it('ignores a JSON array of non-strings and falls back to lines', () => {
    // [1,2] parses as an array but has no usable strings; the raw text lines survive.
    const out = parseStringList('[1, 2]');
    expect(out).toEqual(['[1, 2]'.replace(/^[[\]{}]+$/, '[1, 2]')].filter((l) => l === '[1, 2]'));
  });
});

describe('parseAchieved', () => {
  it('honours explicit JSON achieved:true with evidence', () => {
    const r = parseAchieved('{"achieved": true, "evidence": "student defined the loop"}');
    expect(r).toEqual({ achieved: true, evidence: 'student defined the loop' });
  });

  it('honours explicit JSON achieved:false', () => {
    const r = parseAchieved('{"achieved": false, "evidence": "no attempt yet"}');
    expect(r.achieved).toBe(false);
  });

  it('tolerates missing evidence in JSON', () => {
    expect(parseAchieved('{"achieved": true}')).toEqual({ achieved: true, evidence: '' });
  });

  it('falls back to affirmative token scan when JSON is absent', () => {
    expect(parseAchieved('Yes — the milestone is achieved.').achieved).toBe(true);
  });

  it('negative phrasing wins over the affirmative token', () => {
    expect(parseAchieved('Not achieved: the student has not demonstrated it yet.').achieved).toBe(false);
  });

  it('defaults to false (do not advance) on ambiguous prose', () => {
    expect(parseAchieved('Hmm, it is hard to say for sure.').achieved).toBe(false);
  });

  it('defaults to false on empty input', () => {
    expect(parseAchieved('').achieved).toBe(false);
  });

  // A bare affirmation with no negation still reads as achieved (an assessor answering
  // just "Correct." means yes) — but ANY negation token now defeats it; see below.
  it('bare "correct" rationale without JSON reads as achieved', () => {
    expect(parseAchieved('The student is correct that a loop repeats.').achieved).toBe(true);
  });

  it('REGRESSION (weak-spot #3): "not correct" must NOT advance', () => {
    expect(parseAchieved("The student's answer is not correct.").achieved).toBe(false);
    expect(parseAchieved('This is incorrect — the loop never ends.').achieved).toBe(false);
    expect(parseAchieved("The answer isn't right; they haven't demonstrated it.").achieved).toBe(false);
    expect(parseAchieved('Wrong: a while loop checks the condition first.').achieved).toBe(false);
  });

  it('accepts a string-typed achieved field', () => {
    expect(parseAchieved('{"achieved": "true", "evidence": "said it"}').achieved).toBe(true);
    expect(parseAchieved('{"achieved": "false", "evidence": "not yet"}').achieved).toBe(false);
  });

  it('recovers achieved from a truncated verdict', () => {
    expect(parseAchieved('{"achieved": false, "evidence": "the student only asked wh').achieved).toBe(false);
  });
});
