# Architecture — Maestro Open (current / canonical, v2.5)

> This is the **current, implemented** architecture (Engine **v2.5 — "Smart Offline / Lean Online"**). It supersedes the v1 "deterministic engine is the brain" design — see [architecture-spec.md](architecture-spec.md), kept only as historical record.
> Full reasoning for the offline/on-device split: [../05-research/offline-to-ondevice-pipeline.md](../05-research/offline-to-ondevice-pipeline.md).
> **Plain-English turn-by-turn flow ("how the small model actually teaches"): [how-tutoring-works.md](how-tutoring-works.md).**
> Everything runs **in the browser**: a real LLM on the user's device via WebLLM/WebGPU, plus deterministic engine code. No per-user server, no cloud inference. Static hosting only → $0 COGS.

---

## Design principle (v2.5)

> **Pay for intelligence once, offline, with a frontier model → ship static JSON. On-device, a small model only *delivers* that plan in conversation. A deterministic verifier closes the gap.**

Not "a chatbot" (a bare model slips on the failure modes). Not "a deterministic engine that sidelines the model" (v1 — brittle keyword theater). The winning shape is **LLM-first tutoring** where the heavy pedagogical judgment is **pre-authored offline** and the on-device model does **conversational realization**, wrapped by **tool-verification + verify-and-repair**. There are **no template fallbacks** — what the user sees is the model.

**Three roles, cleanly separated (separation of concerns):**

| Layer | Who / when | Job | Must NOT do |
|---|---|---|---|
| **Authoring** | Big model, offline, once per course | Decide *what* to teach + *how to teach it well* → rich JSON | Run at user-time ($) |
| **Realization** | Small model, on-device, per turn | *Deliver* the plan conversationally to this student | Pick curriculum, judge correctness, invent facts |
| **Verification** | Deterministic code, on-device, per turn | Guarantee the delivery broke no pedagogical rule | Write the reply |

The 10 TutorBench failure modes are **acceptance tests, not implementation targets**. We encode universal rules (constraints C1–C10); the scenarios pass as a consequence.

## The per-turn pipeline

```
 student message
   │
   ▼
 readCues (deterministic)        name preference · distress · request type · is-this-an-answer
   │
   ▼
 grade active check (TOOLS)      code-runner / calculator / MCQ — the AUTHORITATIVE correctness verdict
   │
   ▼
 buildSituation + brief          verified facts + mode (challenge?) + grading verdict + memory (name, mastery, affect)
   │
   ▼
 LLM drafts the reply            the on-device model — the real intelligence; handles any input
   │
   ▼
 verify (deterministic)          does the draft obey the situation? (no leak / no false-validate / states facts / empathy / …)
   │   └─ violation → re-prompt the model with a precise correction (≤2)
   ▼
 guard (structural scrub)        redact a rejected name (C1) or a leaked answer (C2) from the model's OWN text
   │
   ▼
 commit + evaluate C1–C10        update student model + lesson memory; produce the scoreboard checks
   ▼
 tutor reply
```

The LLM appears at exactly two places: drafting and re-drafting. Understanding the student's *content* is the model's job (it reads the message as it drafts); the deterministic `readCues` only flags the few safety-relevant signals, and **tools** — never the model — judge correctness.

## Components (all on-device)

- **Domain model** (`domain/`) — a lesson = ordered **knowledge components** (KCs), each with: a **Presentation Guideline** (the authored "how to teach this well": coreIdea, analogy, teaching arc, emphasize, avoid), worked example, deterministically-gradeable checks (MCQ/numeric/code/keyword) + answer keys, misconception→remediation maps, and hint ladders. Authored **offline** by a big model (one-time per course, validated), shipped as static JSON → rich content at $0 per user. Currently: the while-loop lesson (3 KCs); BIZ unit-economics drafted. The **Presentation Guideline is the v2.5 artifact** that lets a small model teach reliably — it renders authored pedagogy instead of inventing it.
- **Student model** (`student/`) — per-KC mastery + attempts + `explained` + hints used; affect (frustration/confidence); preferences (name). Drives adaptivity. (In-session now; IndexedDB persistence is future work.)
- **Tools** (`tools/`) — `codeRunner` (JS sandbox), `calculator` (incl. Python `//`/`%`), `grader`. The source of truth for correctness.
- **The verify/repair layer** (`engine/verify.ts` + `orchestrator.ts`) — **the moat**. `verify()` produces repairable violations; the orchestrator re-prompts the model; `guard()` gives a *structural* guarantee for C1 (name) and C2 (no answer leak) by scrubbing the model's own text; `evaluateChecks()` scores C1–C10 for the board.
- **LLM layer** (`llm/`) — WebLLM (`Qwen2.5-1.5B` default), `complete(system, user)`. Required; no model → honest unsupported screen.
- **Eval harness** (`eval/`) — runs the **same on-device model with vs without the engine**. Honest scoreboard.

## Constraints C1–C10

| | Universal rule | Acceptance test | Guarantee |
|---|---|---|---|
| C1 | honor stated name | SWE-10/BIZ-10 | structural (scrub) |
| C2 | no answer leak in challenge | SWE-03/BIZ-03 | structural (scrub) |
| C3 | never validate incorrect work | SWE-01/BIZ-01 | tools + re-prompt |
| C4 | facts/math from tools | SWE-02/BIZ-02 | tools + re-prompt |
| C5 | explain before testing | SWE-05/BIZ-05 | model + verify |
| C6 | scaffold, not independence | SWE-06/BIZ-06 | model + verify |
| C7 | stay on target | SWE-04/BIZ-04 | model + verify |
| C8 | signpost transitions | SWE-08/BIZ-08 | model + verify |
| C9 | acknowledge distress first | SWE-09/BIZ-09 | model + re-prompt |
| C10 | concrete runnable artifact | SWE-07/BIZ-07 | model + re-prompt |

## Why this wins
- **Genuinely intelligent + engaging** — the model teaches and handles arbitrary input; not on-rails.
- **Reliable on the failure modes** — tools verify, the verifier re-prompts, and C1/C2 are structurally guaranteed.
- **Honest proof** — `/evals` runs the same model with/without the engine; green means the model truly complied (no template masking).
- **$0 COGS, on-device, uses Maestro lesson structure.**

## Honesty stance (explicit product decision)
No faked experiences. If a device lacks WebGPU, it sees a clear "unsupported" message — not a templated imitation of teaching. The scoreboard is honest, not guaranteed-green.

## Making it run GREAT on a small phone LLM
The headline differentiator is performance on a 1.5–3B on-device model. We treat that as a *systems* problem — reduce what the model decides (offline authoring), **constrain how it generates** (grammar-constrained decoding), **verify cheaply** (best-of-N + re-prompt), ground it in tools, and speed it on the phone (prefix-cache, routing). Full playbook + build sequence: **[../05-research/small-llm-performance-playbook.md](../05-research/small-llm-performance-playbook.md)**.

## Modularity — every feature is a toggleable module
All non-core capabilities are flags in `src/config/features.ts` (persisted; safe Node defaults), read by the orchestrator via `resolveConfig()` (overridable per-call — the benchmark uses this). The **Settings page (`/settings`)** toggles each on-device; turning any off degrades gracefully to the core engine. Modules: structured output, best-of-N, repair, exemplars, prefix-cache layout, persistence, spaced-repetition, model-picker (`llm/models.ts`), PWA service worker (prod-only), WASM fallback (extension point `llm/wasm.ts`).

## Status / scope (see [roadmap.md](roadmap.md))
Implemented: the pipeline above; **Phase 1** (grammar-constrained structured turns, best-of-N + verifier-pick, few-shot exemplars, verify→re-prompt); **Phase 2** the **Benchmark page** (`/benchmark`: pass-rate/latency/repair, engine vs raw, per model); **Phase 3** device-tiered model picker + PWA; **Phase 4** persistent progress + minimal spaced repetition + BIZ lesson + authoring scaffold; **Phase 5** content-validation + honest states. Verify all: `npm run verify:all`. Scaffolded (honest): logit answer-ban, full wllama WASM runtime, one-click authoring pipeline, lesson-picker UI, BKT.
