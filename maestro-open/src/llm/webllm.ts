import type { LLMEngine } from './types';

// On-device LLM via WebLLM/WebGPU. Dynamically imported and optional: if WebGPU
// is missing or load fails, callers fall back to deterministic templates.
export const DEFAULT_MODEL = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';

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
  const messages = (system: string, user: string) => [
    { role: 'system' as const, content: system },
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
          max_tokens: 280,
        }),
        'complete',
      );
      return (res.choices[0]?.message?.content ?? '').trim();
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
            max_tokens: 300,
            response_format: { type: 'json_object' } as { type: 'json_object' },
          }),
          'completeStructured',
        );
        const raw = (res.choices[0]?.message?.content ?? '').trim();
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
  };
}
