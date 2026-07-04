import type { GenOptions, LLMEngine } from './types';
import { DEFAULT_MODEL_ID } from './models';
import { quirksFor } from './quirks';

// On-device LLM via WebLLM/WebGPU. Dynamically imported and optional: if WebGPU
// is missing or load fails, callers show an honest "unsupported" screen.
//
// This adapter is model-AGNOSTIC: all per-family behavior (thinking soft-switch, output
// cleaning, token budget) lives behind the ModelQuirks seam (quirks.ts). Adding or switching
// a model family never touches this file.
export const DEFAULT_MODEL = DEFAULT_MODEL_ID;

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

// A generation should never hang forever. Some WebLLM failures reject in a detached
// promise (so an await never settles); this bounds every call so the UI recovers with
// an honest error instead of a permanent "…" spinner. `onTimeout` must actually STOP
// the generation — otherwise the orphaned run keeps the GPU busy and every subsequent
// call queues behind it, wedging the session.
const GEN_TIMEOUT_MS = 120_000;
function withTimeout<T>(p: Promise<T>, what: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* best-effort interrupt */
      }
      reject(new Error(`${what} timed out after ${GEN_TIMEOUT_MS / 1000}s`));
    }, GEN_TIMEOUT_MS);
    p.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}

export async function createWebLLMEngine(
  onProgress?: (text: string) => void,
  model: string = DEFAULT_MODEL,
): Promise<LLMEngine> {
  if (!webgpuAvailable()) throw new Error('WebGPU not available');
  const webllm = await import('@mlc-ai/web-llm');
  const engine = await webllm.CreateMLCEngine(model, {
    initProgressCallback: (r: { text: string }) => onProgress?.(r.text),
  });
  const quirks = quirksFor(model);
  const messages = (system: string, user: string) => [
    { role: 'system' as const, content: system + quirks.systemSuffix() },
    { role: 'user' as const, content: user },
  ];

  return {
    name: `WebLLM · ${model}`,
    onDevice: true,
    async complete(system: string, user: string, opts?: GenOptions): Promise<string> {
      // Defaults come from the model family's vendor-recommended sampling (quirks);
      // callers override per scenario — see 05-research/temperature-per-scenario.md.
      const sampling = quirks.sampling();
      const res = await withTimeout(
        engine.chat.completions.create({
          messages: messages(system, user),
          temperature: opts?.temperature ?? sampling.temperature,
          top_p: opts?.topP ?? sampling.topP,
          max_tokens: opts?.maxTokens ?? quirks.maxTokens(),
        }),
        'complete',
        () => engine.interruptGenerate(),
      );
      return quirks.cleanOutput((res.choices[0]?.message?.content ?? '').trim());
    },
    async unload(): Promise<void> {
      await engine.unload();
    },
  };
}
