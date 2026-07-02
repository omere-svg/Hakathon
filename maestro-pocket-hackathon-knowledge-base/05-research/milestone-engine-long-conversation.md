# Milestone Engine — surviving a long conversation on ONE sub-goal

**Status:** analysis + proposed algorithm changes. **No code changed.**
**Date:** 2026-07-01
**Owner question:** *"local models are stupid when the conversation about a sub-goal gets long.
We could reset the sub-goal cache, or split it into sub-sub-goals, or other things. Read the engine,
understand the algorithm, think creatively + use research to improve it."*

Scope: **the milestone engine only** (`maestro-open/src/engine/milestone/`). See
[`maestro-open-architecture-commitment`] and [`milestone-engine-alternative`] for how it fits.

---

## 1. How the engine handles a single sub-goal today (the exact algorithm)

Per [`engine.ts`](../../maestro-open/src/engine/milestone/engine.ts) `respond()`:

```
student message → push to current milestone's ISOLATED context
  → assess(current)            # LLM call: "is THIS milestone achieved?" (binary + evidence)
     ├─ not achieved → teach(current)     # LLM call: one more teaching turn, pushed to context
     └─ achieved     → achieveCurrent(); sync(current); advance()   # cross-check + next milestone
→ suggestReplies(reply)        # LLM call: 4 quick-reply chips
```

Context handling: each milestone keeps its **own** transcript (`context: MilestoneTurn[]`). Both
teach and assess see only `context.slice(-CONTEXT_WINDOW)` where `CONTEXT_WINDOW = 8`
([`types.ts`](../../maestro-open/src/engine/milestone/types.ts), [`prompts.ts`](../../maestro-open/src/engine/milestone/prompts.ts) `renderContext`).

**So today's only defense against a long sub-goal is a fixed 8-turn sliding window.** That is exactly
the wrong tool, and here's why.

---

## 2. Why "conversation gets long" makes a small model dumb — grounded in research

The 2025 paper *"LLMs Get Lost in Multi-Turn Conversation"* (arXiv 2505.06120) and the broader
**"context rot"** literature identify failure modes that hit **small on-device models hardest**:

- **Lost-in-the-middle.** Models over-weight the first and last turns and neglect the middle. On
  7–8B models, accuracy on mid-context info drops **15–20 points** vs. info at the edges. Our target
  1.5–3B models are worse. → A student's key demonstration mid-conversation gets ignored by both
  teach and assess.
- **Answer bloat / snowballing.** Replies get longer and more assumption-laden as turns pile up,
  compounding earlier errors. → The tutor drifts, over-explains, invents.
- **Premature commitment + over-reliance on its own prior turns.** The model latches onto an early
  (possibly wrong) read of the student and won't update. → It keeps "teaching" a point the student
  already got, or keeps missing a misconception.
- **Reliability collapse.** Strong models become *as unreliable as small ones* in long multi-turn
  chats. For us that floor is lower still.

**Key realization:** the sliding window *hides* the problem for a while, then makes it worse —
truncation silently **deletes the exact turn where the student demonstrated mastery**, so the
assessor can never see it and the milestone can loop forever. The paper's recommended fix is *not*
truncation; it's **consolidation / recap** (summarize prior turns every 3–4 turns) and **context
resetting** (reintroduce key facts). That maps directly onto the owner's two instincts — but done
*smartly*.

---

## 3. The proposed fix: a **bounded, self-healing milestone loop** (three mechanisms)

The owner guessed three things: *reset the cache*, *split into sub-sub-goals*, *other*. All three are
right — combined they form one coherent design. Each maps to a research-backed technique.

### Mechanism A — **Smart compaction** (≙ owner's "reset the sub-goal cache", done right)
Replace the raw `slice(-8)` window with a **consolidation checkpoint**. When a milestone's context
exceeds a threshold (e.g. > 6 turns), run one cheap summarization call that distills the transcript
into a compact **milestone state**, then keep *that summary + the last 2 raw turns* and drop the rest:

```
MilestoneState = {
  taught:        string[]   // points already explained (don't repeat them)
  studentGot:    string[]   // what the student has demonstrated
  struggling:    string     // current sticking point / misconception
  lastAttempt:   string     // student's most recent try, verbatim
}
```

Why this beats a naive reset **and** a sliding window:
- A **naive reset** (clear the cache) throws away the student's demonstrated progress → assessment
  can never fire → loops.
- A **sliding window** silently drops the middle → lost-in-the-middle by construction.
- **Compaction** keeps the *information*, shrinks the *tokens*. The assessor now grades against a
  dense, edge-loaded summary instead of a long lossy transcript — exactly the paper's "recap every
  3–4 turns." Small model, small input, high signal.

This is the single highest-ROI change and is a **drop-in replacement for `renderContext`** plus a
`compact()` step in `respond()`.

### Mechanism B — **Impasse detection → dynamic re-split** (≙ owner's "sub-sub-goals")
Add an `attempts` counter per milestone (teach turns without achievement). When it crosses a
threshold (e.g. **3**), declare an **impasse** — the milestone is too big *for this learner*. Then
**re-decompose that one milestone live**: reuse `decompose.ts`'s machinery with an impasse-aware
prompt ("the student is stuck on X; break it into 2 tiny, concrete steps"), and **splice the
sub-milestones into the queue in place of the current one**. Each new sub-milestone starts with a
*fresh, tiny context* — instant relief from context rot.

- This makes decomposition **adaptive** instead of one-shot-at-init (see weak-spot #7 in
  [`milestone-engine-weak-spots.md`]). The plan tree bends to the actual student.
- Bound it hard: allow re-split only to a small extra depth / call budget so an erratic model can't
  fan out forever (mirror `DEFAULT_LIMITS`). This is standard in ITS: **subtask decomposition on
  impasse** is what human tutors do.

### Mechanism C — **Escalating scaffold + bottom-out** (the "other things" — guarantees progress)
Give `teachPrompt` an explicit **scaffold level** that rises with `attempts`, straight from the ITS
hint-ladder literature:

| level | attempts | tutor behavior |
|------|----------|----------------|
| 0 | 0–1 | Socratic — ask a leading question |
| 1 | 2   | Give a concrete hint / partial worked step |
| 2 | 3   | Show a full worked example, then re-ask |
| 3 | 4+  | **Bottom-out**: state the answer plainly, then a trivial confirm question |

Combined with a **hard turn cap** per milestone (after N turns, force-advance with an honest note),
this *guarantees the lesson never deadlocks* — the exact failure the owner is worried about. Human
tutors escalate abstract→concrete→bottom-out; a stuck learner eventually gets told, confirms, moves on.

### How the three compose (the new `respond` loop, in words)
```
push student turn
if context > threshold: compact()                      # Mechanism A
assessment = assess(state)                              # now grades the dense summary
if achieved: sync + advance (as today)
else:
    attempts++
    if attempts >= IMPASSE and canReSplit: reSplit()    # Mechanism B — swap in tiny sub-milestones
    else: teach(state, scaffoldLevel(attempts))         # Mechanism C — escalate
    if attempts >= HARD_CAP: forceAdvance(withNote)      # never deadlock
```

None of this breaks context isolation (the engine's core commitment) — it *strengthens* it: contexts
stay small by compaction, and re-split creates new isolated micro-contexts.

---

## 4. Secondary ideas worth a line

- **Distinguish "confused" from "attempted-and-wrong."** Have `assess` return a 3-way signal
  (`achieved | attempted-miss | off-track/asking`) instead of a bare bool, so the loop can pick
  re-explain vs. re-ask vs. answer-the-question. Cheap, big adaptivity win. (See weak-spot #2.)
- **Cap tutor reply length in the prompt** (already 1–4 sentences) and *enforce* it — directly
  counters "answer bloat."
- **Assessment cadence.** Don't burn an assess call on "hi"/"ready"; gate on substantive input
  (there's already a `hasStudentTurn` gate — extend it with a min-length / is-it-an-answer check).

---

## 5. Recommended order to build (fits a hackathon)

1. **Mechanism A (compaction)** — biggest win, smallest blast radius, replaces one function.
2. **Mechanism C (escalating scaffold + hard cap)** — pure prompt/counter change, kills the deadlock.
3. **Mechanism B (dynamic re-split)** — most powerful, most code; do last, reuse `decompose.ts`.

Do 1+2 and the "gets long → gets stupid → gets stuck" scenario is largely solved. Add 3 for a
genuinely adaptive tutor and a great demo beat ("watch it break a hard goal into smaller steps live").

---

## Sources
- [LLMs Get Lost in Multi-Turn Conversation (arXiv 2505.06120)](https://arxiv.org/pdf/2505.06120) — failure modes + recap/reset/retry mitigations. **Primary.**
- [Drift No More? Context Equilibria in Multi-Turn LLM Interactions (arXiv 2510.07777)](https://arxiv.org/pdf/2510.07777)
- [Context Rot (Redis)](https://redis.io/blog/context-rot/) · [What is Context Rot (Salesforce)](https://www.salesforce.com/artificial-intelligence/ai-context/context-rot/) — position bias / degradation as context grows.
- [Intelligent Tutoring Systems (ACT-R chapter)](http://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/173Chapter_37_Intelligent_Tutoring_Systems.pdf) — hint ladders, bottom-out hints.
- [Impasse-detection tutoring support (Springer)](https://link.springer.com/chapter/10.1007/978-3-031-36336-8_52) — detecting stuck learners + escalation.
- Cross-ref: [`milestone-engine-weak-spots.md`], [`small-llm-performance-playbook.md`], [`tutoring-architecture-patterns.md`].
</content>
