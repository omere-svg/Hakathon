# Offline-to-On-Device Pipeline — "Smart Offline / Lean Online" (v2.5)

> ⚠️ **HISTORICAL — describes the REMOVED verify engine.** The **verification layer** and the **authored knowledge-component content model** in this doc were built and then **removed**; the current build is the model-driven **Milestone Engine** ([../06-product-decisions/architecture.md](../06-product-decisions/architecture.md)), which teaches directly from Mastery Goals with **no authored JSON and no deterministic verifier**. Kept for two reasons: (1) the **offline-authoring thesis** (§0–1) is still the reference design for a *future* content pipeline (roadmap "Later"), and (2) the §3 failure-mode analysis still catalogues where small models slip. Ignore the C1–C10 / orchestrator / `verify.ts` / `eval:check` / `smoke` specifics — that code no longer exists.
>
> Research + design for how intelligence *could* be distributed across an authoring pipeline.
> Builds on [tutoring-architecture-patterns.md](tutoring-architecture-patterns.md) (ITS / CBM / dialogue-system grounding).
> Thesis in one line: **move every expensive judgment to a strong model OFFLINE (once per course), and keep the on-device small model's job as narrow as possible — conversational realization of a pre-authored plan — with a deterministic verifier closing the gap.**

---

## 0. Why this separation matters

A 1.5B–3B model that runs free on a phone is a **weak reasoner but a competent talker.** Every decision we ask it to make live (what to teach next, is this answer correct, what's the right hint, may I reveal the answer) is a decision it can get wrong. The strategic move is therefore:

> **Pay for intelligence once, offline, with a frontier model. Ship the result as static JSON. On-device, the small model only *delivers* that intelligence in conversation.**

This keeps **$0 COGS** (offline authoring is one-time per course, amortized across all students → ~$0/user; never a per-user cloud call), maximizes **reliability** (the small model does less thinking), and still feels **engaging** (a real model converses with the student). It is the natural endpoint of the offline-authoring insight we already committed to — pushed as far as it can go without making the tutor a scripted slideshow.

Three roles, cleanly separated:

| Layer | Who | Job | Must NOT do |
|---|---|---|---|
| **Authoring** | Big model, offline, once/course | Decide *what* to teach and *how to teach it well* → rich JSON | Run at user-time (would cost money) |
| **Realization** | Small model, on-device, per turn | *Deliver* the plan conversationally to this student | Decide curriculum, judge correctness, invent facts |
| **Verification** | Deterministic code, on-device, per turn | Guarantee the delivery didn't break a pedagogical rule | Write the reply (it checks/scrubs/re-prompts) |

---

## 1. The Big Model (offline authoring): decomposing a course into rich JSON

Goal: turn a Maestro/LMS course (lesson outline + mastery outcomes; see [example-maestro-lesson-structure.md](../02-maestro-product-reference/example-maestro-lesson-structure.md)) into a JSON the small model can deliver with almost no reasoning. Decomposition, in order:

### (a) Knowledge Components (KCs)
The atomic unit: **one teachable idea that can be independently checked and mastered.** Heuristics for the big model:
- Split a lesson's mastery outcomes into the smallest ideas that each have their own "aha." ("while-loop basics," "infinite-loop risk," "writing a while loop" — not one blob "while loops.")
- Each KC declares **prerequisites** (KC ids) → a dependency order. (Runtime may walk it linearly for MVP, but authoring should record the graph.)
- A KC is too big if it needs more than ~1–2 checks to demonstrate; too small if it can't stand alone as a check. This granularity is what makes the **student model** (per-KC mastery) meaningful and lets the policy advance precisely.

### (b) Presentation Guidelines (the new v2.5 artifact)
This is the heart of "smart offline." For each KC, the big model authors **how to teach it well** — the judgment a 1.5B can't produce live:
- **coreIdea** — the one sentence the student must walk away with.
- **analogy** — the best intuition pump (authored by a model that actually knows good analogies).
- **arc** — an ordered list of talking points: how to build the idea up (enables *show-before-tell*).
- **emphasize** — the 1–2 things to stress.
- **avoid** — the pitfalls / what NOT to say (e.g., "don't mention `break` yet," "don't give the formula before the intuition").
- **checkIntro** — how to transition naturally into the question.

The small model receives these as its teaching instructions and renders them in its own warm words, adapted to the student. The big model decided *the pedagogy*; the small model supplies *the conversation*. This is the single biggest reliability lever: a generic 1.5B "explain recursion" is mediocre; a 1.5B told "here's exactly the angle, analogy, and order to use, now say it warmly to this student" is reliably good.

### (c) Hint Ladders
A graduated sequence, **gentle → specific, none revealing the answer.** Authoring method (work backward from the solution):
- Rung 1: redirect attention ("look at the loop condition").
- Rung 2: name the relevant relationship ("what does the condition depend on?").
- Rung 3: a near-worked sub-step ("if `count` never changes, can `count < 5` ever become false?").
- The last rung may be a worked *fragment*, never the full answer.
The runtime picks the rung by the student's hint count / mastery (scaffolding floor). Authoring guarantees no rung contains the answer — checked at authoring-validation time and again by the runtime verifier.

### (d) Expected Misconceptions
For each KC, enumerate the **specific wrong beliefs** students hold, each with:
- **description** — the wrong belief in words ("a while loop needs an explicit `break` to stop").
- **signals** — how it shows up (a specific wrong MCQ option, a keyword pattern, a wrong code shape).
- **remediation** — *a gap-revealing question, not the answer* ("a while loop stops on its own when its condition turns false — what would have to change for `count < 5` to become false?").
Sources the big model mines: the wrong MCQ options, classic error catalogs for the topic, and the difference between "wrong" and "wrong *because of* belief X." This is what turns a flat "try again" into targeted teaching (the CORRECT act).

### (e) Checks + answer keys
Each KC carries **deterministically gradeable** checks (MCQ / numeric / code / keyword) with an answer key the **tools** (never the model) evaluate. Free-text conceptual checks are allowed but graded conversationally (no auto-verdict) — the runtime keeps the student on target rather than asserting correctness.

### Authoring-time validation (don't ship bad JSON)
A strong model's output is not automatically correct. Before a course is published, an offline validation pass must: run every code/numeric check against its key; assert no hint contains the canonical answer; assert each misconception's remediation is a question, not the answer; assert KC prerequisites form a DAG. **"$0 at runtime" ≠ "free of authoring risk"** — a wrong key makes the deterministic engine confidently teach wrong, which is worse than an LLM hedging.

---

## 2. The Small Model (on-device runtime): conversational realization only

**Definition of its role:** given a *situation brief* assembled deterministically from the authored JSON + the student model, produce **one warm, adapted tutor turn**. That's it. It is a *renderer with judgment about phrasing*, not a tutor that reasons about pedagogy or facts.

What it **does**: read the student's last message in context; pick the right words; adapt tone; weave in the authored guideline (analogy, arc, emphasis); ask the authored/handed question; respond to tangents conversationally.

What it **must not do** (and is structurally prevented from doing):
- Decide what concept comes next → the runtime state machine does (from KC mastery).
- Judge whether an answer is correct → **tools** do; the verdict is handed to the model in the brief.
- Compute arithmetic → the **calculator** does; verified values are handed in.
- Decide whether it may reveal an answer → **mode** (challenge) + the verifier decide; the answer key is *withheld from its context* in challenge mode.

Why this split fits a small model's true competence (from small-LLM research, see [local-models-comparison.md](local-models-comparison.md)): small models follow **short, explicit instructions** and **rephrase given content** far better than they **reason multi-step**, **follow many simultaneous rules**, or **resist sycophancy**. The brief gives it few, explicit instructions and the content to convey — its strong suit. We never ask it for the things it's weak at.

**Prompt contract** (system = persona + authored guideline + situation brief; user = bounded transcript + student message): ≤4 sentences, end with one question when teaching, never state the answer in challenge/hint, address the preferred name, use the verified values verbatim. The tighter and more pre-decided the brief, the more reliable the small model.

**Latency note:** because most decisions are pre-authored and handed in, the model usually needs **one** forward pass per turn (a re-prompt only on a verifier violation). Templated transitions add no model calls.

---

## 3. The Moat (verification): closing the Smart-JSON ↔ Small-Model gap

Even with perfect JSON, there is an **intent–execution gap**: the plan says "nudge, don't tell," but the small model, asked "just give me the answer," may comply and leak it. The verifier exists precisely to close this gap. It is the difference between "we hope the model behaves" and "we guarantee it."

### Where a 1.5–3B is most likely to fail (ranked — drives where we harden)
1. **Sycophancy / validating wrong work** (highest). Small models love to agree; "is this right?" → "Yes, great job!" even when the tool says it's wrong. → C3.
2. **Answer-leak under pressure.** "just tell me" in challenge mode → it tells. → C2.
3. **Made-up numbers.** Any arithmetic it does itself is suspect. → C4 (and we pre-compute, so it shouldn't do any).
4. **Skipping empathy / leading with content** when the student is distressed. → C9.
5. **Not asking a question / rambling** — ending a "teaching" turn without a check, or wandering off-target. → C7 + a "must-probe-on-wrong-answer" rule.
6. **Dropping the preferred name** / using the rejected one. → C1.
7. **Placeholder code** instead of a runnable artifact. → C10.

### The two-tier guarantee
- **Structural (cannot fail):** what we can deterministically scrub from the model's *own* text — **C1** (delete the rejected name) and **C2** (redact a leaked canonical answer). Plus *withholding* the answer key from the prompt in challenge mode so there's usually nothing to leak. These are guarantees, not hopes.
- **Verify → re-prompt (model + repair):** for the rest (C3 don't-validate, C4 facts, C9 empathy, C5/C6/C7/C8/C10), the verifier inspects the draft against the *verified situation* (tool verdict, mode, computed facts, distress cue) and, on a violation, **re-prompts the model with a precise correction** ("their code returns 10, expected 6 — do NOT say it's right; ask a question"). Small models comply well with a *specific* correction even when they failed the general instruction. Capped at 2 re-prompts.
- **Tools are authoritative for correctness** so the verifier never depends on the small model to know if an answer was right.

### Honesty stance
There is **no template fallback**. If, after re-prompts + scrub, a non-structural check still fails, the turn reflects the model's real (imperfect) behavior — surfaced honestly on the `/evals` scoreboard. We strengthen reliability by (a) richer authored briefs → fewer violations, (b) better corrections → higher repair success, not by masking failures with canned text.

### Why richer JSON and the verifier are complementary, not redundant
Richer presentation guidelines **reduce the rate** of violations (the model is better-briefed, so it slips less) → fewer re-prompts → faster, smoother turns. The verifier **bounds the worst case** regardless of how the model behaves. Authoring raises the floor; verification caps the ceiling of damage. You need both.

---

## 4. The v2.5 design (definitive)

```
OFFLINE (once per course, big model)                ON-DEVICE (per turn, $0)
┌───────────────────────────────────┐               ┌───────────────────────────────────────────┐
│ Course outline (Maestro/LMS)        │   static      │ readCues (name/distress/request/answer)     │
│   → decompose:                      │   JSON        │ grade active check  ← TOOLS (authoritative) │
│     • Knowledge Components + prereqs │ ───────────▶  │ buildSituation + brief (FROM authored JSON) │
│     • Presentation Guidelines        │   shipped     │ small model DRAFTS the turn                 │
│     • Hint Ladders                   │   with app    │ verify → re-prompt (≤2)                      │
│     • Expected Misconceptions        │               │ guard scrub (C1 name, C2 leak)              │
│     • Gradeable checks + keys         │               │ commit + evaluate C1–C10                    │
│   → authoring-time validation        │               └───────────────────────────────────────────┘
└───────────────────────────────────┘
```

Separation of concerns, restated: **Authoring = intelligence. Realization = conversation. Verification = trust.** No layer does another's job.

---

## 5. Open risks / honest caveats
- **Over-scripting** → a slideshow that breaks on off-script input. Mitigation: presentation guidelines are *guidance to render*, not verbatim scripts; the model still owns the live conversation; a bounded free-response path handles tangents (return to target, never leak/validate).
- **Authoring quality** → wrong keys teach wrong confidently. Mitigation: authoring-time validation pass (§1).
- **On-demand "new course" processing** is **one-time-per-course, offline/admin**, cached and served to all — *never* a per-user cloud call (that would break $0). This is a library + an expansion pipeline, not real-time generation per student.
- **Small-model variance** is real; the verifier bounds it but a 3B on the demo laptop is the safe choice.

---

## 6. Implementation mapping (what this doc drives)
- **Schema:** add `presentation` (PresentationGuideline) to the knowledge-component type; situation brief consumes it.
- **Verifier hardening:** strengthen C3 (must-probe-on-wrong + no answer hand-over), C9 (empathy must lead), keep C1/C2 structural.
- **BIZ lesson:** author a unit-economics lesson with the §1 decomposition to prove the method generalizes beyond CS.
- **Authoring pipeline** (future, build-time tool): the §1 decomposition is the target schema for a big-model `author` script.

---

## 7. Implementation notes & resolutions (v2.5 build)

What was implemented from this research, and issues resolved during the build (all left green):

- **Schema:** added `PresentationGuideline` (coreIdea / analogy / arc / emphasize / avoid) to the knowledge-component type; the situation `reference()` now feeds it to the small model as explicit teaching instructions. Populated for all 3 while-loop KCs and the BIZ lesson.
- **Verifier hardening (per §3 failure ranking):**
  - **C3 (sycophancy, the #1 failure)** now has three guards on a wrong answer: don't affirm, don't hand over the canonical answer, and must end with a probing question (re-prompt if absent).
  - **C9 (empathy)** now requires empathy to **lead** (first ~160 chars), not trail after content.
- **Bug found & fixed during the build:** the affirmation detector matched the bare substring `"correct"`, so a tutor correctly saying **"that's incorrect"** was falsely flagged as validating wrong work (a C3 false-positive that would trigger needless re-prompts). Resolution: split affirmations into **word-boundary words** (`correct`, `perfect`, `exactly`, `yes`) + multi-word phrases, so `"incorrect"` no longer matches. Added a regression test (`C3 says incorrect (ok)`).
- **Tests:** `eval:check` rewritten/extended to **18 verifier unit tests** (no model) covering C1–C10 + the strengthened behaviors + the regression. Added `npm run smoke` — a stub-LLM integration test that drives a full turn through Orchestrator → LLM → Verifier → repair/guard, asserting (1) C2 holds even against a model that *always* leaks (guard scrub), and (2) C3 is repaired via re-prompt when the model complies on correction.
- **State at handoff:** `npm run build` ✓, `npm run eval:check` ✓ (18/18), `npm run smoke` ✓. No template fallbacks; no references to deleted v1 modules; BIZ lesson wired via `domain/lessons.ts` registry.

### Sources / consistency
- Consistent with [tutoring-architecture-patterns.md](tutoring-architecture-patterns.md) (ITS domain/student/tutor split; CBM constraints; "what to say vs how to say it").
- Small-model role grounded in [local-models-comparison.md](local-models-comparison.md) and [webllm-research.md](webllm-research.md).
- The v1 "deterministic brain" spec and this v2.5 verify design were both superseded by the model-driven Milestone Engine ([../06-product-decisions/architecture.md](../06-product-decisions/architecture.md)).
