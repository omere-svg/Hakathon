import type { KcId, MisconceptionId } from '../domain/schema';

// Student model (ITS "student model") — long-term, per device.
// MVP uses a mastery COUNTER + threshold (not BKT); the shape leaves room for BKT.

export interface KcState {
  mastery: number; // [0,1] derived from correct/needed (BKT-ready field)
  attempts: number;
  correct: number;
  explained: boolean; // show-before-tell gate
  hintsUsed: number;
  lastSeen: number;
  status: 'unseen' | 'learning' | 'mastered';
}

export interface StudentModel {
  preferences: {
    preferredName?: string;
    rejectedNames: string[];
  };
  knowledge: Record<KcId, KcState>;
  misconceptions: Record<MisconceptionId, { kcId: KcId; count: number; active: boolean }>;
  affect: {
    frustration: number; // [0,1]
    confidence: number; // [0,1]
  };
}

export function initStudentModel(): StudentModel {
  return {
    preferences: { rejectedNames: [] },
    knowledge: {},
    misconceptions: {},
    affect: { frustration: 0, confidence: 0.5 },
  };
}

export function kcState(model: StudentModel, kcId: KcId): KcState {
  return (
    model.knowledge[kcId] ?? {
      mastery: 0,
      attempts: 0,
      correct: 0,
      explained: false,
      hintsUsed: 0,
      lastSeen: 0,
      status: 'unseen',
    }
  );
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function isMastered(
  model: StudentModel,
  kcId: KcId,
  criteria: { minCorrect: number; requireNoActiveMisconception: boolean },
): boolean {
  const s = kcState(model, kcId);
  if (s.correct < criteria.minCorrect) return false;
  if (criteria.requireNoActiveMisconception && hasActiveMisconception(model, kcId)) return false;
  return true;
}

export function hasActiveMisconception(model: StudentModel, kcId: KcId): boolean {
  return Object.values(model.misconceptions).some((m) => m.kcId === kcId && m.active);
}
