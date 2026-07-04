// Deterministic arithmetic rail — the structural fix for the TutorBench "tutor factual
// math error" scenarios (SWE-02 / BIZ-02). A 1-2B model WILL eventually botch arithmetic
// live; nothing prompt-side prevents "17 // 5 = 4". So every numeric claim the tutor makes
// ("<expression> = <number>") is re-computed here with a tiny safe parser and, when wrong,
// the stated value is replaced with the true one before the student ever sees it.
//
// Scope is deliberately narrow: pure-numeric expressions with + - * / // % ** and parens.
// Anything containing a variable name is NOT a claim we can check (`count = count + 1` is
// code, not arithmetic) and is left untouched. Python semantics for // (floor) and %
// (sign follows divisor) — this is a Python course.

/** Evaluate a pure arithmetic expression. Returns null on any syntax error, unknown
 *  character, or non-finite result — never throws, never touches eval/Function. */
export function evalArithmetic(expr: string): number | null {
  const s = expr;
  let pos = 0;

  const peek = (): string => s.slice(pos);
  const skipWs = (): void => {
    while (pos < s.length && /\s/.test(s[pos])) pos++;
  };

  // expression := term (('+'|'-') term)*
  // term       := factor (('*'|'/'|'//'|'%') factor)*
  // factor     := ('-'|'+') factor | primary ('**' factor)?
  // primary    := number | '(' expression ')'

  function parseExpression(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    for (;;) {
      skipWs();
      const ch = s[pos];
      if (ch === '+' || ch === '-') {
        pos++;
        const right = parseTerm();
        if (right === null) return null;
        left = ch === '+' ? left + right : left - right;
      } else return left;
    }
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    for (;;) {
      skipWs();
      if (peek().startsWith('//')) {
        pos += 2;
        const right = parseFactor();
        if (right === null || right === 0) return null;
        left = Math.floor(left / right);
      } else if (s[pos] === '*' && s[pos + 1] !== '*') {
        pos++;
        const right = parseFactor();
        if (right === null) return null;
        left = left * right;
      } else if (s[pos] === '/') {
        pos++;
        const right = parseFactor();
        if (right === null || right === 0) return null;
        left = left / right;
      } else if (s[pos] === '%') {
        pos++;
        const right = parseFactor();
        if (right === null || right === 0) return null;
        left = ((left % right) + right) % right; // Python: sign follows the divisor
      } else return left;
    }
  }

  function parseFactor(): number | null {
    skipWs();
    if (s[pos] === '-') {
      pos++;
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (s[pos] === '+') {
      pos++;
      return parseFactor();
    }
    const base = parsePrimary();
    if (base === null) return null;
    skipWs();
    if (peek().startsWith('**')) {
      pos += 2;
      const exp = parseFactor(); // right-associative
      if (exp === null) return null;
      return base ** exp;
    }
    return base;
  }

  function parsePrimary(): number | null {
    skipWs();
    if (s[pos] === '(') {
      pos++;
      const v = parseExpression();
      skipWs();
      if (v === null || s[pos] !== ')') return null;
      pos++;
      return v;
    }
    const m = peek().match(/^\d+(?:\.\d+)?/);
    if (!m) return null;
    pos += m[0].length;
    return parseFloat(m[0]);
  }

  const v = parseExpression();
  skipWs();
  if (v === null || pos !== s.length || !Number.isFinite(v)) return null;
  return v;
}

export interface MathCorrection {
  expr: string;
  stated: string;
  actual: string;
}

/** Format a computed value the way a tutor would write it: integers bare, floats trimmed. */
function fmt(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(parseFloat(v.toFixed(6)));
}

// A checkable claim: a pure-numeric expression (digits/parens/operators only, at least one
// operator), then = / == / "equals" / "is", then a number. Any letter or symbol inside the
// expression breaks the char class, so code like `count = count + 1` never matches.
const CLAIM =
  /([\d(][\d\s.()]*(?:(?:\*\*|\/\/|[+\-*/%])[\d\s.()]*)+)\s*(==|=|equals|is)\s*(-?\d+(?:\.\d+)?)/gi;

/** Re-compute every numeric claim in a tutor reply and fix any that are wrong.
 *  Returns the corrected text plus a record of each fix (surfaced in the dev panel). */
export function correctArithmetic(text: string): { text: string; corrections: MathCorrection[] } {
  const corrections: MathCorrection[] = [];
  const out = text.replace(CLAIM, (whole, exprRaw: string, op: string, statedRaw: string) => {
    const expr = exprRaw.trim();
    const actual = evalArithmetic(expr);
    if (actual === null) return whole;
    const stated = parseFloat(statedRaw);
    if (Math.abs(actual - stated) < 1e-9) return whole;
    // Tolerate a legitimately rounded float ("10 / 3 = 3.33").
    if (!Number.isInteger(actual) && Math.abs(actual - stated) < 0.005) return whole;
    corrections.push({ expr, stated: statedRaw, actual: fmt(actual) });
    return `${expr} ${op} ${fmt(actual)}`;
  });
  return { text: out, corrections };
}

// ── String-membership rail — the arithmetic rail's sibling for `in` / `not in` ────
// Observed live in the string-membership lesson: the tutor asserted "`salsa` does not
// contain `al`" TWICE (it does: s-A-L-s-a). Membership claims are exactly as computable
// as arithmetic: run the real substring check and fix the sentence.
// Scope is deliberately narrow: BOTH operands must be quoted or backticked literals —
// plain-English "the list contains numbers" is prose, not a checkable claim.

/** `X` (does not) contain(s) `Y` — both operands quoted/backticked. */
const CONTAINS_CLAIM = /([`'"])([^`'"]+)\1\s+(does\s+not\s+contain|contains?|does\s+contain)\s+([`'"])([^`'"]+)\4/gi;

/** General `in`/`not in` SEMANTICS claims — "not in gives True when the substring is
 *  absent" (post-tune trace shipped the False version). Truth table: in+present=True,
 *  in+absent=False, not-in flips. */
const SEMANTICS_CLAIM =
  /`?(not\s+in|in)`?\s+(?:gives|returns|is|evaluates\s+to)\s+`?(True|False|true|false)`?\s+when\s+the\s+substring\s+is\s+(absent|missing|not\s+found|present|found|there)/gi;

/** 'y' (not) in 'xxx' evaluates to / is / returns True|False — quoted operands, with or
 *  without a backtick wrapping the whole expression. */
const IN_CLAIM =
  /(['"])([^'"]+)\1\s+(not\s+)?in\s+(['"])([^'"]+)\4`?\s*(?:evaluates\s+to|returns|equals|gives|is)\s+`?(True|False|true|false)`?/gi;

// ── List claims (len / slices) — observed live: "a slice of [1, 2, 3, 4, 5] from 2 to 3
// gives [2, 3]" (it gives [3]). Both forms are mechanically checkable. ──────────────

const LEN_CLAIM = /len\(\s*\[([^\]]*)\]\s*\)\s*(?:is|=|equals|evaluates\s+to|gives)\s+(\d+)/gi;
const SLICE_CODE_CLAIM =
  /\[([\d\s,]+)\]\s*\[\s*(\d+)\s*:\s*(\d+)\s*\]\s*(?:is|=|equals|evaluates\s+to|gives)\s+\[([\d\s,]*)\]/gi;
const SLICE_PROSE_CLAIM =
  /\[([\d\s,]+)\][^.!?[\]]*?\bfrom\s+(\d+)\s+to\s+(\d+)\b[^.!?[\]]*?\bgives\s+\[([\d\s,]*)\]/gi;

const parseNums = (s: string): number[] =>
  s.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
const fmtList = (xs: number[]): string => `[${xs.join(', ')}]`;

/** Verify len()/slice claims in a tutor reply and fix any that are wrong. */
export function correctListClaims(text: string): { text: string; corrections: MathCorrection[] } {
  const corrections: MathCorrection[] = [];

  let out = text.replace(LEN_CLAIM, (whole, itemsS: string, statedS: string) => {
    const actual = itemsS.trim() === '' ? 0 : itemsS.split(',').length;
    if (actual === Number(statedS)) return whole;
    corrections.push({ expr: `len([${itemsS.trim()}])`, stated: statedS, actual: String(actual) });
    return whole.replace(new RegExp(`${statedS}$`), String(actual));
  });

  const fixSlice = (whole: string, listS: string, aS: string, bS: string, statedS: string): string => {
    const actual = parseNums(listS).slice(Number(aS), Number(bS));
    const stated = parseNums(statedS);
    if (actual.length === stated.length && actual.every((v, i) => v === stated[i])) return whole;
    corrections.push({
      expr: `[${parseNums(listS).join(', ')}][${aS}:${bS}]`,
      stated: fmtList(stated),
      actual: fmtList(actual),
    });
    return whole.replace(/\[[\d\s,]*\]$/, fmtList(actual));
  };
  out = out.replace(SLICE_CODE_CLAIM, (w, l: string, a: string, b: string, s: string) => fixSlice(w, l, a, b, s));
  out = out.replace(SLICE_PROSE_CLAIM, (w, l: string, a: string, b: string, s: string) => fixSlice(w, l, a, b, s));

  return { text: out, corrections };
}

// ── Simple-loop termination — the recurring "that loop runs forever" hallucination
// (three separate traces called a provably terminating counter loop infinite). The
// canonical shape `x = N` … `while x <cmp> M:` … `x = x ± k` is safe to simulate. ────

/** true = provably terminates, false = provably never (no/zero update), null = not the
 *  simple shape we can simulate (make NO claim either way). */
export function simpleLoopTerminates(code: string): boolean | null {
  const m = code.match(/(\w+)\s*=\s*(-?\d+)[\s\S]*?while\s+\1\s*(<=|>=|<|>|!=)\s*(-?\d+)\s*:/);
  if (!m) return null;
  const [, name, initS, op, limitS] = m;
  const body = code.slice(code.indexOf('while'));
  const upd = body.match(
    new RegExp(`${name}\\s*=\\s*${name}\\s*([+-])\\s*(\\d+)|${name}\\s*([+-])=\\s*(\\d+)`),
  );
  if (!upd) return false; // the loop variable never changes
  const sign = (upd[1] ?? upd[3]) === '+' ? 1 : -1;
  const k = Number(upd[2] ?? upd[4]);
  if (!k) return false;
  let v = Number(initS);
  const limit = Number(limitS);
  const test = (x: number): boolean =>
    op === '<' ? x < limit : op === '<=' ? x <= limit : op === '>' ? x > limit : op === '>=' ? x >= limit : x !== limit;
  for (let i = 0; i < 100000 && test(v); i++) v += sign * k;
  return !test(v);
}

// ── Unreachable elif branches — iter6: a wrong-order chain (`>= 80` before `>= 90`)
// was validated by the tutor AND accepted by the grader. Numeric threshold chains on one
// variable in one direction are mechanically checkable. ─────────────────────────────

/** Returns a human-readable description of the first unreachable branch in a numeric
 *  if/elif threshold chain, or null when the chain is fine / not the checkable shape. */
export function findUnreachableBranch(code: string): string | null {
  const conds = [...code.matchAll(/\b(?:if|elif)\s+(\w+)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*:/g)].map((m) => ({
    v: m[1],
    op: m[2],
    n: Number(m[3]),
  }));
  for (let i = 1; i < conds.length; i++) {
    const prev = conds[i - 1];
    const cur = conds[i];
    if (prev.v !== cur.v) continue;
    const dirPrev = prev.op[0] === '>' ? 1 : -1;
    const dirCur = cur.op[0] === '>' ? 1 : -1;
    if (dirPrev !== dirCur) continue;
    // Same variable, same direction: a later threshold the earlier check already covers
    // (higher for >/>=, lower for </<=) means that branch can never run.
    const swallowed = dirPrev === 1 ? cur.n >= prev.n : cur.n <= prev.n;
    if (swallowed) {
      return `\`${cur.v} ${cur.op} ${cur.n}\` can never run — \`${prev.v} ${prev.op} ${prev.n}\` is checked first`;
    }
  }
  return null;
}

/** Verify every string-membership claim in a tutor reply and fix any that are wrong. */
export function correctMembership(text: string): { text: string; corrections: MathCorrection[] } {
  const corrections: MathCorrection[] = [];

  let out = text.replace(
    CONTAINS_CLAIM,
    (whole, q1: string, container: string, verb: string, q2: string, sub: string) => {
      const contains = container.includes(sub);
      const claimsContains = !/\bnot\b/i.test(verb);
      if (contains === claimsContains) return whole;
      const fixed = contains ? 'does contain' : 'does not contain';
      corrections.push({ expr: `${q2}${sub}${q2} in ${q1}${container}${q1}`, stated: verb, actual: fixed });
      return `${q1}${container}${q1} ${fixed} ${q2}${sub}${q2}`;
    },
  );

  out = out.replace(SEMANTICS_CLAIM, (whole, op: string, stated: string, state: string) => {
    const present = /present|found|there/i.test(state) && !/not\s+found/i.test(state);
    const actual = (/not/i.test(op) ? !present : present) ? 'True' : 'False';
    if (stated.toLowerCase() === actual.toLowerCase()) return whole;
    corrections.push({ expr: `${op.replace(/\s+/g, ' ')} when substring ${state}`, stated, actual });
    return whole.replace(stated, actual);
  });

  out = out.replace(
    IN_CLAIM,
    (whole, q1: string, sub: string, not: string | undefined, q2: string, container: string, stated: string) => {
      const value = not ? !container.includes(sub) : container.includes(sub);
      const actual = value ? 'True' : 'False';
      if (stated.toLowerCase() === actual.toLowerCase()) return whole;
      corrections.push({
        expr: `${q1}${sub}${q1} ${not ? 'not in' : 'in'} ${q2}${container}${q2}`,
        stated,
        actual,
      });
      return whole.replace(new RegExp(`${stated}\`?$`), (tail) => tail.replace(stated, actual));
    },
  );

  return { text: out, corrections };
}
