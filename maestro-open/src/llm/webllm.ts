import type { LLMEngine } from './types';
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
// an honest error instead of a permanent "…" spinner.
const GEN_TIMEOUT_MS = 120_000;
function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${what} timed out after ${GEN_TIMEOUT_MS / 1000}s`)), GEN_TIMEOUT_MS);
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
    async complete(system: string, user: string): Promise<string> {
      const res = await withTimeout(
        engine.chat.completions.create({
          messages: messages(system, user),
          temperature: 0.5,
          max_tokens: quirks.maxTokens(),
        }),
        'complete',
      );
      return quirks.cleanOutput((res.choices[0]?.message?.content ?? '').trim());
    },
    // JSON-mode (grammar-constrained) generation. The schema is described in the
    // system prompt; response_format pins valid JSON. Returns null on parse failure
    // so the caller can fall back to free-text.
    async completeStructured(system: string, user: string): Promise<Record<string, unknown> | null> {
      try {
        const res = await withTimeout(
          engine.chat.completions.create({
            messages: messages(system, user),
            temperature: 0.4,
            max_tokens: quirks.maxTokens(),
            response_format: { type: 'json_object' } as { type: 'json_object' },
          }),
          'completeStructured',
        );
        const raw = quirks.cleanOutput((res.choices[0]?.message?.content ?? '').trim());
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
  };
}
