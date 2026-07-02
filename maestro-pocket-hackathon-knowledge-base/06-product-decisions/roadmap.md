# Roadmap — Maestro Open

> Headline: **a model-driven tutor that runs great on a small LLM, locally on the user's phone, at $0.** Architecture: [architecture.md](architecture.md). Small-model techniques: [../05-research/small-llm-performance-playbook.md](../05-research/small-llm-performance-playbook.md).
> Status: ✅ done · 🟡 partial · ⬜ not started. **Verify:** `npm run verify:all` (= typecheck + build).
>
> **Note (2026-07):** the project pivoted from a deterministic verify-and-repair engine (constraints C1–C10, `/evals`, `/benchmark`, authored-KC content model) to the **Milestone Engine**. That old engine and its dead code were removed; this roadmap reflects the current build only.

## Done ✅

**Milestone Engine (the product).** Model-driven Goal→Milestone flow, engine-agnostic `TutorEngine` contract:
- ✅ **Bounded recursive decomposition** (`decompose.ts`) — split each Mastery Goal into ordered micro-milestones; caps `maxDepth 3 / maxLeaves 8 / maxCalls 12`; graceful fallback to the brief's goals.
- ✅ **Milestone loop** (`engine.ts`) — per turn: assess (`{achieved, evidence}`) → teach-again or sync + advance; **strict per-milestone context isolation** (window 8); minimal bridge across transitions.
- ✅ **Free-text JSON salvage** (`json.ts`) — robust extraction of `achieved` / sub-goals / suggestion lists without grammar mode.
- ✅ **Dynamic suggestion chips** — model proposes 4 quick replies per turn (static fallback).
- ✅ **Transparency dev panel** — mastery goals, live goal decomposition, and every on-device LLM call (prompt/response/latency).

**Content.** ✅ Lessons parsed from the Maestro Week-3 course reference (`domain/exampleLessons.ts` → `LessonBrief`); a random lesson per load. **Content-free** — no authoring pipeline required.

**Reach / device.** 
- ✅ **Device-tiered model picker** (`llm/models.ts`) — Qwen3 family (0.6B/1.7B/4B) + Qwen2.5-0.5B floor; `probeDevice`/`pickModel` from WebGPU adapter limits + `deviceMemory` + iOS detection; manual override; persists. (See [../05-research/mobile-device-strategy.md](../05-research/mobile-device-strategy.md).)
- ✅ **Load-time OOM step-down** (`llm/engine.ts`) — on device-lost/out-of-memory, retry the next-smaller model.
- ✅ **Qwen3 `/no_think` + `<think>` strip** (`llm/webllm.ts`); dev-only `thinking` toggle to measure latency.
- ✅ **PWA** — app-shell service worker (prod-only registration); WebLLM caches weights → offline after first load.
- ✅ **Honest unsupported screen** when WebGPU/model is unavailable (no faked teaching).

## Next 🟡 / ⬜ — harden the model-driven engine
From [../05-research/milestone-engine-weak-spots.md](../05-research/milestone-engine-weak-spots.md) and [../05-research/milestone-engine-long-conversation.md](../05-research/milestone-engine-long-conversation.md), highest-value first:
- ⬜ **Impasse handling** — attempt counter → escalating scaffold (hint → worked example → bottom-out) → dynamic re-split → hard turn cap, so a stuck milestone never loops forever.
- ⬜ **3-way assessment** — return `achieved | attempted-miss | confused/asking` instead of a bare bool, and branch the teaching move on it.
- ⬜ **Smart compaction** — replace the sliding window with a consolidation checkpoint (summarise every few turns) to fight context rot.
- 🟡 **JSON reliability** — re-test WebLLM grammar-constrained decoding on upgrade; re-enable if fixed (biggest reliability unlock). Until then, harden the free-text salvage.
- ⬜ **Latency** — fold suggestion chips into the teach call / generate them cheaply; skip the assess call on non-answers; stream the teach reply.
- ⬜ **Persistence** — serialise the `MilestoneQueue` so a reload resumes instead of re-decomposing (nothing is persisted today).

## Later ⬜ — depth
- ⬜ **Scenario hardening + a light eval** — targeted rails for the TutorBench failure modes (answer-leak, don't-validate-wrong-work, empathy-first) and a small on-device check to demonstrate them. (This is the capability the removed verify engine provided — see [product-idea.md](product-idea.md) §5.)
- ⬜ **Fine-tuning** — distil a frontier model's teaching + reliable JSON into Qwen3-1.7B via Unsloth → MLC → HF → custom WebLLM model. (See the model-strategy research.)
- ⬜ **WASM/CPU fallback** for no-WebGPU devices; in-app lesson picker.

## Modularity
Only two feature flags remain (`config/features.ts`): `engine` (which tutoring engine) and `thinking` (Qwen3 think mode, dev-only). The old per-feature flags were removed with the code they gated.
