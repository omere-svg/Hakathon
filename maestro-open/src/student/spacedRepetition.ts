import type { Lesson, KcId } from '../domain/schema';
import { isMastered, kcState, type StudentModel } from './model';

// Spaced repetition (modular, gated by the `spacedRepetition` flag). Minimal but real:
// when resuming a lesson, start at the weakest concept that isn't mastered yet, so the
// student revisits shaky ground first. A full forgetting-curve scheduler is future work.

export function startingKc(lesson: Lesson, student: StudentModel): KcId {
  // first not-yet-mastered KC in curriculum order
  const unmastered = lesson.knowledgeComponents.find((kc) => !isMastered(student, kc.id, kc.masteryCriteria));
  if (unmastered) return unmastered.id;
  // everything mastered → revisit the lowest-mastery KC for reinforcement
  let weakest = lesson.knowledgeComponents[0];
  for (const kc of lesson.knowledgeComponents) {
    if (kcState(student, kc.id).mastery < kcState(student, weakest.id).mastery) weakest = kc;
  }
  return weakest.id;
}
