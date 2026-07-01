import type { Lesson, MisconceptionId } from '../domain/schema';
import { getCheck, getKc } from '../domain/schema';
import type { LessonMemory } from '../memory/types';
import type { Cues } from './cues';
import { grade } from '../tools/grader';

// Deterministic correctness verdict for the active check — the authoritative source
// the tutor LLM is NEVER trusted to produce. Returns null when the turn isn't an
// answer to an open check.

export interface Grading {
  gradeable: boolean;
  correct: boolean;
  matchedMisconception?: MisconceptionId;
  detail: string;
  expected?: string; // canonical answer (engine may use to guide; withheld in challenge)
}

export function gradeActive(lesson: Lesson, mem: LessonMemory, cues: Cues, message: string): Grading | null {
  if (!mem.activeCheckId || !cues.isAnswerAttempt) return null;
  const kc = getKc(lesson, mem.currentKcId);
  const check = kc && getCheck(kc, mem.activeCheckId);
  if (!check) return null;
  const g = grade(check, message);
  return {
    gradeable: g.gradeable,
    correct: g.gradeable && g.correct,
    matchedMisconception: g.matchedMisconception,
    detail: g.detail,
    expected: check.answerKey.canonicalAnswer,
  };
}
