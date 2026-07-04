import type { GenOptions, LLMEngine } from './types';
import { quirksFor } from './quirks';
// Vite resolves the wasm to a hashed asset URL; wllama fetches it at runtime.
import wllamaWasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';

// On-device LLM via wllama (llama.cpp compiled to WASM, CPU-only). This exists because
// the MLC weight-conversion toolchain for fine-tuned models is broken upstream, while
// the GGUF path (convert_hf_to_gguf.py + llama-quantize) is robust — so fine-tuned
// builds ship as GGUF and run through this adapter. WebLLM/WebGPU remains the default
// backend for stock models; the `backend` feature flag switches between them.
//
// Multi-threading needs SharedArrayBuffer, i.e. cross-origin-isolated pages (COOP/COEP
// headers — set for `npm run dev` in vite.config.ts). Without them wllama silently runs
// single-threaded, which is several times slower; benchmark numbers are only meaningful
// with the headers on.

/** GGUF models this adapter knows how to serve. In dev the shards are read from
 *  public/models/ (gitignored — they are 1GB+ build artifacts produced by
 *  finetune/scripts/, not source); production builds fetch the same shards from the
 *  Hugging Face CDN, because Vercel caps static files at 100MB. Models are
 *  SHARDED with llama-gguf-split (≤400MB per shard): wllama's WASM aborts loading a
 *  single 1.2GB file (observed live) and its docs cap recommended shards at 512MB.
 *  The URL points at shard 1; wllama auto-fetches the rest from the -0000N-of-0000M names. */
const MODELS_BASE = import.meta.env.DEV
  ? '/models/'
  : 'https://huggingface.co/omerere/qwen3-1.7b-maestro-gguf/resolve/main/';

export const WLLAMA_MODELS: Record<string, { url: string; label: string }> = {
  'Qwen3-1.7B-q4_k_m-GGUF': { url: `${MODELS_BASE}qwen3-1.7b-q4_k_m-00001-of-00004.gguf`, label: 'Qwen3 1.7B (GGUF, stock)' },
  'Qwen3-1.7B-maestro-q4_k_m-GGUF': { url: `${MODELS_BASE}qwen3-1.7b-maestro-q4_k_m-00001-of-00003.gguf`, label: 'Qwen3 1.7B (GGUF, fine-tuned)' },
};

export const DEFAULT_WLLAMA_MODEL_ID = 'Qwen3-1.7B-maestro-q4_k_m-GGUF';

// Same rationale as webllm.ts: a generation must never hang the UI forever. wllama
// accepts an AbortSignal, so on timeout we abort the underlying generation too.
const GEN_TIMEOUT_MS = 240_000; // CPU decoding is slower than WebGPU — give it more room.

export async function createWllamaEngine(
  onProgress?: (text: string) => void,
  modelId: string = DEFAULT_WLLAMA_MODEL_ID,
): Promise<LLMEngine> {
  const entry = WLLAMA_MODELS[modelId];
  if (!entry) throw new Error(`Unknown wllama model: ${modelId}`);
  const { Wllama, LoggerWithoutDebug } = await import('@wllama/wllama');
  const wllama = new Wllama({ default: wllamaWasmUrl }, { logger: LoggerWithoutDebug });
  onProgress?.('Loading the on-device model (CPU/WASM)…');
  const loadOptions = {
    n_ctx: 4096,
    progressCallback: ({ loaded, total }: { loaded: number; total: number }) => {
      if (total > 0) onProgress?.(`Downloading model: ${Math.round((loaded / total) * 100)}%`);
    },
  };
  try {
    await wllama.loadModelFromUrl(entry.url, loadOptions);
  } catch (err) {
    // An interrupted first download leaves a partial shard set in the origin's OPFS
    // cache; wllama's getModels() then throws "Model file not found: <shard>" on every
    // subsequent visit instead of re-downloading (upstream bug in ModelManager —
    // getAllFiles runs before validation can mark the model INVALID). Clearing the
    // cache and retrying once turns a permanently bricked origin into one slow reload.
    if (!(err instanceof Error && err.message.includes('Model file not found'))) throw err;
    onProgress?.('Cached model was incomplete — re-downloading…');
    await wllama.cacheManager.clear();
    await wllama.loadModelFromUrl(entry.url, loadOptions);
  }
  // Quirks are keyed off the model id; our GGUF ids contain "Qwen3" so the Qwen3
  // thinking soft-switch + <think> stripping apply exactly as on the WebLLM path.
  const quirks = quirksFor(modelId);

  return {
    name: `wllama · ${entry.label}`,
    onDevice: true,
    async complete(system: string, user: string, opts?: GenOptions): Promise<string> {
      const sampling = quirks.sampling();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error(`complete timed out after ${GEN_TIMEOUT_MS / 1000}s`)), GEN_TIMEOUT_MS);
      try {
        const res = await wllama.createChatCompletion({
          messages: [
            { role: 'system', content: system + quirks.systemSuffix() },
            { role: 'user', content: user },
          ],
          temperature: opts?.temperature ?? sampling.temperature,
          top_p: opts?.topP ?? sampling.topP,
          max_tokens: opts?.maxTokens ?? quirks.maxTokens(),
          abortSignal: abort.signal,
        });
        return quirks.cleanOutput((res.choices[0]?.message?.content ?? '').trim());
      } finally {
        clearTimeout(timer);
      }
    },
    async unload(): Promise<void> {
      await wllama.exit();
    },
  };
}
