import type { KcId } from '../domain/schema';
import type { MisconceptionId } from '../domain/schema';

// Conversation memory, three tiers (see architecture-spec.md §8).
//  - Long-term student memory  = StudentModel (student/model.ts), persisted per device.
//  - Lesson memory             = LessonMemory below, one session.
//  - Turn memory               = TurnRecord below, ephemeral (also the eval/log record).

export type Role = 'student' | 'tutor';

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
}

export interface LessonMemory {
  lessonId: string;
  currentKcId: KcId;
  phase: 'intro' | 'teach' | 'check' | 'remediate' | 'review' | 'complete';
  activeCheckId?: string; // the open target
  inChallenge: boolean;
  lastGrading?: { correct: boolean; gradeable: boolean; matchedMisconception?: MisconceptionId };
  transcript: ChatMessage[]; // bounded window for NLU/NLG context
}

export function initLessonMemory(lessonId: string, firstKcId: KcId): LessonMemory {
  return {
    lessonId,
    currentKcId: firstKcId,
    phase: 'intro',
    inChallenge: false,
    transcript: [],
  };
}
