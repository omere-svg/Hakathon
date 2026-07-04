// Model quirks — the per-model-family behavior that would otherwise leak into the
// engine-creation code (webllm.ts). Each model family gets a small adapter satisfying
// ModelQuirks; `quirksFor(modelId)` resolves the right one. Switching between Qwen
// variants — or adding a new family — means adding a quirks object and a branch here,
// NEVER editing createWebLLMEngine.

import { getFlags } from '../config/features';

/** Everything the WebLLM adapter needs to know about how a specific model family behaves.
 *  Kept deliberately small: this is a seam, not a config bag. */
export interface ModelQuirks {
  /** id of the family, for logging/debugging. */
  readonly family: string;
  /** Text appended to the system prompt (e.g. Qwen3's `/no_think` soft switch). '' = none.
   *  Read per call so a runtime setting change (the `thinking` flag) is honoured each turn. */
  systemSuffix(): string;
  /** Clean one raw completion before the app sees it (e.g. strip Qwen3 `<think>` blocks). */
  cleanOutput(text: string): string;
  /** Token budget for one completion (thinking modes need extra headroom). */
  maxTokens(): number;
  /** Vendor-recommended default sampling for this family; per-call GenOptions override it.
   *  Read per call so the `thinking` flag is honoured each turn. Sources + per-scenario
   *  table: knowledge base 05-research/temperature-per-scenario.md. */
  sampling(): { temperature: number; topP: number };
}

const DEFAULT_MAX_TOKENS = 280;

/** Baseline: no special handling. Any model without a dedicated quirks object gets this. */
const baseQuirks: ModelQuirks = {
  family: 'base',
  systemSuffix: () => '',
  cleanOutput: (text) => text,
  maxTokens: () => DEFAULT_MAX_TOKENS,
  sampling: () => ({ temperature: 0.7, topP: 1 }),
};

/** Qwen3 is a hybrid *thinking* model. We honour the `thinking` flag via the `/think` |
 *  `/no_think` soft switch, strip the `<think>…</think>` block so it never pollutes prose
 *  or our free-text JSON parsing (also handles an unclosed block), and give thinking mode
 *  extra token headroom so the reasoning block doesn't starve the answer.
 *  Sampling follows the Qwen3 model card: 0.7/0.8 non-thinking, 0.6/0.95 thinking — and
 *  NEVER greedy (temp 0), which the card warns causes degradation and endless repetition. */
const qwen3Quirks: ModelQuirks = {
  family: 'qwen3',
  systemSuffix: () => (getFlags().thinking ? ' /think' : ' /no_think'),
  cleanOutput: (text) =>
    text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*$/i, '')
      // The soft-switch tokens we append to the system prompt get ECHOED back sometimes —
      // one surfaced inside a student-facing suggestion chip ("I'm not sure, honestly
      // /no_think"). They are control tokens, never content.
      .replace(/\/(?:no_)?think\b/gi, '')
      .trim(),
  maxTokens: () => (getFlags().thinking ? 1024 : DEFAULT_MAX_TOKENS),
  sampling: () => (getFlags().thinking ? { temperature: 0.6, topP: 0.95 } : { temperature: 0.7, topP: 0.8 }),
};

/** Resolve the quirks for a model id. Add new families above and branch here — the WebLLM
 *  engine adapter consumes this and stays untouched. Order matters if ids overlap. */
export function quirksFor(modelId: string): ModelQuirks {
  if (/qwen3/i.test(modelId)) return qwen3Quirks;
  return baseQuirks;
}
