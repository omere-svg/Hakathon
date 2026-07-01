# Roadmap — from working slice to real, best-in-class software

> Headline: **runs great on a small LLM, locally on the user's phone, at $0.** Every non-core feature is an independent, toggleable **module** (Settings page / `src/config/features.ts`) so it can be disabled on a struggling device without breaking the rest.
> Techniques: [../05-research/small-llm-performance-playbook.md](../05-research/small-llm-performance-playbook.md). Architecture: [architecture.md](architecture.md).
> Status: ✅ done · 🟡 partial/scaffolded · ⬜ not started. **Verify everything: `npm run verify:all`** (build + verifier tests + smoke + content validation).

## Phase 0 — Engine foundation ✅
LLM-first v2.5 pipeline (cues → tools-grade → situation+brief → LLM draft → verify→re-prompt → guard scrub → commit); presentation guidelines; 10 constraints C1–C10; tools; honest stance (no template fallback; unsupported screen). While-loop + BIZ lessons. Tests green.

## Phase 1 — Make the small model demonstrably GREAT ✅ (tunable, can deepen)
- ✅ **Grammar/JSON-constrained structured turns** (`completeStructured` + `STRUCTURED_INSTRUCTION`/`renderStructured`) — flag `structuredOutput`.
- ✅ **Best-of-N + verifier-pick** — sample N drafts, verifier picks the first clean one — flag `bestOfN`.
- ✅ **Authored few-shot exemplars** per act (`KnowledgeComponent.exemplars`) — flag `exemplars`.
- ✅ **Verify→re-prompt** with precise corrections — flag `repair`.
- 🟡 **Logit answer-ban** in challenge mode — currently the `guard()` scrub gives the structural C2 guarantee; a true decoder-level token ban is a future upgrade.

## Phase 2 — PROVE it (demo centerpiece) ✅
- ✅ **Benchmark page** (`/benchmark`): pick a model → runs the 10 failure modes **with engine vs raw**, reports **pass-rate, median latency, repair count**, and the **lift**. Run it on your phone to show the gain.
- ✅ Per-turn **latency + repair** metrics in the runner.

## Phase 3 — Run on the user's real phone (reach) ✅ / 🟡
- ✅ **Device-tiered model picker** (`src/llm/models.ts`, Settings) — auto-recommends 0.5B/1.5B/3B by device memory; manual override; persists.
- ✅ **Prefix-cache-friendly prompt layout** (constant prefix first) — flag `prefixCache`. 🟡 explicit cross-turn KV reuse pending runtime support.
- ✅ **PWA** — manifest + icon + service worker (app-shell offline, network-first navigations; prod-only registration). Weights cached by WebLLM.
- 🟡 **WASM/CPU fallback** — `src/llm/wasm.ts` is a typed extension point; full wllama runtime not implemented (honest unsupported screen is the floor).

## Phase 4 — Real-product depth ✅ / 🟡
- ✅ **Persistent progress** (`src/storage/progress.ts`, localStorage) — resumes the student across sessions — flag `persistence`. (Interface swappable to IndexedDB.)
- 🟡 **Spaced repetition** (`src/student/spacedRepetition.ts`) — minimal: resume at the weakest unmastered concept — flag `spacedRepetition`. Full forgetting-curve scheduler is future.
- ✅ **Lesson registry** (`src/domain/lessons.ts`) with while-loop + BIZ; 🟡 in-app lesson/course **picker UI** pending.
- ✅ **Offline authoring scaffold** (`npm run author`) — emits the frontier-model prompt to turn a course outline into lesson JSON. 🟡 a one-click pipeline (API call) is future.
- ⬜ Model-initiated tool calls (off-script math/code).

## Phase 5 — Productionization / hardening ✅ / 🟡
- ✅ **Content validation** (`npm run validate`) — checks every lesson: gradeable keys, no hint leaks the answer, remediations are questions, prerequisites form a DAG.
- ✅ Honest error/loading/unsupported states.
- 🟡 Sandbox hardening for the in-browser code-runner; onboarding (Wi-Fi-only download prompt); analytics opt-in.

## How the modularity works (toggle anything)
`src/config/features.ts` holds all flags (persisted, with safe Node defaults). The orchestrator reads them via `resolveConfig()` (overridable per-call — the benchmark uses this). The Settings page (`/settings`) toggles each on-device. Turning any feature off degrades gracefully to the core engine — nothing else breaks.
