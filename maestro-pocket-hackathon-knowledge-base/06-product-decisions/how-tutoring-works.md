# How the tutoring works — making a "stupid" small model teach

> Plain-English walkthrough of exactly what happens on every turn, grounded in the code (`src/engine/*`). The point: a 1.5B model can't reason or plan — so we **never ask it to**. The deterministic engine does all the thinking; the model only **understands the student's words** and **says the engine's decision warmly**.

---

## The one-sentence model

> **Deterministic engine = the brain (decides what to do). Small LLM = the mouth (says it nicely). Tools = the source of truth (facts/correctness). Verifier = the conscience (blocks/repairs mistakes).**

The model is a *renderer with a vocabulary*, not a teacher. Everything a teacher must get *right* — is this answer correct? what comes next? may I reveal the answer? what's the misconception? — is decided by code, not by the 1.5B.

## The three actors

| Actor | Where | Job |
|---|---|---|
| **Offline authoring** (a big model, once per course) | `src/domain/*.ts` (static JSON) | Decides *what* to teach and *how* — knowledge components, the **Presentation Guideline** (core idea, analogy, teaching arc, emphasize, avoid), gradeable checks + answer keys, misconceptions + remediations, hint ladders, gold exemplars. |
| **On-device small model** | WebLLM (`src/llm/*`) | Two jobs only: read the student's message, and phrase the engine's chosen move in warm language. |
| **Deterministic engine** | `src/engine/*` | Reads the situation, grades with tools, decides the move, builds the model's instructions, verifies + repairs the reply, updates the student model. |

---

## A turn, step by step (`orchestrator.ts` → `runTurn`)

Say the student submits wrong code for `sumToN`. Here's every step:

1. **Read the message → cues** (`cues.ts`, deterministic). Extracts only the *safety-relevant* signals: a stated name preference, distress ("I want to quit"), the request type (answer/hint/explanation/runnable), and whether this is an answer attempt. *The model is not trusted to notice these.*

2. **Grade with tools** (`grade.ts` + `tools/`). If there's an open question and the student answered, the **code-runner / calculator / answer-key** produce the verdict — `correct / incorrect / matched-misconception`. **Correctness never comes from the LLM.** (Here: the code runs, returns the wrong number → `incorrect`, and it matches the "forgot to update the counter" misconception.)

3. **Update the student model** (`applyState`). Bumps per-concept mastery, attempts, confidence/frustration; flags the active misconception. This is the memory that makes it adaptive.

4. **Compute any math the student mentioned** (`tools/calculator.ts`) so the model never does arithmetic itself.

5. **Build the Situation** (`situation.ts` → `buildSituation`) — a deterministic snapshot: current concept, is it explained yet, mastered?, challenge mode?, the grading verdict, verified facts, cues. *This is "what's going on," decided by code.*

6. **Decide the move + write the model's instructions** (`situation.ts` → `brief`). From the Situation, the engine writes a precise **brief** — e.g. *"The student's answer is INCORRECT (verified). Do NOT say it's correct. They seem to believe X; gently correct it by asking: `<authored remediation question>`."* The model is *told the verdict and the move*; it doesn't decide them.

7. **Assemble the prompt** (`buildEnginePrompt`). See "What the model sees" below.

8. **Draft** (`draftOnce` / `bestOf`). The model generates the reply — optionally in **JSON structured mode** (must fill `{acknowledgement, body, question}`) and **best-of-N** (generate 2, keep the first that passes the verifier).

9. **Verify** (`verify.ts`). Deterministic checks against the verified situation: didn't validate wrong work (C3), didn't leak the answer (C2), used the verified numbers (C4), acknowledged distress first (C9), honored the name (C1), etc.

10. **Repair** (up to 2×). On a violation, **re-prompt the model with a precise correction** ("their answer is wrong — don't affirm it; ask a question"). Small models comply with a *specific* correction even when they ignored the general rule.

11. **Guard scrub** (`guard`). Last resort for C1/C2: deterministically **delete a leaked answer or a rejected name from the model's own text** — a structural guarantee (the tutor literally can't leak in challenge mode).

12. **Commit** (`commit`). Advance the lesson deterministically: mark the concept explained, move to the next concept when mastered, signpost the switch. The model never decides progression.

13. **Return** the reply + the C1–C10 check results (shown in the "Show engine" dev panel) + updated student/lesson memory (persisted on-device).

---

## What the model actually sees (the prompt)

**System prompt** (built by the engine, not the model):
```
[PERSONA]  warm tutor; 1–4 sentences; end with a question
REFERENCE: concept · core idea · analogy · teach-in-this-order · emphasize · avoid
           · explanation · worked example · the question to pose · next concept
[EXEMPLAR] a gold example reply of this kind (imitate the style)          ← authored offline
[STRUCTURED] respond only as JSON {acknowledgement, body, question}       ← reliability
YOUR INSTRUCTIONS THIS TURN:
  - Address the student as "Sam". Never call them "Samuel".
  - The answer is INCORRECT (verified). Don't affirm it; ask: <remediation>
```
**User prompt:** the last few turns + `Student: <message>`.

So the small model is handed the concept, the exact teaching move, the verified verdict, an example to imitate, and a strict format — and asked only to *phrase it well for this student*. That is a job a 1.5B can do reliably.

---

## How each classic small-model failure is prevented

| Small-model failure | How the engine prevents it |
|---|---|
| Says "correct!" to wrong work (sycophancy) | Tools grade it; brief says "INCORRECT, don't affirm"; C3 verifies; repair re-prompts |
| Leaks the answer when asked | Answer key withheld from the prompt in challenge mode; C2 verify; guard scrub (structural) |
| Makes up a number | Calculator computes; brief hands the verified value; C4 verifies |
| Rambles / forgets to ask | Structured JSON forces a `question` field; ≤4-sentence persona |
| Ignores a distressed student | `cues` detects distress; brief forces empathy-first; C9 verifies (must lead) |
| Forgets the student's name | Stored in the student model; injected into every brief; C1 verify + scrub |
| Loses the thread / wrong next topic | The deterministic state machine owns progression (`commit`), not the model |
| Explains badly | The authored **Presentation Guideline** + **exemplar** tell it exactly how |

---

## Modes & knobs
- **`engine` mode** = the full pipeline above (the product).
- **`raw` mode** = the same model, bare prompt, no engine — the control on the Benchmark/Evals pages. This is how we *prove* the lift.
- **Feature flags** (`src/config/features.ts`, Settings page) toggle each module: structured output, best-of-N, repair, exemplars, prefix-cache layout, persistence, spaced repetition. Turn any off → graceful degrade to the core engine.
- **Model** (`src/llm/models.ts`): device-tiered picker (0.5B/1.5B/3B). In `npm run dev` it's **pinned to 1.5B** so we feel what a typical student feels; production auto-picks by device; the Benchmark page compares tiers.

## Honest limits
The small model still writes the *words*, so phrasing quality varies with model size (3B > 1.5B > 0.5B) — but correctness, safety, pacing, and progression do **not** vary, because those are deterministic. If the model stalls, `guard` + the C1/C2 structural guarantees still hold; other checks reflect the model's real behavior (honest, not masked).
