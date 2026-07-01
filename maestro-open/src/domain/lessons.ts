import type { Lesson } from './schema';
import { whileLoopLesson, MCQ_OPTIONS as WHILE_MCQ } from './whileLoopLesson';
import { bizLesson, BIZ_MCQ_OPTIONS } from './bizLesson';

// Lesson registry. The while-loop (CS) lesson is the active demo lesson; the BIZ
// unit-economics lesson is authored with the same v2.5 decomposition (one engine,
// CS + Business). A lesson picker is future work; for now this keeps both lessons
// part of the system and gives one place to resolve MCQ option text.
export const lessons: Lesson[] = [whileLoopLesson, bizLesson];

export const MCQ_OPTIONS: Record<string, string[]> = { ...WHILE_MCQ, ...BIZ_MCQ_OPTIONS };

export { whileLoopLesson, bizLesson };
