# Maestro Open

A $0-COGS, on-device AI tutor for the Masterschool hackathon. A real model runs **privately on the user's device** (WebLLM + WebGPU) — no servers, no per-user inference cost. The product is **not** "a chatbot," and **not** "a deterministic engine that sidelines the model." It is:

> **An on-device LLM tutor wrapped in a deterministic verify-and-repair layer.** The model does the teaching and understanding; deterministic code owns only what LLMs get wrong (correctness, answer-leaks, validating wrong work) and re-prompts the model until it complies. What you see is the model — there are no template fallbacks.

## Architecture (one turn)

```
student message
  → readCues          deterministic safety signals: name pref, distress, request type, is-answer
  → gradeActive       TOOLS judge correctness (code-runner / calculator / MCQ) — authoritative
  → buildSituation    + a "situation brief": verified facts, mode, grading verdict, memory
  → LLM drafts        the on-device model writes the reply (the real intelligence)
  → verify            deterministic checks vs the verified situation
      ↳ on violation: re-prompt the model with a precise correction (≤2 tries)
  → guard             structural scrub for C1 (rejected name) + C2 (leaked answer) only
  → commit + checks   update student model / memory; evaluate C1–C10 for display
```

The LLM is **required** (WebGPU). No model → an honest "unsupported device" screen; we never fake teaching.

## Modules

- `engine/` — the whole brain wrapper:
  - `cues.ts` — deterministic safety-signal extraction (name / distress / request type / answer).
  - `grade.ts` + `tools/` — authoritative correctness: `codeRunner`, `calculator`, `grader`.
  - `situation.ts` — the Situation + the prompt builders (engine / raw control / correction) + brief.
  - `verify.ts` — **the moat**: `verify()` (repairable violations), `guard()` (C1/C2 scrub), `evaluateChecks()` (C1–C10 for the scoreboard).
  - `orchestrator.ts` — `runTurn`: draft → verify → re-prompt → guard → commit.
- `domain/` — lesson model (knowledge components, checks, misconceptions, hint ladders) + the **while-loop lesson** (3 KCs). Authored offline → static.
- `student/` — student model: per-KC mastery, attempts, `explained`, hints, affect (frustration/confidence), preferences. (In-session; IndexedDB persistence is future work.)
- `memory/` — lesson memory (current KC, phase, active check, challenge flag, transcript window).
- `llm/` — WebLLM adapter (`complete(system, user)`); loader returns an honest "no model" signal.
- `eval/` — the 10 TutorBench failure modes as acceptance tests, graded by universal constraints; runs the **same on-device model with vs without the engine**.
- `pages/` — `LessonPage` (gated on model-ready), `EvalsPage` (proof of performance). UI in `components/`.

## Constraints C1–C10 (universal rules → acceptance tests)

| | Rule | Enforced by | Guarantee |
|---|---|---|---|
| C1 | honor stated name | guard scrub + verify | **structural** |
| C2 | no answer leak in challenge mode | guard scrub + verify | **structural** |
| C3 | never validate incorrect work | tools + verify → re-prompt | model + repair |
| C4 | facts/math from tools, not made up | calculator + verify → re-prompt | model + repair |
| C5 | explain before testing | situation brief + verify | model |
| C6 | scaffold, don't demand independence | brief + verify | model |
| C7 | stay on target (free answers) | brief + verify | model |
| C8 | signpost topic transitions | brief + verify | model |
| C9 | acknowledge distress first | brief + verify → re-prompt | model + repair |
| C10 | concrete runnable artifact (no placeholders) | brief + verify → re-prompt | model + repair |

We encode the **rule**; the scenario is the **test**. No scenario-specific code.

## Run

```bash
npm install
npm run dev          # "/" lesson · "/#/practice" evals · "/#/benchmark" proof · "/#/settings" toggles
npm run build        # tsc --noEmit + vite build
npm run eval:check   # 18 verifier unit tests (no model) — the moat
npm run smoke        # stub-LLM integration: Orchestrator → LLM → Verifier → repair/guard
npm run validate     # authoring-time content validation (keys, no leaked hints, DAG prereqs)
npm run author -- "<course outline>"   # print the frontier-model authoring prompt (offline, $0/user)
npm run verify:all   # build + eval:check + smoke + validate (run before every push)
```

## Routes
- **`/`** — the lesson (loads the on-device model; honest unsupported screen if no WebGPU).
- **`/#/benchmark`** — **proof of performance**: pick a model → 10 failure modes, engine vs raw, pass-rate + latency + repairs. **Run this on your phone.**
- **`/#/practice`** — the evals scoreboard.
- **`/#/settings`** — toggle every feature module + pick the model, on-device.

## Modular feature flags (`src/config/features.ts`, toggle in Settings)
`structuredOutput` (grammar/JSON turns) · `bestOfN` (verifier-pick) · `repair` (verify→re-prompt) · `exemplars` (few-shot) · `prefixCache` (prompt layout) · `persistence` (resume across sessions) · `spacedRepetition`. The orchestrator reads them via `resolveConfig()` (overridable per-call; the benchmark uses this). **Turn any off and the rest still works.**

- **Lesson** runs the real model; toggle **"Show engine"** to see the chosen act + live C1–C10 checks + the student-model state.
- **Evals** loads the model and runs each failure mode with the engine vs the raw model. **Honest scoreboard** — green means the model genuinely complied.
- Default model: `Qwen2.5-1.5B` ([llm/webllm.ts](src/llm/webllm.ts)). For the demo, consider `Qwen2.5-3B-Instruct-q4f16_1-MLC` on a laptop.

## v2.5 — Smart Offline / Lean Online

Each knowledge component carries an authored **Presentation Guideline** (coreIdea / analogy / teaching arc / emphasize / avoid) — the big model decides *how to teach*, the small model just delivers it. See [../maestro-pocket-hackathon-knowledge-base/05-research/offline-to-ondevice-pipeline.md](../maestro-pocket-hackathon-knowledge-base/05-research/offline-to-ondevice-pipeline.md). A **BIZ unit-economics lesson** ([src/domain/bizLesson.ts](src/domain/bizLesson.ts)) is drafted with the same decomposition (one engine, CS + Business), registered in [src/domain/lessons.ts](src/domain/lessons.ts).

## Deliberately out of scope (future)

Non-WebGPU lite mode (we show an honest unsupported screen instead), IndexedDB persistence, lesson/course picker UI, the offline authoring *pipeline* (big-model course→JSON, a build-time tool), PWA/offline, BKT, prerequisite-graph traversal.
