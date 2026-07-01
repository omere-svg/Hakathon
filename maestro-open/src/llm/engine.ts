import type { LLMEngine } from './types';
import { createWebLLMEngine, webgpuAvailable } from './webllm';
import { getSelectedModelId } from './models';

// Loads the on-device model. There is NO template fallback — if WebGPU is missing or
// the model fails to load, the caller shows an honest "unsupported" screen.
// `fellBack: true` means "no model available", not "using templates".
// `modelId` defaults to the user's selected/recommended model; the benchmark page
// passes explicit ids to compare models.
export async function getLLM(
  _kind: 'webllm',
  onProgress?: (text: string) => void,
  modelId?: string,
): Promise<{ llm: LLMEngine | null; fellBack: boolean; reason?: string }> {
  if (!webgpuAvailable()) {
    return { llm: null, fellBack: true, reason: 'WebGPU is not available in this browser.' };
  }
  try {
    const llm = await createWebLLMEngine(onProgress, modelId ?? getSelectedModelId());
    return { llm, fellBack: false };
  } catch (err) {
    return { llm: null, fellBack: true, reason: `The on-device model failed to load (${(err as Error).message}).` };
  }
}
