# Hallucination Handling — detectors, triggers, and per-scenario recovery prompts

**Status:** design + drop-in prompts. **No code changed yet** — this is the recommendation.
**Date:** 2026-07-02
**Owner question:** *"Insert a strategy to handle hallucinations. I thought of a prompt that checks
whether the model is hallucinating and gives a solution (continue to next milestone / ask the student
a relevant question etc.), triggered in scenarios like being on the same milestone for more than 4
messages, other triggers, or just randomly."*

Scope: the milestone engine (`maestro-open/src/engine/milestone/`). Builds directly on
[`milestone-engine-weak-spots.md`] (🔴 #1 impasse, 🔴 #2 binary assessment, 🟠 #3 parsing) and
[`milestone-engine-long-conversation.md`] (compaction / re-split / scaffold). This doc turns those
into ONE concrete hallucination-recovery system with ready-to-paste prompts.

---

## 1. First, an honest reframe of the idea

The owner's instinct has three parts. Two are exactly right; one needs adjustment:

✅ **"Triggered in scenarios like >4 messages on the same milestone"** — right, and the key design
move. Hallucination in this engine is mostly a *symptom of context rot + impasse*: the longer one
milestone drags, the dumber the small model gets (arXiv 2505.06120). The *conditions* that produce
hallucination are cheaply detectable in deterministic code — no model call needed to know we're in
the danger zone.

✅ **"Give a solution: continue to next milestone / ask the student a question"** — right. Recovery
should be an *action that changes the situation* (fresh context, smaller goal, escalated scaffold,
honest advance), not a retry of the same failing call in the same rotten context.

⚠️ **"A prompt checking whether the model is hallucinating"** — needs care. Asking the SAME 1.5–3B
model "were you hallucinating?" is self-grading: the judge shares the failure mode of the accused,
and an open-ended "is this hallucinated?" question is exactly the kind of vague judgment small
models are worst at. Two adjustments make it work:
1. **Ask a narrow, checkable question instead** — "does this reply teach X? yes/no" — with a
   **fresh, minimal context** (just the reply + the milestone card). Fresh context matters: the
   judge must not inherit the rot that produced the problem.
2. **Use it as a confirmation step after a cheap deterministic detector fires**, not as the primary
   detector. Deterministic signals are free and don't hallucinate.

⚠️ **"Or just randomly"** — recommend **against** random checks in production: each check is a full
on-device completion (~1–3 s), and a random sample mostly lands on healthy turns (low signal, real
latency). Instead: **randomly sample in dev builds only** (e.g. 10%), logged to the LLM-calls dev
panel, as a data-collection tool to tune the detectors. Same idea, right placement.

**The strategy in one sentence:** *detect the symptoms deterministically for free, confirm cheaply
with a narrow fresh-context judge when needed, and recover by changing the situation — reground,
escalate, split, or honestly move on.*

---

## 2. Layer 1 — deterministic detectors (zero model calls, run every turn)

All of these are pure code over state the engine already has (or one small counter away).

| id | detector | signal | implementation |
|----|----------|--------|----------------|
| **D1 STUCK** | ≥ 4 teach turns on the same milestone without `achieved` | impasse → context rot begins | add `attempts: number` to `Milestone`, ++ on every not-achieved teach; reset on advance/re-split |
| **D2 LOOPING** | new tutor reply is near-duplicate of an earlier reply in this milestone | the model is cycling (classic small-model rot) | word-set Jaccard vs. each prior tutor turn; fire at ≥ 0.6 |
| **D3 DRIFT** | teach reply shares no content-words with milestone title+description | reply is off-goal (teaching the wrong thing) | tokenize both, drop stopwords, fire when overlap = 0 |
| **D4 DEGENERATION** | reply is empty after `cleanReply`, OR `cleanReply` had to amputate role-play, OR reply length ≫ the 1–4-sentence contract (> ~700 chars) | format collapse — the strongest cheap hallucination proxy | compare pre/post `cleanReply` length + absolute cap |
| **D5 FLIP-FLOP** | assessment verdict alternates achieved/not-achieved across consecutive turns with near-identical student input | the assessor itself is unstable | keep last 2 verdicts per milestone |

Notes:
- D1 is the owner's trigger, verbatim. D2–D4 catch hallucination *earlier* than turn 4.
- D4's "cleanReply amputated something" signal is already computable — `cleanReply` exists and is
  tested; it just needs to *report* that it cut (return `{text, wasCut}` or compare lengths).
- All five are unit-testable with plain strings — extend the new vitest suite.

## 3. Layer 2 — the narrow judge (1 model call, ONLY when Layer 1 fires)

When a detector fires, optionally confirm before intervening (recommended for D2/D3, skip for
D1/D4 where the signal is already conclusive). Fresh context — the judge sees ONLY the last
exchange and the milestone card, never the transcript:

```ts
// P1 — SANITY-CHECK JUDGE (fresh minimal context; narrow checkable question)
export function sanityCheckPrompt(milestone: Milestone, tutorReply: string, lastStudentMsg: string) {
  const system = [
    'You are auditing ONE tutoring reply. Answer three narrow yes/no questions about it.',
    'Judge only what is in front of you. Respond with ONLY this JSON, no prose:',
    '{ "teachesTheGoal": true|false, "respondsToStudent": true|false, "selfConsistent": true|false }',
    '- teachesTheGoal: is the reply actually about the goal below (not a different topic)?',
    '- respondsToStudent: does it address what the student just said?',
    '- selfConsistent: is it free of contradictions, invented dialogue, or nonsense?',
  ].join('\n');
  const user = [
    `GOAL: ${milestone.title} — ${milestone.description}`,
    `STUDENT SAID: "${lastStudentMsg}"`,
    `TUTOR REPLIED: "${tutorReply}"`,
    'Return the JSON now.',
  ].join('\n');
  return { system, user };
}
```

Parse with the existing `extractJson` (tested); any `false` → intervene; parse failure → treat as
suspect (the judge failing IS a signal on-device). **Cost: happy path = 0 extra calls; a fired
detector = at most 1.**

---

## 4. Layer 3 — interventions, one per scenario (the owner's "different prompts")

Each intervention *changes the situation* instead of retrying it. Ordered from gentlest to firmest.

### I1 · REGROUND — fresh-angle reteach with a reset context
*Trigger: D2 LOOPING, D3 DRIFT, or judge says off-goal. This is the "reset the cache, smartly".*
Instead of the (rotten) transcript, the teach call gets a compact state + explicit fresh-angle order:

```ts
// P2 — REGROUND: replaces the normal teach prompt user-section for one turn
export function regroundPrompt(milestone: Milestone, summary: string, lastStudentMsg: string) {
  const system = teachSystemBase(milestone); // persona + honesty + anti-roleplay, as today
  const user = [
    'IMPORTANT: your previous explanations of this idea did not land — do NOT repeat them.',
    `Summary of the conversation so far: ${summary}`,
    lastStudentMsg ? `The student's latest message: "${lastStudentMsg}"` : '',
    'Take a COMPLETELY FRESH angle: a different analogy or a tiny concrete example, in 1–3 short',
    'sentences, then ask one simple question that checks just one small part of the idea.',
  ].filter(Boolean).join('\n');
  return { system, user };
}
```
`summary` comes from a one-call compaction (Mechanism A in the long-conversation doc) or, cheaper,
a deterministic digest: the student's last 2 messages + attempt count.

### I2 · SCAFFOLD ESCALATION — hint ladder by attempt count
*Trigger: D1 STUCK at increasing thresholds. Pure prompt addition to `teachPrompt` — no new call.*

```ts
// P3 — SCAFFOLD LINES appended to the teach system prompt by attempts
const SCAFFOLD: Record<number, string> = {
  2: 'The student has now missed twice. Give a CONCRETE HINT or a partial worked step — no more abstract questions.',
  3: 'The student is stuck. Show a SHORT FULLY WORKED EXAMPLE, then ask them to do the same with one small change.',
  4: 'BOTTOM OUT: state the key answer plainly and simply. Then ask one trivial confirmation question ' +
     'the student can definitely answer (e.g. repeat it back in their own words).',
};
```
This is the ITS hint-ladder (ACT-R literature) and directly kills the "keeps asking the same
Socratic question forever" loop.

### I3 · RE-SPLIT — break the stuck milestone into two tiny live sub-steps
*Trigger: D1 at attempts = 4–5 when scaffolding didn't land. Reuses `decompose.ts` machinery.*

```ts
// P4 — IMPASSE RE-SPLIT (bounded: once per milestone, +2 leaves max)
export function resplitPrompt(milestone: Milestone, lastStudentMsg: string) {
  const system = [
    'A student is STUCK on one learning step. Break it into exactly 2 much smaller, concrete',
    'sub-steps that build to it. The first must be so small the student almost cannot fail it.',
    'Respond with ONLY a JSON array: [{"title": "<3-6 words>", "description": "<what to demonstrate>"}, {...}]',
  ].join('\n');
  const user = [
    `The stuck step: ${milestone.title} — ${milestone.description}`,
    lastStudentMsg ? `The student's last attempt was: "${lastStudentMsg}"` : '',
    'Return the 2 sub-steps now.',
  ].filter(Boolean).join('\n');
  return { system, user };
}
```
Engine side: splice the two sub-milestones in place of the current one (fresh empty contexts —
instant relief from context rot), reset `attempts`. Bound it: one re-split per original milestone.

### I4 · FORCE-ADVANCE — honest move-on (never deadlock)
*Trigger: hard cap — e.g. attempts ≥ 6 or ≥ 10 total turns on one milestone. The owner's
"continue to the next milestone" remedy, done honestly (per the product's no-fake-teaching value).*

```ts
// P5 — FORCE-ADVANCE TRANSITION (replaces the normal bridge-transition for this advance)
export function forceAdvancePrompt(nextMilestone: Milestone, skippedTitle: string) {
  const system = teachSystemBase(nextMilestone); // + the usual no-greeting transition rules
  const user = [
    `The student worked hard on "${skippedTitle}" but it hasn't fully clicked yet. That is FINE and normal.`,
    'In one warm sentence: tell them it is okay, this idea often clicks later, and you will circle back to it.',
    'NEVER pretend they mastered it. Then introduce the next idea and ask one question.',
  ].join('\n');
  return { system, user };
}
```
Engine side: mark the milestone `deferred` (new status) rather than `achieved`, so the dev panel —
and any future review step — knows it was skipped, not learned. This is the one intervention that
*guarantees* the lesson can never trap a student.

### I5 · STUDENT-REDIRECT — reground via the student, not the model
*Trigger: D3 DRIFT when the judge says the reply ignored the student; also good after D5 FLIP-FLOP.
The owner's "ask the student a relevant question" remedy.*

```ts
// P6 — REDIRECT: one concrete question tied to the milestone, no new teaching
export function redirectPrompt(milestone: Milestone) {
  const system = teachSystemBase(milestone);
  const user = [
    'Do NOT explain anything new this turn. Ask the student ONE short, concrete question that',
    `checks where they are with: ${milestone.description}.`,
    'Make it answerable in one sentence. Nothing else.',
  ].join('\n');
  return { system, user };
}
```
Why it works: the *student's* answer is fresh, trustworthy context — it re-anchors the next teach
call better than anything the model can generate for itself.

---

## 5. Trigger → intervention map (the policy, one table)

| scenario | detector(s) | confirm with judge? | intervention |
|----------|-------------|--------------------|--------------|
| Same milestone > 4 messages (owner's trigger) | D1 attempts 2→3→4 | no (conclusive) | I2 scaffold L1→L2→L3 (bottom-out) |
| Scaffold didn't land | D1 attempts 5 | no | I3 re-split (once) |
| Still stuck after re-split | D1 attempts ≥ 6 / turn cap | no | I4 force-advance (deferred) |
| Tutor repeating itself | D2 | optional | I1 reground (fresh angle) |
| Tutor off-topic vs. milestone | D3 | yes (P1) | I1 reground; if judge says "ignores student" → I5 redirect |
| Reply degenerate (empty / role-play cut / runaway length) | D4 | no | regenerate once with I1; if still degenerate → I5 redirect |
| Assessor flip-flopping | D5 | no | I5 redirect (get one clean student signal), and log it |
| Random spot-check | — | dev builds only, ~10% | log P1 verdict to LLM-calls panel; no intervention |

Priority when multiple fire: **D4 > D3 > D2 > D1** (degeneration is most urgent; stuckness is the
slowest burn).

## 6. Where it hooks into `respond()` (minimal wiring)

```
push student turn
assessment = assess(current)
if achieved → sync/advance (unchanged)
else:
    current.attempts++
    reply = teach(current, scaffoldLine(current.attempts))          # I2 is just an extra system line
    verdictNeeded = D2(reply) || D3(reply) || D4(reply)             # free, pure code
    if verdictNeeded && judgeSaysBad(P1):                           # ≤1 extra call, fresh context
        reply = intervene(I1 / I5)                                  # one recovery call, replaces reply
    if current.attempts == RESPLIT_AT && !current.wasResplit: I3
    if current.attempts >= HARD_CAP: I4 force-advance
```

State additions: `attempts`, `wasResplit`, `deferred` status, and a per-milestone list of prior
tutor replies (already in `context`). Every branch is visible in the existing LLM-calls dev panel —
label the calls `judge`, `reground`, `resplit`, `force-advance` so tuning is observable.

## 7. Cost & failure honesty

- **Happy path: zero added calls, zero added latency.** All detectors are pure code.
- A fired detector adds **at most 2 calls** (judge + one recovery) — and it fires exactly when the
  alternative was a wasted turn anyway.
- Every intervention is itself a model call and can itself be bad — that's why the ladder ends in
  **I4 force-advance**, the only deterministic guarantee. The system degrades toward honesty, not
  toward pretending.

## 8. Recommended build order (fits the hackathon)

1. **`attempts` counter + I2 scaffold lines + I4 hard cap** — kills the deadlock, ~40 lines, no new prompts to tune.
2. **D2/D3/D4 detectors + I1 reground** — catches visible hallucination early; detectors are unit-testable today.
3. **P1 judge on D2/D3** — the owner's checker, in its reliable narrow form.
4. **I3 re-split** — most code, best demo moment ("watch it split the step live").
5. Dev-only random sampling → tune thresholds from real transcripts in the LLM-calls panel.

---

## Sources
- [LLMs Get Lost in Multi-Turn Conversation (arXiv 2505.06120)](https://arxiv.org/pdf/2505.06120) — rot mechanics; recap/reset beat truncation.
- [SelfCheckGPT (arXiv 2303.08896)](https://arxiv.org/abs/2303.08896) — sampling-based self-consistency checking; why narrow checks beat open self-diagnosis.
- [Intelligent Tutoring Systems (ACT-R chapter)](http://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/173Chapter_37_Intelligent_Tutoring_Systems.pdf) — hint ladders, bottom-out.
- Cross-ref: [`milestone-engine-weak-spots.md`], [`milestone-engine-long-conversation.md`], [`small-llm-performance-playbook.md`].
