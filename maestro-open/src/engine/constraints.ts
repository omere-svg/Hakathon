// Kept for import-path stability. The constraint logic now lives in verify.ts
// (verifiers + evaluateChecks). The deterministic "policy cascade" engine was
// replaced by the LLM-first engine in orchestrator.ts.
export type { ConstraintCheck } from './verify';
export { evaluateChecks, verify, guard } from './verify';
