import type { StudentModel } from '../student/model';
import type { LessonMemory } from '../memory/types';

// Persistent progress (modular, gated by the `persistence` flag). Uses localStorage
// for simplicity/robustness; the interface is storage-agnostic so it can be swapped
// for IndexedDB later without touching callers. All data is on-device — nothing leaves.

export interface SavedProgress {
  student: StudentModel;
  /** lesson memory minus the transcript (kept fresh each session) */
  mem: Omit<LessonMemory, 'transcript'>;
  savedAt: number;
}

const key = (lessonId: string) => `maestro.progress.${lessonId}`;

export function loadProgress(lessonId: string): SavedProgress | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key(lessonId));
    return raw ? (JSON.parse(raw) as SavedProgress) : null;
  } catch {
    return null;
  }
}

export function saveProgress(lessonId: string, student: StudentModel, mem: LessonMemory): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const { transcript: _t, ...memNoTranscript } = mem;
    void _t;
    const payload: SavedProgress = { student, mem: memNoTranscript, savedAt: Date.now() };
    localStorage.setItem(key(lessonId), JSON.stringify(payload));
  } catch {
    /* ignore quota/serialization errors */
  }
}

export function clearProgress(lessonId: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key(lessonId));
  } catch {
    /* ignore */
  }
}

/** Clear all saved lesson progress (used by Settings → Reset progress). */
export function clearAllProgress(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('maestro.progress.')) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
