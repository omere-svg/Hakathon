# Architecture — Maestro Open (current / canonical)

> The **current, implemented** architecture: a single **model-driven Milestone Engine** running on an on-device LLM (WebLLM/WebGPU). Everything runs in the browser — no per-user server, no cloud inference, static hosting only → **$0 COGS**.
>
> **History (2026-07):** an earlier design put a **deterministic verify-and-repair engine** around the model (constraints C1–C10, an orchestrator, tool-graded correctness, an authored knowledge-component content model, `/evals` + `/benchmark` pages). That engine was **removed** in favour of the model-driven milestone flow below. The old design docs (`architecture-spec.md`, the v2.5 `architecture.md`, `how-tutoring-works.md`) were deleted; the dead code (verify engine, authored-KC `domain/` schema, `student/`, `tools/`, `memory/`, `storage/`, authoring scripts) was cleaned out. This doc describes only what exists now.

---

## Design principle

> **The model owns the thinking.** Given a lesson's Mastery Goals, the local model decomposes them into ordered milestones, teaches each one, and judges when it's achieved — with **no deterministic net**. Cheap deterministic *rails* (bounded recursion, context isolation, JSON salvage, `/no_think`) keep a small model from running away, but the pedagogy and the judgment are the model's.

This is deliberately the opposite of the old verify-engine philosophy. The bet: a well-scoped small model, kept on a short leash (tiny isolated context per milestone, one micro-goal at a time), can teach and self-assess well enough — and the design stays **content-free** (no per-lesson authoring), so it generalises to any lesson immediately.

## The runtime path (what actually executes)

```
main.tsx → App → Routes
   /          → LessonPage   ─┐
   /settings  → SettingsPage  │
                              ▼
 LessonPage:
   pickRandomExampleBrief()          parse Week-3 Maestro course reference (markdown) → LessonBrief (ordered Mastery Goals)
   getLLM('webllm')                  resolve device model → load WebLLM engine (OOM step-down)
   createEngine('milestone', …)      the sole TutorEngine
   engine.start() / engine.respond() render reply + suggestion chips + dev panel
```

Lesson content is **not** authored JSON — `domain/exampleLessons.ts` parses the shared reference file (`02-maestro-product-reference/example-maestro-lesson-structure.md`) into a `LessonBrief` (title + ordered goal statements) and picks a random lesson per load, so the engine is exercised across the whole week.

## The Milestone Engine algorithm (`src/engine/milestone/`)

**Decomposition (once, at `start()`) — `decompose.ts`.** Recursively split each Mastery Goal: the model decides a goal is *atomic* (teachable + checkable in one ~3–5 min turn) or splits it into 2–3 ordered sub-goals; recurse; flatten the leaves into a `MilestoneQueue`. Bounded on three axes so an erratic small model can't run away: `maxDepth 3`, `maxLeaves 8`, `maxCalls 12` (`DEFAULT_LIMITS`). Any parse/model failure at a node degrades that node to a leaf; if recursion yields nothing usable, it falls back to the brief's own ordered goals.

**Milestone loop (per student turn) — `engine.ts` `respond()`, with strict context isolation** (the model sees only the *current* milestone's transcript, last `CONTEXT_WINDOW = 8` turns):
1. **Assess** — "is THIS milestone achieved?" → JSON `{achieved, evidence}`. Skipped until the student has actually said something.
2. **Not achieved** → **Teach** one more turn for this milestone (isolated context).
3. **Achieved** → **Sync** (cross-check the *remaining* milestones for implicit achievement, each requiring cited student evidence) → advance the queue. On advance, a minimal *bridge* (completed title + student's last message) makes the transition read continuously.
4. **Suggest** — ask the model for 4 quick-reply chips for the UI (falls back to static chips).

There is **no** deterministic verify/guard/grade step — by design.

## The LLM layer (`src/llm/`)

- **WebLLM/WebGPU**, dynamically imported. Model resolved by the **device-tiered picker** (`models.ts` `probeDevice`/`pickModel`) — Qwen3 family (`floor` Qwen2.5-0.5B → `low` Qwen3-0.6B → `mid` Qwen3-1.7B → `high` Qwen3-4B) — with a **load-time OOM step-down** (`engine.ts` `loadWithStepDown`). See [../05-research/mobile-device-strategy.md](../05-research/mobile-device-strategy.md) and [../05-research/local-models-comparison.md](../05-research/local-models-comparison.md).
- **Qwen3 runs non-thinking** by default: `webllm.ts` appends `/no_think` to the system prompt and strips any `<think>…</think>` block, so latency stays low and JSON parsing isn't polluted. A **dev-only `thinking` toggle** (Settings) flips this to measure the latency cost.
- **Grammar/JSON-constrained decoding is OFF** (WebLLM 0.2.84 hangs on it), so every JSON verdict (decompose / assess / sync / suggest) is parsed from **free text** via robust salvage in `json.ts` (`extractJson`, `parseAchieved`, `parseStringList`).

## Components (all on-device)

- **`engine/api.ts`** — the small shared `TutorEngine` contract (`start`/`respond` → `TurnView`), `LessonBrief`/`MasteryGoal`, and dev-panel types (`PlanStep`, `LlmCall`, `EngineDebug`).
- **`engine/index.ts`** — engine registry/factory (`createEngine`). Milestone is the sole engine; the registry shape is kept so another engine could slot in behind the same contract.
- **`engine/milestone/`** — `engine.ts` (loop), `decompose.ts` (recursive split + refine), `prompts.ts` (all prompt builders + persona + context rendering), `json.ts` (free-text JSON salvage), `types.ts` (`MilestoneQueue`, `CONTEXT_WINDOW`).
- **`domain/exampleLessons.ts`** — the only content source (parses the reference markdown → `LessonBrief`).
- **`llm/`** — `models.ts` (catalog + device picker), `webllm.ts` (model-agnostic WebLLM adapter), `quirks.ts` (the **ModelQuirks seam** — per-family behavior like Qwen3's `/no_think` soft-switch, `<think>` stripping, and token budget; `quirksFor(modelId)` resolves it so switching model families never touches `webllm.ts`), `engine.ts` (`getLLM` + OOM step-down), `types.ts`.
- **`config/features.ts`** — the two live flags: `engine` and `thinking`.
- **`pages/`** — `LessonPage` (the chat loop; engine-agnostic), `SettingsPage` (model picker + dev thinking toggle).
- **`components/EngineDebugPanel.tsx`** — the "Show engine" dev view (mastery goals, live decomposition, per-turn LLM-calls trace), extracted from `LessonPage` (pure presentation).
- **PWA** — `main.tsx` registers a service worker in production only (app-shell offline; WebLLM caches weights).

## Feature flags
Only two, both actually read at runtime (`config/features.ts`): **`engine`** (which tutoring engine — milestone) and **`thinking`** (Qwen3 think mode, dev-only). All other flags from the old engine (structured-output, best-of-N, repair, exemplars, prefix-cache, persistence, spaced-repetition) were removed with the code they gated.

## Honesty stance
No faked experiences. No WebGPU / model won't load → a clear **"unsupported"** screen, never a templated imitation of teaching. The tutor's replies are the real model output (cleaned of role-play bleed and `<think>` blocks).

## Known gaps (tracked, not yet built)
The model-driven design has no rail for a few failure modes — see [../05-research/milestone-engine-weak-spots.md](../05-research/milestone-engine-weak-spots.md) and [../05-research/milestone-engine-long-conversation.md](../05-research/milestone-engine-long-conversation.md):
- **Impasse handling** — a stuck milestone can loop; needs attempt-counter → escalating scaffold → dynamic re-split → hard cap.
- **Binary assessment** — `{achieved}` can't distinguish "confused" from "attempted-and-missed".
- **Fragile JSON parsing** — regex fallback fires often while grammar mode is disabled; revisit on a WebLLM upgrade.
- **Latency** — 2–3 serial on-device calls per turn.

## Why this shape
- **$0 COGS, on-device, offline-capable** — the only thing that scales for the target user (low-income, phone-first). See [../05-research/webllm-research.md](../05-research/webllm-research.md).
- **Content-free** — works on any lesson's Mastery Goals with no authoring pipeline, so it generalises across the whole course immediately.
- **Small-model-honest** — the model does only what it's put on a short leash to do (one micro-goal, tiny context); the rails are cheap and deterministic. Full technique catalogue: [../05-research/small-llm-performance-playbook.md](../05-research/small-llm-performance-playbook.md).
