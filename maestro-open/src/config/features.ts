// Feature flags — the modular control surface. Every non-core capability is a flag
// here so it can be toggled on-device (Settings page) without breaking the rest.
// Persisted to localStorage; safe defaults in Node (tests) where localStorage is absent.

/** which tutoring engine LessonPage runs (see engine/index.ts). Milestone is the only one. */
export type EngineId = 'milestone';

/** which runtime executes the on-device model. webllm = WebGPU (default, fastest);
 *  wllama = llama.cpp WASM on CPU — the deployment path for fine-tuned GGUF builds
 *  (the MLC conversion toolchain for fine-tuned weights is broken upstream). */
export type LLMBackend = 'webllm' | 'wllama';

export interface FeatureFlags {
  /** which tutoring engine drives the lesson. */
  engine: EngineId;
  /** which on-device runtime serves LLM calls (see llm/engine.ts). */
  backend: LLMBackend;
  /** Qwen3 "thinking" mode. When true, the model emits a <think> reasoning block before
   *  answering (higher latency); when false we append /no_think. Dev-only toggle — used to
   *  measure the latency cost of thinking. No effect on non-Qwen3 models. */
  thinking: boolean;
}

export const DEFAULT_FLAGS: FeatureFlags = {
  // The model-driven Goal→Milestone flow (the only engine).
  engine: 'milestone',
  // wllama serves the Maestro fine-tuned GGUF build (2026-07-04). Flip back to
  // 'webllm' to run the stock model on WebGPU.
  backend: 'wllama',
  // OFF by default: /no_think keeps latency low and the reasoning block out of our
  // free-text JSON parsing. Toggle on in dev (Settings) to feel the latency cost.
  thinking: false,
};

const KEY = 'maestro.flags.v1';
type Listener = (f: FeatureFlags) => void;
const listeners = new Set<Listener>();

function hasStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

let cache: FeatureFlags | null = null;

export function getFlags(): FeatureFlags {
  if (cache) return cache;
  if (hasStorage()) {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) cache = { ...DEFAULT_FLAGS, ...(JSON.parse(raw) as Partial<FeatureFlags>) };
    } catch {
      /* ignore */
    }
  }
  cache = cache ?? { ...DEFAULT_FLAGS };
  return cache;
}

export function setFlags(patch: Partial<FeatureFlags>): FeatureFlags {
  cache = { ...getFlags(), ...patch };
  if (hasStorage()) {
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      /* ignore */
    }
  }
  listeners.forEach((l) => l(cache as FeatureFlags));
  return cache;
}

export function resetFlags(): FeatureFlags {
  return setFlags(DEFAULT_FLAGS);
}

export function subscribeFlags(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
