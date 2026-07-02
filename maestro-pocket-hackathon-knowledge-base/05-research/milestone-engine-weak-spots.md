# Milestone Engine — weak-spot audit & high-value improvements

**Status:** review of the algorithm as written. **No code changed.**
**Date:** 2026-07-01
**Scope:** `maestro-open/src/engine/milestone/` — `engine.ts`, `decompose.ts`, `prompts.ts`,
`types.ts`, `json.ts`. Read against [`api.ts`](../../maestro-open/src/engine/api.ts).

Read alongside [`milestone-engine-long-conversation.md`] (which deep-dives the biggest one, #1).
Severity: 🔴 breaks the demo / traps the learner · 🟠 quality/reliability · 🟢 polish.

---

## The design in one paragraph
The engine is **fully model-driven with no deterministic safety net** (by explicit design — the
comment in `engine.ts` says so, and the `verify` engine is the netted alternative, see
[`milestone-engine-alternative`]). The local model owns decomposition, assessment, and cross-check.
That's elegant and content-free, but it means **every weak spot below is a place where a dumb model
has no guardrail.** The improvements are about adding *cheap, deterministic* rails without giving up
the model-driven soul.

---

## 🔴 #1 — No impasse handling: a stuck milestone loops forever
`respond()` only branches on `assess.achieved`. If assessment keeps returning `false`, the engine
`teach`es the same milestone with no attempt counter, no escalation, no re-split, no force-advance.
A confused student is **trapped indefinitely** on one sub-goal, and (per the context-rot research)
the model gets *worse* the longer it loops. This is the single most important gap.
→ **Fix:** the bounded self-healing loop in [`milestone-engine-long-conversation.md`] (attempt
counter → escalating scaffold → dynamic re-split → hard cap). Non-negotiable for a live demo.

## 🔴 #2 — Assessment is binary; the loop can't adapt
`assess` returns `{achieved, evidence}` — a single bool. So a student who is **confused and asking a
question** is treated identically to one who **attempted and missed**: both just "keep teaching."
The engine can't choose between *re-explain differently*, *answer the meta-question*, or *re-ask*.
→ **Fix:** return a small enum (`achieved | attempted-miss | confused/asking | off-topic`) and switch
the teaching move on it. Cheap change, large adaptivity gain. Pairs with the scaffold ladder.

## 🟠 #3 — Fragile achievement parsing → false advances / false traps
Grammar/JSON-constrained decoding is **OFF** (WebLLM 0.2.84 bug, per `config/features.ts`), so
`parseAchieved` ([`json.ts`](../../maestro-open/src/engine/milestone/json.ts)) frequently hits its
**regex fallback**: it scans raw text for `achieved|yes|correct|…`. Problems:
- A tutor-style rationale like *"the student is **correct** that a loop repeats"* trips the
  affirmative regex → **false achieve** → premature advance.
- `no` / `not` matching is crude → **false negative** → contributes to the #1 loop trap.
Given small models rarely emit clean JSON, this path fires often.
→ **Fix:** (a) prefer a *structured two-call* or few-shot format the small model reliably produces;
(b) make the fallback require an explicit verdict token near the *start* of the reply, not anywhere;
(c) re-evaluate WebLLM grammar mode on upgrade (tracked in `small-llm-performance-playbook.md` §2 as
the "single biggest reliability unlock").

## 🟠 #4 — Decomposition is one-shot and immutable
`decompose()` runs once at `start()`; the queue never changes except by Sync marking things achieved.
If a leaf turns out too big for the learner, nothing can split it later; if the *order* the model
chose is wrong, there's no recovery. The tree is frozen at init, before the engine has met the
student.
→ **Fix:** the **dynamic re-split** on impasse (Mechanism B in the long-conversation doc) makes
decomposition adaptive. Also consider a light validation pass on the initial tree (dedupe near-
identical leaves, cap leaf count) since the model sometimes over-splits.

## 🟠 #5 — 2–3 sequential on-device LLM calls per student turn (latency)
A normal turn is `assess` → `teach` → `suggestReplies` = **three** serial completions on a slow
WebGPU model; a completed milestone adds `sync`. On a 1.5–3B this is the dominant UX cost and makes
every reply feel sluggish (and amplifies the loading problem the game in
[`loading-game-engagement.md`] is trying to mask).
→ **Fix:** (a) generate quick-reply chips **cheaply/heuristically** or fold them into the teach call
instead of a 3rd round-trip; (b) skip `assess` when the student input clearly isn't an answer
(short/greeting/question) — cf. #6; (c) stream the teach reply so first token shows fast.

## 🟠 #6 — An assess call is spent even on non-answers
`assess` gates only on `hasStudentTurn`. So "hi", "ready", "ok", or a pure clarifying question each
burn a full assessment call that can only return `false`.
→ **Fix:** extend the gate — skip assessment for greetings/very short/question-shaped inputs and go
straight to teach. Saves a call every few turns and avoids spurious verdicts.

## 🟠 #7 — Sync only looks *forward*, and trusts the model's ordering
`sync` cross-checks `remaining()` (milestones **after** the current index). Reasonable, but: it can
never notice that the *current* conversation actually satisfied a *later* goal out of order beyond
that forward set, and it fully trusts the model to (a) pick correct ids and (b) be conservative.
A hallucinated id is filtered (must be a string), but a *wrong-but-valid* id silently skips a
milestone the student never learned.
→ **Fix:** require Sync to cite student-evidence per id (not just the id), and log skipped
milestones in the dev panel so over-eager skipping is visible during eval runs.

## 🟢 #8 — No student model / mastery tracking (one lucky answer = mastered)
Achievement is a single binary judgment on one transcript — no notion of guessing, slips, or
repeated demonstration (contrast BKT in [`tutoring-architecture-patterns.md`] §3). One correct-ish
answer advances the milestone.
→ **Fix (optional, higher effort):** a tiny per-milestone confidence (require 2 signals, or a
tap-to-confirm check) before advancing high-stakes milestones.

## 🟢 #9 — `cleanReply` can over-truncate
The role-play stripper cuts at the first `student:|teacher:|…` marker. A legitimate tutor sentence
containing one of those words followed by a colon (e.g. *"Ask yourself, student: what runs first?"*)
would be truncated mid-message.
→ **Fix:** anchor the cut to line-start / newline-preceded labels only.

## 🟢 #10 — No persistence; refresh loses everything
Engine state (queue, per-milestone contexts, progress) lives only in the in-memory instance. A
reload restarts decomposition and the lesson from zero.
→ **Fix:** serialize the `MilestoneQueue` to `localStorage`/IndexedDB between turns (also lets the
loading game / cold reload resume instead of re-decomposing).

---

## Cross-cutting recommendation
The engine's philosophy — *model owns the thinking, no verify net* — is worth keeping as the pitch.
But the two 🔴 items (impasse loop, binary assessment) and #3 (parsing) are where a small model has
**no rail and will visibly fail on stage.** Add the *cheap deterministic scaffolding* around the
model — attempt counters, scaffold levels, compaction, evidence-cited verdicts, dev-panel visibility
— without moving the actual judgment off the model. That preserves the story and removes the ways it
face-plants.

**Priority for a hackathon:** #1 → #3 → #2 → #5, then #4 (re-split), then the 🟢 polish.

---

## Sources
- [LLMs Get Lost in Multi-Turn Conversation (arXiv 2505.06120)](https://arxiv.org/pdf/2505.06120)
- [Intelligent Tutoring Systems (ACT-R chapter)](http://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/173Chapter_37_Intelligent_Tutoring_Systems.pdf) — hint ladders / mastery.
- [Impasse-detection tutoring support (Springer)](https://link.springer.com/chapter/10.1007/978-3-031-36336-8_52)
- Cross-ref: [`milestone-engine-long-conversation.md`], [`small-llm-performance-playbook.md`], [`tutoring-architecture-patterns.md`], [`offline-to-ondevice-pipeline.md`].
</content>
