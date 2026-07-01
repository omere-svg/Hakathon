// Feature flags — the modular control surface. Every non-core capability is a flag
// here so it can be toggled on-device (Settings page) without breaking the rest.
// Persisted to localStorage; safe defaults in Node (tests) where localStorage is absent.

export interface FeatureFlags {
  /** grammar/JSON-constrained structured turns (reliability on small models) */
  structuredOutput: boolean;
  /** candidates generated per turn; the verifier picks the first clean one (1 = off) */
  bestOfN: number;
  /** verify → re-prompt the model with a correction on a violation */
  repair: boolean;
  /** include authored few-shot exemplars in the prompt */
  exemplars: boolean;
  /** lay out the prompt with the constant prefix first (KV/prefix-cache friendly) */
  prefixCache: boolean;
  /** persist the student model across sessions (IndexedDB) */
  persistence: boolean;
  /** revisit weak concepts over time */
  spacedRepetition: boolean;
}

export const DEFAULT_FLAGS: FeatureFlags = {
  // OFF by default: WebLLM 0.2.84's grammar/JSON-schema mode (response_format:
  // json_object) throws an uncatchable "Cannot pass non-string to std::string" in
  // GrammarCompiler.CompileJSONSchema, which never resolves and hangs the whole turn.
  // Free-text generation is the reliable path. Re-enable once WebLLM fixes the binding.
  structuredOutput: false,
  bestOfN: 2,
  repair: true,
  exemplars: true,
  prefixCache: true,
  persistence: true,
  spacedRepetition: false,
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
