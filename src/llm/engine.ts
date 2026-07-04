import type { LLMEngine } from './types';
import { createWebLLMEngine, webgpuAvailable } from './webllm';
import { modelById, resolveModelId, smallerModelId } from './models';
import { getFlags } from '../config/features';

/** Does this error look like the GPU ran out of memory / lost the device? WebLLM surfaces
 *  these as "device was lost … insufficient memory" or an out-of-memory allocation failure. */
function isOutOfMemory(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return /out of memory|device was lost|insufficient memory|gpudevicelost|failed to allocate|oom/.test(msg);
}

/** Load a model, stepping down to the next-smaller catalog model on an out-of-memory error.
 *  This is the real safety net behind the device picker: signals only guess the tier, so an
 *  over-optimistic pick recovers here instead of crashing the tab. Step-down is disabled for
 *  explicit ids (e.g. the benchmark) so comparisons stay honest. */
async function loadWithStepDown(
  startId: string,
  onProgress: ((text: string) => void) | undefined,
  allowStepDown: boolean,
): Promise<LLMEngine> {
  let id = startId;
  const tried = new Set<string>();
  for (;;) {
    try {
      return await createWebLLMEngine(onProgress, id);
    } catch (err) {
      tried.add(id);
      const next = allowStepDown ? smallerModelId(id) : undefined;
      if (!next || tried.has(next) || !isOutOfMemory(err)) throw err;
      onProgress?.(`Not enough memory for that model — switching to a lighter one (${modelById(next)?.label ?? next})…`);
      id = next;
    }
  }
}

// Loads the on-device model. There is NO template fallback — if WebGPU is missing or
// the model fails to load, the caller shows an honest "unsupported" screen.
// `fellBack: true` means "no model available", not "using templates".
// `modelId` defaults to the device-resolved model; explicit ids disable the OOM step-down.
//
// The loaded engine is CACHED at module level: LessonPage unmounts on route navigation
// (Lesson → Settings → Lesson), and re-instantiating the WebLLM WASM runtime both re-loads
// a multi-GB model and corrupts the Embind type registry (see LessonPage init guard).
// Navigating back must reuse the live engine; a different model id unloads the old one first.
let cached: { requestedId: string; loading: Promise<LLMEngine> } | null = null;

export async function getLLM(
  _kind: 'webllm',
  onProgress?: (text: string) => void,
  modelId?: string,
): Promise<{ llm: LLMEngine | null; fellBack: boolean; reason?: string }> {
  // Opt-in CPU/WASM backend (fine-tuned GGUF builds). No WebGPU requirement and no
  // step-down: the GGUF catalog is a single explicit model. Cached like WebLLM below.
  if (getFlags().backend === 'wllama') {
    try {
      const { createWllamaEngine, DEFAULT_WLLAMA_MODEL_ID, WLLAMA_MODELS } = await import('./wllama');
      // Callers pass WebLLM catalog ids; only honour ids the GGUF catalog actually knows.
      const ggufId = modelId && modelId in WLLAMA_MODELS ? modelId : DEFAULT_WLLAMA_MODEL_ID;
      const id = `wllama:${ggufId}`;
      if (cached && cached.requestedId === id) {
        onProgress?.('Reusing the already-loaded on-device model…');
        return { llm: await cached.loading, fellBack: false };
      }
      if (cached) {
        const old = cached;
        cached = null;
        try {
          await (await old.loading).unload?.();
        } catch {
          /* the old engine may already be dead — proceed with the fresh load */
        }
      }
      const loading = createWllamaEngine(onProgress, ggufId);
      cached = { requestedId: id, loading };
      try {
        return { llm: await loading, fellBack: false };
      } catch (err) {
        cached = null;
        throw err;
      }
    } catch (err) {
      return { llm: null, fellBack: true, reason: `The wllama backend failed to load (${(err as Error).message}).` };
    }
  }
  if (!webgpuAvailable()) {
    return { llm: null, fellBack: true, reason: 'WebGPU is not available in this browser.' };
  }
  try {
    const explicit = modelId != null;
    const id = modelId ?? (await resolveModelId());
    if (cached && cached.requestedId === id) {
      onProgress?.('Reusing the already-loaded on-device model…');
      return { llm: await cached.loading, fellBack: false };
    }
    if (cached) {
      // Model switch: release the old runtime before loading the new one.
      const old = cached;
      cached = null;
      try {
        await (await old.loading).unload?.();
      } catch {
        /* the old engine may already be dead — proceed with the fresh load */
      }
    }
    const loading = loadWithStepDown(id, onProgress, /* allowStepDown */ !explicit);
    cached = { requestedId: id, loading };
    try {
      const llm = await loading;
      return { llm, fellBack: false };
    } catch (err) {
      cached = null; // a failed load must not poison future attempts
      throw err;
    }
  } catch (err) {
    return { llm: null, fellBack: true, reason: `The on-device model failed to load (${(err as Error).message}).` };
  }
}
