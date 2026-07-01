// Model catalog + device-tier picker (modular). Auto-recommends a model from device
// signals; the user can override on the Settings page. Choice persists to localStorage.

export interface ModelOption {
  id: string;
  label: string;
  approxGB: number;
  tier: 'low' | 'mid' | 'high';
  note: string;
}

export const MODELS: ModelOption[] = [
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Fast (0.5B)', approxGB: 1.0, tier: 'low', note: 'Runs on most phones; lowest quality.' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Balanced (1.5B)', approxGB: 1.6, tier: 'mid', note: 'Recommended default — good quality on a decent phone.' },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', label: 'Smart (3B)', approxGB: 2.9, tier: 'high', note: 'Best quality; laptops / strong phones.' },
];

export const DEFAULT_MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';

// During `npm run dev`, pin the model to the average-student device (1.5B) so what
// we feel while developing matches what a typical student feels. This overrides both
// device auto-detection AND any Settings pick, so a dev laptop won't silently load 3B.
// Production builds keep the real device-based auto-pick (recommendModel).
export const DEV_STUDENT_MODEL_ID = DEFAULT_MODEL_ID;

export function modelById(id: string): ModelOption | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Recommend a model from device memory (best-effort; conservative). */
export function recommendModel(): ModelOption {
  const mem = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  if (typeof mem === 'number') {
    if (mem >= 8) return MODELS[2]; // 3B
    if (mem >= 4) return MODELS[1]; // 1.5B
    return MODELS[0]; // 0.5B
  }
  return MODELS[1]; // unknown → balanced
}

const KEY = 'maestro.model.v1';

export function getSelectedModelId(): string {
  // Dev: always feel the average student's model, regardless of laptop RAM or a stale
  // Settings pick. Benchmark still lets you compare models via its own dropdown.
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) return DEV_STUDENT_MODEL_ID;
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(KEY);
      if (raw && modelById(raw)) return raw;
    }
  } catch {
    /* ignore */
  }
  return recommendModel().id;
}

export function setSelectedModelId(id: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
}
