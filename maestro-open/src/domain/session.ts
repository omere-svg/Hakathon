// Session persistence — a lesson must survive a reload ("a product someone can come back
// to", per the brief). One localStorage key holds everything needed to resume: the lesson
// brief, the chat transcript (without dev-panel call logs — those embed full prompts and
// would bloat the quota), and the engine's own serialized state.
//
// All functions are safe in private-mode / quota-exceeded / Node environments: they catch
// and degrade to "no session" rather than throwing into the UI.

import type { LessonBrief, Suggestions } from '../engine/api';

export interface SavedMsg {
  id: string;
  role: 'student' | 'tutor';
  text: string;
  status?: string;
  suggest?: Suggestions;
}

export interface SavedSession {
  v: 1;
  savedAt: number;
  brief: LessonBrief;
  messages: SavedMsg[];
  /** opaque engine snapshot (TutorEngine.serialize()); passed back through createEngine. */
  engine: unknown;
}

const KEY = 'maestro.session.v1';

export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedSession;
    if (s?.v !== 1 || !s.brief?.goals?.length || !Array.isArray(s.messages) || !s.messages.length) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: Omit<SavedSession, 'v' | 'savedAt'>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, savedAt: Date.now(), ...s }));
  } catch {
    /* quota / private mode — persistence is best-effort */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// ── picked lesson (lesson switcher) ──────────────────────────────────────────────
// A one-shot handoff across the reload that a lesson switch triggers: the picker writes
// the chosen lesson id, the next load reads it and starts that lesson fresh.
//
// PEEK + CLEAR, deliberately not a read-and-delete "consume": the read happens inside a
// useState INITIALIZER, and React StrictMode invokes initializers TWICE on mount — a
// consuming read deleted the key on the first call, so the second call found nothing and
// fell through to a RANDOM lesson (the live "I picked lesson X, it opened lesson Y" bug).
// The initializer must be pure; the page clears the key in its once-guarded init effect,
// which preserves the one-shot semantics (a stale pick never pins future loads).

const PICK_KEY = 'maestro.lesson.pick';

export function setPickedLesson(id: string): void {
  try {
    localStorage.setItem(PICK_KEY, id);
  } catch {
    /* ignore */
  }
}

export function peekPickedLessonId(): string | null {
  try {
    return localStorage.getItem(PICK_KEY);
  } catch {
    return null;
  }
}

export function clearPickedLesson(): void {
  try {
    localStorage.removeItem(PICK_KEY);
  } catch {
    /* ignore */
  }
}

// ── custom lesson (student-authored) ─────────────────────────────────────────────
// Same one-shot handoff shape, but carrying a whole LessonBrief: the student writes a
// title + mastery goals, the next load starts the engine on it exactly like a catalog
// lesson (decomposition, milestones, persistence — nothing else special-cased).

const CUSTOM_KEY = 'maestro.lesson.custom.v1';

export function setPickedCustomBrief(brief: LessonBrief): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(brief));
  } catch {
    /* ignore */
  }
}

export function peekPickedCustomBrief(): LessonBrief | null {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as LessonBrief;
    if (!b?.id || !b.title || !Array.isArray(b.goals) || !b.goals.length) return null;
    return b;
  } catch {
    return null;
  }
}

export function clearPickedCustomBrief(): void {
  try {
    localStorage.removeItem(CUSTOM_KEY);
  } catch {
    /* ignore */
  }
}
