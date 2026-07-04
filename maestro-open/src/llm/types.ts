// The on-device LLM is the tutor's language brain. One generation mode:
//  - complete: free-text draft, with optional per-call overrides so structured phases
//    (assess / sync / decompose) can run near-deterministic while teaching stays creative,
//    and long-output phases (sync) get a bigger token budget.
// (Grammar/JSON mode is deliberately absent: it hangs in WebLLM 0.2.x with Qwen3, and
// 0.2.84 is the latest release — free-text + salvage parsing in engine/milestone/json.ts
// is the reliable path.)

/** Per-call generation overrides. Omitted fields use the model-quirks defaults.
 *  Per-scenario values: knowledge base 05-research/temperature-per-scenario.md.
 *  NEVER pass temperature 0 — Qwen3's model card forbids greedy decoding (degenerate/
 *  repetitive output); "deterministic" phases use 0.3 and rely on the JSON salvage layer. */
export interface GenOptions {
  /** 0.3 for grading/JSON phases; model-quirks default for teaching prose. */
  temperature?: number;
  /** nucleus sampling cutoff; model-quirks default if omitted. */
  topP?: number;
  /** token budget override (e.g. sync needs more room than a chat turn). */
  maxTokens?: number;
}

export interface LLMEngine {
  name: string;
  onDevice: boolean;
  complete(system: string, user: string, opts?: GenOptions): Promise<string>;
  /** Release the underlying runtime (GPU buffers, WASM instance). Optional: stubs skip it. */
  unload?(): Promise<void>;
}
