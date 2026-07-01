// The on-device LLM is the tutor's language brain. The deterministic engine decides
// the SITUATION; the LLM drafts; the verifier checks. Two generation modes:
//  - complete: free-text draft.
//  - completeStructured: JSON-mode (grammar-constrained) draft → parsed object, or null
//    if the model/runtime can't produce valid JSON (caller falls back to complete).
export interface LLMEngine {
  name: string;
  onDevice: boolean;
  complete(system: string, user: string): Promise<string>;
  completeStructured?(system: string, user: string): Promise<Record<string, unknown> | null>;
}
