import type { LLMEngine } from './types';
import { createWebLLMEngine, webgpuAvailable } from './webllm';
import { modelById, resolveModelId, smallerModelId } from './models';

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
// `modelId` defaults to the device-resolved model; the benchmark page passes explicit
// ids to compare models (which also disables the OOM step-down for a fair comparison).
export async function getLLM(
  _kind: 'webllm',
  onProgress?: (text: string) => void,
  modelId?: string,
): Promise<{ llm: LLMEngine | null; fellBack: boolean; reason?: string }> {
  if (!webgpuAvailable()) {
    return { llm: null, fellBack: true, reason: 'WebGPU is not available in this browser.' };
  }
  try {
    const explicit = modelId != null;
    const id = modelId ?? (await resolveModelId());
    const llm = await loadWithStepDown(id, onProgress, /* allowStepDown */ !explicit);
    return { llm, fellBack: false };
  } catch (err) {
    return { llm: null, fellBack: true, reason: `The on-device model failed to load (${(err as Error).message}).` };
  }
}
