import type { Check, MisconceptionId } from '../domain/schema';
import { containsWord } from '../util/text';
import { runCodeTests } from './codeRunner';

// Deterministic grading. The source of truth for correctness — never the LLM.

export interface GradingResult {
  gradeable: boolean; // false for free-text checks with no key
  correct: boolean;
  matchedMisconception?: MisconceptionId;
  detail: string;
}

export function grade(check: Check, answer: string): GradingResult {
  const key = check.answerKey;
  switch (check.type) {
    case 'mcq': {
      const idx = parseMcqIndex(answer);
      if (idx == null) return { gradeable: true, correct: false, detail: 'Could not read a choice.' };
      const correct = idx === key.mcqCorrectIndex;
      const matched = !correct ? key.mcqMisconceptionByIndex?.[idx] : undefined;
      return { gradeable: true, correct, matchedMisconception: matched, detail: correct ? 'Correct choice.' : 'Wrong choice.' };
    }
    case 'numeric': {
      const n = parseFloat(answer.replace(/[^0-9.\-]/g, ''));
      if (Number.isNaN(n) || key.numericValue == null) return { gradeable: true, correct: false, detail: 'No number found.' };
      const tol = key.numericTolerance ?? 0;
      return { gradeable: true, correct: Math.abs(n - key.numericValue) <= tol, detail: 'Numeric check.' };
    }
    case 'keyword': {
      const needed = key.keywords ?? [];
      const correct = needed.length > 0 && needed.every((k) => containsWord(answer, k));
      return { gradeable: true, correct, detail: 'Keyword check.' };
    }
    case 'code': {
      if (!key.functionName || !key.codeTests) return { gradeable: false, correct: false, detail: 'No code tests.' };
      const r = runCodeTests(answer, key.functionName, key.codeTests);
      return { gradeable: true, correct: r.passed, detail: r.detail };
    }
    case 'free':
    default:
      // No deterministic key — engine treats this as "received, can't auto-grade".
      return { gradeable: false, correct: false, detail: 'Free-text answer (not auto-gradeable).' };
  }
}

function parseMcqIndex(answer: string): number | null {
  const m = answer.trim().match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isNaN(n) ? null : n;
}
