import type { LLMEngine } from './types';

// WASM/CPU fallback EXTENSION POINT (for devices without WebGPU).
// The LLMEngine interface is runtime-agnostic, so a wllama-based CPU engine can slot in
// here without touching the orchestrator/verifier. Not yet implemented — building a
// performant wllama runtime is out of scope for now, so the honest "unsupported device"
// screen remains the floor. This stub documents the seam and keeps it typed.
//
// To implement: load wllama, return an LLMEngine whose complete()/completeStructured()
// proxy to the CPU model. Then wire getLLM() to try WebGPU → WASM → unsupported.
export async function createWasmEngine(_onProgress?: (text: string) => void): Promise<LLMEngine> {
  throw new Error('WASM/CPU fallback (wllama) is not implemented yet — see src/llm/wasm.ts.');
}
