// Deterministic tool: compute arithmetic the student asks about, so the tutor
// never has to make up a number (constraint C4 — factual grounding).
// Supports Python-style // (floor div) and % (modulo).

export interface Fact {
  expr: string;
  value: string;
}

const RE = /(-?\d+)\s*(\/\/|\*\*|%|\*|\+|-|\/)\s*(-?\d+)/g;

function apply(a: number, op: string, b: number): number | null {
  switch (op) {
    case '//':
      return b === 0 ? null : Math.floor(a / b);
    case '%':
      return b === 0 ? null : a - Math.floor(a / b) * b; // Python-style modulo
    case '/':
      return b === 0 ? null : a / b;
    case '*':
      return a * b;
    case '**':
      return a ** b;
    case '+':
      return a + b;
    case '-':
      return a - b;
    default:
      return null;
  }
}

export function compute(message: string): Fact[] {
  const facts: Fact[] = [];
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  while ((m = RE.exec(message)) && facts.length < 4) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[3], 10);
    const v = apply(a, m[2], b);
    if (v != null) facts.push({ expr: `${a} ${m[2]} ${b}`, value: String(v) });
  }
  return facts;
}
