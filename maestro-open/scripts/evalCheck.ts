// Unit tests for the verification layer (the moat) — npm run eval:check.
// These do NOT run a model or any templates. They feed known GOOD and BAD drafts to
// the deterministic verifier and assert it accepts/rejects them per constraint. The
// real-model proof lives in the browser /evals page.
import type { Situation } from '../src/engine/situation';
import { evaluateChecks, verify } from '../src/engine/verify';

function sit(p: Partial<Situation>): Situation {
  const base = {
    lesson: {} as Situation['lesson'],
    mem: { activeCheckId: undefined } as Situation['mem'],
    student: { preferences: { preferredName: undefined, rejectedNames: [] } } as Situation['student'],
    kc: undefined,
    check: undefined,
    explained: true,
    challenge: false,
    mastered: false,
    nextLabel: undefined,
    cues: { distress: false, requestType: 'none', isAnswerAttempt: false } as Situation['cues'],
    grading: null as Situation['grading'],
    facts: [] as Situation['facts'],
  };
  return { ...base, ...p } as Situation;
}

interface Case { name: string; s: Situation; draft: string; id: string; expectPass: boolean; repairable?: boolean }

const named = (preferred: string, rejected: string[]) => sit({ student: { preferences: { preferredName: preferred, rejectedNames: rejected } } as Situation['student'] });
const challenge = sit({ challenge: true, check: { answerKey: { canonicalAnswer: 'do-while loop' } } as Situation['check'] });
const wrong = sit({ grading: { gradeable: true, correct: false, detail: 'returned 10, expected 6' } as Situation['grading'] });
const wrongWithKey = sit({ grading: { gradeable: true, correct: false, detail: 'wrong' } as Situation['grading'], check: { answerKey: { canonicalAnswer: '6' } } as Situation['check'] });
const factual = sit({ facts: [{ expr: '17 // 5', value: '3' }, { expr: '17 % 5', value: '2' }] });
const distress = sit({ cues: { distress: true, requestType: 'none', isAnswerAttempt: false } as Situation['cues'] });
const fresh = sit({ explained: false, kc: { label: 'HTTP headers' } as Situation['kc'] });
const runnable = sit({ cues: { distress: false, requestType: 'runnable', isAnswerAttempt: false } as Situation['cues'] });

const cases: Case[] = [
  // C1 — name
  { name: 'C1 uses rejected name', s: named('Matt', ['Matthew']), draft: 'Sure, Matthew — here we go.', id: 'C1', expectPass: false, repairable: true },
  { name: 'C1 uses preferred name', s: named('Matt', ['Matthew']), draft: 'Sure, Matt — here we go.', id: 'C1', expectPass: true },
  // C2 — challenge leak
  { name: 'C2 leaks answer', s: challenge, draft: 'Easy — the answer is a do-while loop.', id: 'C2', expectPass: false, repairable: true },
  { name: 'C2 nudges only', s: challenge, draft: 'No spoilers — think about where the condition sits, top or bottom?', id: 'C2', expectPass: true },
  // C3 — false validation
  { name: 'C3 validates wrong', s: wrong, draft: 'Correct! Great job, that looks right.', id: 'C3', expectPass: false, repairable: true },
  { name: 'C3 probes the gap', s: wrong, draft: 'Not quite — what does your function return when nums = [1,2,3,4]?', id: 'C3', expectPass: true },
  // C4 — factual grounding
  { name: 'C4 makes up / vague', s: factual, draft: "Hmm, it depends — not totally sure.", id: 'C4', expectPass: false, repairable: true },
  { name: 'C4 states verified facts', s: factual, draft: '17 // 5 is 3, and 17 % 5 is 2.', id: 'C4', expectPass: true },
  // C9 — affect first
  { name: 'C9 ignores distress', s: distress, draft: "Okay, let's keep going — what's next?", id: 'C9', expectPass: false, repairable: true },
  { name: 'C9 acknowledges feeling', s: distress, draft: "That sounds genuinely tough, and it's completely normal — not a sign you can't do this. What feels fuzziest?", id: 'C9', expectPass: true },
  // C5 — show before tell
  { name: 'C5 quizzes first', s: fresh, draft: 'Why might the server need to know the format of what you send?', id: 'C5', expectPass: false },
  { name: 'C5 explains first', s: fresh, draft: 'HTTP headers are metadata that tell the server how to handle the body. Why might it need the format?', id: 'C5', expectPass: true },
  // C10 — runnable artifact
  { name: 'C10 placeholder', s: runnable, draft: 'Paste this: print(<your text here>)', id: 'C10', expectPass: false, repairable: true },
  { name: 'C10 concrete', s: runnable, draft: 'Paste this and run it: print("Hello, world!")  — what does it print?', id: 'C10', expectPass: true },
  // C3 strengthened — hands over the answer (not just affirming)
  { name: 'C3 hands over answer', s: wrongWithKey, draft: 'No worries — the answer is 6.', id: 'C3', expectPass: false, repairable: true },
  // C3 regression — "incorrect" must NOT be read as "correct"
  { name: 'C3 says incorrect (ok)', s: wrong, draft: "That's incorrect — what does your loop return for nums = [1,2,3,4]?", id: 'C3', expectPass: true },
  // C9 strengthened — empathy must LEAD, not trail after content
  { name: 'C9 empathy too late', s: distress, draft: 'First set up the counter, then loop while it stays small, then update it inside so the loop eventually ends — keep going, you will get there step by step, and honestly this is tough and completely normal.', id: 'C9', expectPass: false, repairable: true },
];

let failures = 0;
for (const c of cases) {
  const check = evaluateChecks(c.draft, c.s).find((x) => x.id === c.id);
  const evalOk = !!check && check.passed === c.expectPass;
  // repairable BAD drafts must also be flagged by verify() (so the engine re-prompts)
  const verifyOk = c.repairable === undefined || c.expectPass || verify(c.draft, c.s).some((v) => v.id === c.id);
  const ok = evalOk && verifyOk;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${c.name}  (eval=${check?.passed}, expect=${c.expectPass}${c.repairable && !c.expectPass ? `, verify-flags=${verify(c.draft, c.s).some((v) => v.id === c.id)}` : ''})`);
}

// Repair-only behavior: a wrong answer with no probing question must be FLAGGED for
// re-prompt (even though it doesn't falsely validate, so the scoreboard check is lenient).
const mustProbe = verify('That is wrong.', wrong).some((v) => v.id === 'C3');
console.log(`${mustProbe ? '✓' : '✗'} C3 must-probe: a wrong-answer reply with no question is flagged for repair`);
if (!mustProbe) failures++;

console.log(`\n${cases.length + 1 - failures}/${cases.length + 1} verifier checks correct`);
if (failures > 0) {
  console.error(`${failures} verifier test(s) failed.`);
  process.exit(1);
}
