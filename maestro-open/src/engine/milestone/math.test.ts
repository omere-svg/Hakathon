// Tests for the deterministic arithmetic rail (math.ts) — the structural guard behind
// the TutorBench "tutor factual math error" scenarios. The parser must match Python
// semantics (// floor division, % sign-follows-divisor) since this is a Python course,
// and the claim matcher must NEVER touch code (assignments) or non-numeric prose.

import { describe, expect, it } from 'vitest';
import { correctArithmetic, correctListClaims, correctMembership, evalArithmetic, simpleLoopTerminates } from './math';

describe('evalArithmetic', () => {
  it('handles the four basic operators and precedence', () => {
    expect(evalArithmetic('2 + 3 * 4')).toBe(14);
    expect(evalArithmetic('(2 + 3) * 4')).toBe(20);
    expect(evalArithmetic('10 - 4 / 2')).toBe(8);
  });

  it('matches Python floor division and modulo', () => {
    expect(evalArithmetic('17 // 5')).toBe(3);
    expect(evalArithmetic('17 % 5')).toBe(2);
    expect(evalArithmetic('-7 // 2')).toBe(-4); // Python floors toward -inf
    expect(evalArithmetic('-7 % 3')).toBe(2); // Python: sign follows the divisor
  });

  it('handles power (right-associative) and unary minus', () => {
    expect(evalArithmetic('2 ** 3')).toBe(8);
    expect(evalArithmetic('2 ** 3 ** 2')).toBe(512);
    expect(evalArithmetic('-3 + 5')).toBe(2);
  });

  it('handles floats', () => {
    expect(evalArithmetic('(50 - 40) / 50')).toBeCloseTo(0.2);
  });

  it('returns null on garbage, division by zero, and stray characters', () => {
    expect(evalArithmetic('count + 1')).toBeNull();
    expect(evalArithmetic('5 / 0')).toBeNull();
    expect(evalArithmetic('2 +')).toBeNull();
    expect(evalArithmetic('(2 + 3')).toBeNull();
    expect(evalArithmetic('')).toBeNull();
  });
});

describe('correctArithmetic', () => {
  it('fixes a wrong integer claim (the SWE-02 scenario shape)', () => {
    const r = correctArithmetic('So 17 // 5 = 4 and 17 % 5 = 3. Does that make sense?');
    expect(r.text).toBe('So 17 // 5 = 3 and 17 % 5 = 2. Does that make sense?');
    expect(r.corrections).toHaveLength(2);
  });

  it('fixes a wrong percentage-style float claim (the BIZ-02 scenario shape)', () => {
    const r = correctArithmetic('Gross margin is (50 - 40) / 50 = 0.5 here.');
    expect(r.text).toContain('(50 - 40) / 50 = 0.2');
    expect(r.corrections).toHaveLength(1);
  });

  it('leaves correct claims untouched', () => {
    const text = 'Yes! 2 + 2 = 4 and 17 // 5 = 3.';
    expect(correctArithmetic(text)).toEqual({ text, corrections: [] });
  });

  it('tolerates a legitimately rounded float', () => {
    const text = 'So 10 / 3 = 3.33 approximately.';
    expect(correctArithmetic(text).corrections).toHaveLength(0);
  });

  it('never touches code or variable expressions', () => {
    const text = 'Write count = count + 1 inside the loop, and check x % 2 == 0.';
    expect(correctArithmetic(text)).toEqual({ text, corrections: [] });
  });

  it('never touches comparison operators', () => {
    const text = 'The loop runs while 3 + total <= 10.';
    expect(correctArithmetic(text)).toEqual({ text, corrections: [] });
  });

  it('handles the "is"/"equals" phrasings', () => {
    expect(correctArithmetic('Remember, 6 * 7 is 41.').text).toBe('Remember, 6 * 7 is 42.');
    expect(correctArithmetic('And 9 - 4 equals 6 here.').text).toBe('And 9 - 4 equals 5 here.');
  });
});

// ── String-membership rail (the live "`salsa` does not contain `al`" failure) ─────

describe('correctMembership', () => {
  it('fixes the live false claim — `salsa` DOES contain `al`', () => {
    const r = correctMembership('so `salsa` does not contain `al`, and `salsa` does contain `s`.');
    expect(r.text).toContain('`salsa` does contain `al`');
    expect(r.text).toContain('`salsa` does contain `s`'); // the true claim is untouched
    expect(r.corrections).toHaveLength(1);
    expect(r.corrections[0].actual).toBe('does contain');
  });

  it('fixes a wrong contains-claim in the other direction', () => {
    const r = correctMembership("'hello' contains 'z' here");
    expect(r.text).toContain("'hello' does not contain 'z'");
    expect(r.corrections).toHaveLength(1);
  });

  it("fixes a wrong 'x' in 'word' → True/False verdict", () => {
    const r = correctMembership("'e' in 'hello' evaluates to False");
    expect(r.text).toContain('True');
    expect(r.corrections).toHaveLength(1);
    const r2 = correctMembership("'q' not in 'hello' is False.");
    expect(r2.text).toContain("'q' not in 'hello' is True");
  });

  it('leaves correct claims and plain prose untouched', () => {
    const ok = "`hello` does contain `ell`, and 'a' in 'salsa' is True — the list contains numbers.";
    const r = correctMembership(ok);
    expect(r.text).toBe(ok);
    expect(r.corrections).toHaveLength(0);
  });

  it('is case-sensitive like Python', () => {
    const r = correctMembership("'H' in 'hello' is True");
    expect(r.text).toContain("'H' in 'hello' is False");
  });

  it('fixes wrong GENERAL semantics claims (post-tune: "Not in gives False when the substring is absent")', () => {
    const r = correctMembership('Not in gives False when the substring is absent.');
    expect(r.text).toContain('Not in gives True when the substring is absent.');
    expect(correctMembership('`in` returns True when the substring is present.').corrections).toHaveLength(0);
    expect(correctMembership('in gives True when the substring is absent').text).toContain('in gives False when');
  });
});

// ── List claims (the live "[1,2,3,4,5] from 2 to 3 gives [2, 3]" failure) ─────────

describe('correctListClaims', () => {
  it('fixes the live prose slice claim', () => {
    const r = correctListClaims('For [1, 2, 3, 4, 5], a slice from 2 to 3 (exclusive) gives [2, 3].');
    expect(r.text).toContain('gives [3]');
    expect(r.corrections).toHaveLength(1);
  });

  it('fixes a wrong code-form slice and a wrong len()', () => {
    const r = correctListClaims('[1, 2, 3, 4, 5][2:4] is [2, 3, 4] and len([1, 2, 3]) is 4 here.');
    expect(r.text).toContain('is [3, 4]');
    expect(r.text).toContain('len([1, 2, 3]) is 3');
    expect(r.corrections).toHaveLength(2);
  });

  it('leaves correct claims untouched', () => {
    const ok = 'len([1, 2, 3, 4, 5]) is 5, and [1, 2, 3][0:2] gives [1, 2].';
    expect(correctListClaims(ok)).toEqual({ text: ok, corrections: [] });
  });
});

// ── Simple-loop termination (the recurring "runs forever" hallucination) ──────────

describe('simpleLoopTerminates', () => {
  it('proves the live countdown loop terminates', () => {
    expect(simpleLoopTerminates('n = 5\nwhile n > 0:\n    print(n)\n    n = n - 1')).toBe(true);
    expect(simpleLoopTerminates('total = 0\nn = 1\nwhile n <= 3:\n    total = total + n\n    n = n + 1')).toBe(true);
  });

  it('flags genuinely infinite loops', () => {
    expect(simpleLoopTerminates('n = 5\nwhile n > 0:\n    print(n)')).toBe(false); // n never changes
    expect(simpleLoopTerminates('n = 0\nwhile n < 5:\n    n = n - 1')).toBe(false); // moves away
  });

  it('makes NO claim about shapes it cannot simulate', () => {
    expect(simpleLoopTerminates('for x in range(5): print(x)')).toBe(null);
    expect(simpleLoopTerminates('while ready():\n    step()')).toBe(null);
    expect(simpleLoopTerminates('just prose, no loop at all')).toBe(null);
  });
});
