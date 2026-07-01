# Architecture Specification — Maestro Open

> ⚠️ **HISTORICAL — SUPERSEDED.** This document describes the **v1** design ("deterministic engine is the brain; LLM only does NLU+NLG"). We **built it, judged it brittle keyword-theater, and replaced it.** The **current** architecture is **LLM-first with a verify-and-repair layer** — the on-device model IS the brain; deterministic code only verifies, re-prompts, and scrubs. See **[architecture.md](architecture.md)** (canonical current) and the project memory. Kept here only as a record of the reasoning that led to v2 (the §10 critical review is still worth reading).
>
> The 10 TutorBench scenarios are **acceptance tests**, not implementation targets — that principle carried over to v2.

---

## 1. High-level architecture

```
                         ┌───────────────────────────────────────────────────────┐
                         │                  CONVERSATION MEMORY                    │
                         │  long-term (student) · lesson (session) · turn (ephem.) │
                         └───────────────────────────────────────────────────────┘
                              ▲ read                                   ▲ write
 student message              │                                        │
      │                       │                                        │
      ▼                       │                                        │
┌─────────────┐   ┌───────────┴───────────┐   ┌───────────────────┐   ┌──────────────────────┐
│  1. NLU     │   │  2. INTERPRETER /      │   │  3. POLICY ENGINE │   │  4. REALIZATION      │
│  (LLM,      │──▶│     STATE UPDATE       │──▶│  (deterministic   │──▶│  (NLG: LLM template  │
│  constrained│   │  (DETERMINISTIC)       │   │  rule cascade /   │   │   OR static template)│
│  JSON)      │   │  • grade via tools     │   │  behavior tree)   │   │  picks 1 act → text  │
└─────────────┘   │  • update student model│   │  → ONE DialogueAct│   └──────────┬───────────┘
      │           │  • update affect/prefs │   └─────────┬─────────┘              │
      │           │  • update active target│             │                        │
      │           └────────────────────────┘             │                        │
      │                       ▲                           ▼                        │
      │                       │                  ┌──────────────────┐              │
      │              ┌────────┴────────┐         │  CONSTRAINT SYS  │◀─────────────┘
      │              │ DETERMINISTIC    │         │  (CBM)           │ validate act + output
      │              │ TOOLS            │         │  • legal acts    │
      │              │ code-runner ·    │         │  • structural    │  pass → render
      │              │ calculator ·     │         │    shaping       │  fail → re-select / regen
      │              │ answer-key       │         │  • thin guard    │
      │              └──────────────────┘         └──────────────────┘
      │                                                                            │
 (DOMAIN MODEL: lesson/KC JSON, read-only, authored offline)                       ▼
                                                                            tutor message
```

**Per-turn sequence:**
1. **NLU (LLM, constrained JSON):** extract intent, answer text, affect, preference, target-relevance from the student message. *Understanding only — never grades correctness.*
2. **Interpreter / State update (deterministic):** grade any answer using **deterministic tools** (code-runner / calculator / answer-key); update the **student model** (mastery, attempts, misconceptions, affect), preferences, and the **active target**.
3. **Policy engine (deterministic):** read lesson state + student model → select **exactly one DialogueAct** (+ modifiers).
4. **Constraint system (CBM):** filter illegal acts *before* selection and shape/guard the output. Structural where possible (e.g. answer key never enters NLG context in challenge mode).
5. **Realization (NLG):** templated acts render with no LLM; content acts (EXPLAIN/HINT/CORRECT/COMFORT) call the LLM with a tight contract. Output passes a thin final guard.
6. **Memory write:** persist student-model deltas; archive turn.

The LLM appears only at steps 1 and 5. Steps 2–4 — *the brain* — are pure, testable, deterministic functions.

---

## 2. Student Model

Persisted per device (IndexedDB). Long-term unless noted. Every field earns its place by being *read by the policy or a constraint*.

```ts
interface StudentModel {
  studentId: string;

  // — Personalization (read by C1 personalization constraint + NLG) —
  preferences: {
    preferredName?: string;
    rejectedNames: string[];      // names the student asked NOT to be called
    locale?: string;              // future: language of NLG
  };

  // — Knowledge: one entry per knowledge component (read by ADVANCE/ASK/HINT logic) —
  knowledge: Record<KcId, {
    mastery: number;              // [0,1] P(knows). Drives ADVANCE vs keep-practicing.
    attempts: number;             // total checks attempted on this KC
    correct: number;              // correct count → evidence for mastery + pacing
    explained: boolean;           // has the tutor EXPLAINed it yet? (show-before-tell, C5)
    hintsUsed: number;            // hint reliance on this KC (scaffolding pace, C6)
    lastSeen: number;             // ts → spacing / REVIEW scheduling
    status: 'unseen' | 'learning' | 'mastered';  // derived from mastery + criteria
  }>;

  // — Misconceptions (read by CORRECT) —
  misconceptions: Record<MisconceptionId, {
    kcId: KcId;
    count: number;                // how often observed
    active: boolean;              // currently uncorrected? → triggers CORRECT
    lastSeen: number;
  }>;

  // — Affect (session-scoped but persisted for continuity; read by COMFORT/ENCOURAGE) —
  affect: {
    frustration: number;          // [0,1], rises on repeated failure/distress, decays on success
    confidence: number;           // [0,1], rises on success, falls on errors/self-reported confusion
    lastDistressTurn?: number;
  };

  // — Pace (read by scaffolding/hint logic, C6) —
  pace: {
    avgAttemptsPerKc: number;     // struggling vs fast → more/less scaffolding
    hintReliance: number;         // [0,1] fraction of checks needing hints
  };
}
```

**Why each field:**
- **mastery / attempts / correct** — the core signal for *what to do next* (advance vs practice vs remediate). Without this, the tutor can only react to the last message; *this is the field that makes it adaptive.*
- **explained** — enforces *show-before-tell* (can't ASK on a KC never EXPLAINed) → SWE-05/BIZ-05.
- **hintsUsed / pace.hintReliance** — drives scaffolding escalation: a student who keeps needing hints gets a worked example, not "now do it yourself" → SWE-06/BIZ-06.
- **misconceptions.active** — lets the engine CORRECT a *specific wrong belief* rather than give generic "try again." Distinguishes "wrong" from "wrong because of misconception X."
- **affect.frustration / confidence** — drives COMFORT/ENCOURAGE timing → SWE-09/BIZ-09. Estimated from NLU affect signals + attempt patterns, with decay.
- **preferences** — personalization constraint → SWE-10/BIZ-10.
- **lastSeen** — review/spacing scheduling (REVIEW act).

**Mastery update (lean):** start with **mastery learning** — `status='mastered'` when `correct ≥ masteryCriteria.minCorrect` and no active misconception. Upgrade path: **Bayesian Knowledge Tracing** (`mastery` becomes `P(know)` updated with slip/guess/learn params). The interface already supports both; we ship the counter, leave room for BKT.

---

## 3. Domain Model (lesson representation)

Authored **offline** by a big frontier model from existing Maestro/LMS lessons, reviewed, and **shipped as static JSON**. Read-only at runtime. Modeled on Maestro structure (Program → Course → Lesson → KCs/outcomes; review MCQs).

```ts
interface Lesson {
  id: string;
  program: string; course: string; title: string; topic: string;
  knowledgeComponents: KnowledgeComponent[];   // ordered = default curriculum sequence
  reviewQuestions: ReviewQuestion[];            // end-of-lesson REVIEW
}

interface KnowledgeComponent {
  id: KcId;
  label: string;                       // e.g. "while-loop termination"
  prerequisites: KcId[];               // gate: don't teach until prereqs mastered
  conceptSummary: string;              // grounding text for NLG (the "truth" to convey)

  content: {
    explanation: string;               // EXPLAIN payload
    analogy?: string;                  // optional, for EXPLAIN
    workedExample?: string;            // WORKED_EXAMPLE payload (scaffolding floor)
  };

  checks: Check[];                     // questions used by ASK
  misconceptions: Misconception[];     // detectable wrong beliefs + remediation
  hints: string[];                     // ORDERED hint ladder, gentle → specific, none reveal answer

  masteryCriteria: {
    minCorrect: number;
    minMastery?: number;               // BKT threshold (when used)
    requireNoActiveMisconception: boolean;
  };
}

interface Check {
  id: string;
  prompt: string;
  type: 'mcq' | 'numeric' | 'code' | 'keyword' | 'free';
  isChallenge: boolean;                // if true → answer withheld from LLM context (C2)
  bloom?: string;
  // Answer key — DETERMINISTICALLY gradeable. Withheld from NLG context per C2.
  answerKey: {
    mcqCorrectIndex?: number;
    numericValue?: number; numericTolerance?: number;
    codeTests?: { input: string; expected: string }[];
    keywords?: string[];               // must-mention concepts for 'keyword' grading
    constraints?: string[];            // CBM-style invariants for 'free' (e.g. "SOM < SAM")
  };
}

interface Misconception {
  id: MisconceptionId;
  description: string;                 // the wrong belief, in words
  signals: string[];                   // cues NLU/heuristics map to this misconception
  remediation: string;                 // CORRECT payload — how to address it (a question, not the answer)
  kcId: KcId;
}

interface ReviewQuestion {            // from Maestro review structure
  id: string; question: string; options: string[]; correctIndex: number; points: number;
}
```

**Design rules:**
- **Knowledge components** are the atomic unit (not "lessons") so the student model can track mastery and the policy can sequence by prerequisite.
- **prerequisites** make sequencing a graph, but MVP can treat the array order as the path (see §9).
- **Challenge questions** = `Check{isChallenge:true}`; integrity is structural — the answer key is simply *not passed* to NLG. → SWE-03/BIZ-03.
- **Expected answers** live only in `answerKey`, only ever read by **deterministic tools** (never by NLG). → keeps factual grading out of the LLM (SWE-01/02).
- **Hints** are an ordered ladder authored to *never* contain the answer; the policy picks a level by attempt count / mastery → scaffolding (SWE-06).
- **Misconceptions** carry their own remediation → CORRECT is targeted, general, and reusable.

---

## 4. Tutoring Policy Engine (the heart)

**Pure function:** `decide(lessonState, studentModel, interpretedTurn) → DialogueAct`. Deterministic, no LLM, fully unit-testable.

```ts
type ActType =
  | 'COMFORT' | 'ENCOURAGE' | 'EXPLAIN' | 'WORKED_EXAMPLE'
  | 'ASK' | 'HINT' | 'CORRECT' | 'ADVANCE' | 'SIGNPOST' | 'REVIEW';

interface DialogueAct {
  type: ActType;
  kcId?: KcId;
  checkId?: string;
  hintLevel?: number;
  misconceptionId?: MisconceptionId;
  modifiers: {                 // composable, keeps "one primary act" honest
    signpostTransition?: { from: string; to: string };  // prepend a transition sentence
    affectPrefix?: 'comfort' | 'encourage';             // soften before content
  };
  // What NLG is allowed to see (constraint-shaped — e.g. no answer key in challenge)
  contentRefs: { explanation?: string; hint?: string; remediation?: string; question?: string };
}
```

**Decision = a prioritized rule cascade (first match wins).** This *is* a behavior-tree priority selector; we implement it as an ordered list for simplicity (see §10). Safety/affect first, then pedagogy, then progression:

```
decide(state, student, turn):
  kc = state.currentKc

  # ── Tier 0: Safety & affect (highest priority) ──
  1. if turn.distress or student.affect.frustration ≥ 0.7:
        return COMFORT(kc)                      # whole turn; content resumes next turn  → SWE-09/BIZ-09

  # ── Tier 1: Direct student requests ──
  2. if turn.intent == 'request_answer' and inChallenge(state):
        return HINT(kc, level = nextHintLevel(student, kc))      # never reveal  → SWE-03/BIZ-03
  3. if turn.intent in ('request_explanation','confused') :
        return EXPLAIN(kc) if !mastered(kc) else REVIEW-style recap

  # ── Tier 2: Show-before-tell ──
  4. if !student.knowledge[kc].explained:
        return EXPLAIN(kc)                       # can't test before teaching  → SWE-05/BIZ-05

  # ── Tier 3: Grade the open check (correctness comes from TOOLS, not NLU) ──
  5. if state.activeCheck and turn.answer_text:
        result = state.lastGrading             # computed deterministically in step 2
        if result.correct:
            updateMastery(+)                    # (done in step 2)
            return ENCOURAGE+ADVANCE or ASK(next check)   # see Tier 4
        else:
            if result.matchedMisconception:
                return CORRECT(kc, misconception)          # targeted  → BIZ-01 style
            if student.knowledge[kc].attempts < SCAFFOLD_K and !highReliance(student):
                return HINT(kc, level = nextHintLevel(...))
            else:
                return WORKED_EXAMPLE(kc)        # scaffolding floor  → SWE-06/BIZ-06

  # ── Tier 4: Progression ──
  6. if mastered(kc):
        if hasNextKc(state):
            next = nextKc(state)
            modifiers = SIGNPOST if topicChanges(kc, next)   # → SWE-08/BIZ-08
            return ASK(next.firstCheck, modifiers)           # (EXPLAIN gate in Tier 2 handles first contact)
        else:
            return REVIEW(lesson) → then COMPLETE

  # ── Tier 5: Default ──
  7. return ASK(currentCheck or a Socratic probe on kc)
```

**Key properties:**
- **Exactly one primary act** per turn; COMFORT/ENCOURAGE/SIGNPOST may be *the whole turn* (when warranted) or *modifiers* on a content act (`affectPrefix`, `signpostTransition`). This preserves determinism while allowing natural "acknowledge-then-ask" turns.
- **The active target** (open check) is held in lesson memory; Tier 3 always resolves it before Tier 4 can advance → *stay-on-target* (SWE-04/BIZ-04) is emergent, not coded.
- **Correctness never comes from the LLM** — Tier 3 reads `state.lastGrading` produced by deterministic tools in step 2 → no validating unverified work (SWE-01) and no made-up facts (SWE-02).

---

## 5. NLU layer

**One LLM call. Understanding only — it must NOT grade correctness** (tools do that). Output is a small, enumerated JSON object so a 1.5B model can produce it reliably under **grammar-constrained decoding**.

```jsonc
// NLUResult — grammar-constrained; all fields required; small label space
{
  "intent": "answer | question | request_explanation | request_example | request_answer | ready | confused | smalltalk | off_topic",
  "answer_text": "string|null",          // the student's attempt, verbatim-ish (for tools to grade)
  "addresses_target": true,              // are they responding to the open question?
  "affect": "neutral | frustrated | anxious | confident",
  "distress": false,                     // strong quit/overwhelm cue
  "self_reported_confusion": false,
  "preference": { "preferred_name": "string|null", "rejected_name": "string|null" }
}
```

**NLU prompt template:**
```
SYSTEM:
You extract structured signals from a student's message in a tutoring session.
You do NOT answer, teach, or judge correctness. Output ONLY JSON matching the schema.
Definitions: intent=what the student is doing; affect=emotional tone; distress=they
express wanting to quit / being overwhelmed; preference=a name they want used/avoided.

CONTEXT:
Tutor just asked: "{activeCheckPrompt}"
Recent turns: {last 2-3 messages}

STUDENT MESSAGE:
"{studentMessage}"

Respond with JSON only.
```

**Reliability tactics:** grammar/JSON-constrained decoding (validity), tiny enums (accuracy), 1–2 few-shot examples, and **deterministic cross-checks** for the highest-stakes fields (regex backstop for `preference` and for `request_answer`/`request_hint`). If NLU returns low-confidence/garbled output, fall back to conservative defaults (`intent='answer'`, `affect='neutral'`). **NLU is advisory; tools are authoritative.**

---

## 6. NLG layer

**Given a `DialogueAct` + only the content the constraints permit, render warm Maestro-voice text.** The LLM phrases; it cannot change the decision. Templated acts (ADVANCE/SIGNPOST/ACKNOWLEDGE) skip the LLM entirely.

**NLG prompt template (parameterized by act):**
```
SYSTEM:
You are Maestro — a warm, encouraging tutor; a smart friend, not a lecturer.
You will be given a teaching ACTION and the CONTENT to convey. Express it naturally.
Hard rules:
- Do exactly the ACTION. Do not add new teaching beyond the CONTENT.
- {if preferredName}: address the student as "{preferredName}". Never use {rejectedNames}.
- {if act==ASK or HINT}: end with a single question; do NOT reveal the answer.
- {if act==HINT}: nudge using the HINT text only; never state the solution.
- Keep it to {1–4} sentences. No headers.

ACTION: {act.type}{ ' (signpost: '+from+'→'+to+')' if signpost }{ ' (be reassuring first)' if affectPrefix }
CONTENT:
{ explanation | hint | remediation | question — ONLY the permitted fields }

STUDENT (for tone/context): "{studentMessage}"
```

**Examples:**
- `HINT(level 2)` → CONTENT = `hints[1]` only (answer key absent by construction) → "You're close — think about what makes the loop *stop*. What has to change inside it each pass?"
- `EXPLAIN(kc)` → CONTENT = `content.explanation` (+analogy) → 2–3 sentences, ends by inviting a check.
- `COMFORT` → CONTENT = none; ACTION carries "be reassuring, acknowledge feeling, propose one small next step."

Because the permitted content is **shaped by the constraint system before NLG**, violations (leaking an answer, using a rejected name) are *structurally impossible*, not filtered after.

---

## 7. Constraint System (generalized — replaces ad-hoc guardrails)

A **constraint** is a universal tutoring rule:

```ts
interface Constraint {
  id: string;
  relevance: (state, student, act) => boolean;       // does this situation apply?
  // Enforcement (preferred order):
  legalActs?: (state, student) => ActType[];         // (a) restrict which acts the policy may pick
  shapeContext?: (act, state) => DialogueAct;         // (b) structural: remove/inject content pre-NLG
  guard?: (output, state) => { ok: boolean; repair?: string };  // (c) thin post-check fallback
  severity: 'critical' | 'advisory';
}
```

Enforcement priority: **(a) restrict legal acts** > **(b) structural context shaping** > **(c) post-hoc guard** (last resort). We prevent, we don't patch.

**Universal constraints → acceptance tests they make pass:**

| ID | Universal rule | Enforcement | Acceptance tests |
|----|----------------|-------------|------------------|
| C1 | Honor the student's stated name preference | shape (pass name) + guard (strip rejected) | SWE-10, BIZ-10 |
| C2 | In challenge mode, never reveal the answer | structural: answer key excluded from NLG context; legalActs = {HINT, ENCOURAGE} | SWE-03, BIZ-03 |
| C3 | Never validate unverified/incorrect work | legalActs: positive ADVANCE only if `lastGrading.correct` | SWE-01, BIZ-01 |
| C4 | Facts/math come from tools, not the model | structural: numbers injected from tool result; NLG forbidden to compute | SWE-02, BIZ-02 |
| C5 | Show before tell | legalActs: no ASK on a KC where `!explained` | SWE-05, BIZ-05 |
| C6 | Scaffolding floor — don't demand independence after repeated failure | legalActs: after `attempts≥k` wrong → {HINT(high), WORKED_EXAMPLE} | SWE-06, BIZ-06 |
| C7 | Stay on the active target or signpost the switch | legalActs: ADVANCE requires active target resolved or `signpostTransition` | SWE-04, BIZ-04 |
| C8 | Signpost mode/topic transitions | shape: set `signpostTransition` when KC/mode changes | SWE-08, BIZ-08 |
| C9 | Acknowledge distress before content | legalActs: distress → COMFORT/affectPrefix first | SWE-09, BIZ-09 |
| C10| Concrete, runnable artifacts (no placeholders) on "paste-and-run" requests | structural: tool emits artifact; guard rejects `<placeholder>` | SWE-07, BIZ-07 |

We encode the **rule**; the scenario is the **test**. Adding scenario #11 means checking it falls under an existing constraint — not writing new branches.

---

## 8. Conversation Memory

Three cleanly separated tiers; each has a distinct lifetime and a distinct set of readers/writers.

```ts
// (1) LONG-TERM STUDENT MEMORY — persists across sessions & lessons (IndexedDB)
//     = the StudentModel from §2: preferences, knowledge map, misconceptions, pace.
//     Read by: policy, constraints, NLG (name). Written by: interpreter/state-update.

// (2) LESSON MEMORY — one lesson session; archived on completion
interface LessonMemory {
  lessonId: string;
  currentKcId: KcId;
  phase: 'intro' | 'teach' | 'check' | 'remediate' | 'review' | 'complete';  // lesson FSM
  activeCheckId?: string;          // THE open target (stay-on-target lives here)
  inChallenge: boolean;
  lastGrading?: { correct: boolean; matchedMisconception?: MisconceptionId };
  transcript: ChatMessage[];       // bounded window (last N) used for NLU/NLG context
  hintLevelByCheck: Record<string, number>;
}

// (3) TURN MEMORY — single turn, ephemeral (also the eval/log record)
interface TurnMemory {
  studentMessage: string;
  nlu: NLUResult;
  toolResults: unknown;
  chosenAct: DialogueAct;
  constraintsEvaluated: { id: string; relevant: boolean; ok: boolean }[];
  nlgOutput: string;
}
```

**Rules:**
- The **LLM only ever sees a bounded transcript window** (lesson memory) + the current act/content — never the whole history (small-model context + latency).
- **Mastery/affect/preferences live in long-term memory**, so the tutor "remembers" the student next session.
- **Turn memory is the eval record** — the /evals harness replays/inspects it. Clean separation makes the engine testable.

---

## 9. MVP Scope (ruthless)

Goal: demonstrate **"the engine is the brain, scenarios emerge"** on a vertical slice. Build only this:

**Build:**
- **Domain model:** ONE lesson, **2–3 hand-authored KCs** (offline-authoring described, not built) with explanation, 1 worked example, 2–3 checks (MCQ/numeric/code — *deterministically gradeable*), 1–2 misconceptions, a 3-step hint ladder.
- **Student model:** **mastery counter + threshold** (NOT BKT), `explained`, `attempts`, `hintsUsed`, simple `frustration` (counter), preferences, 1–2 misconception flags.
- **Policy:** the **ordered rule cascade** in §4 (~7 acts). Plain functions, not a formal BT library.
- **NLU:** the §5 JSON schema via **one constrained LLM call** — *with a deterministic regex fallback* so the demo never hard-depends on small-model JSON.
- **NLG:** one LLM call for EXPLAIN/HINT/CORRECT/COMFORT; **templates** for ADVANCE/SIGNPOST/ENCOURAGE/ACK.
- **Tools:** answer-key grading for MCQ/numeric/keyword + a **JS code-runner** (defer Pyodide).
- **Constraints:** the 5 highest-drama, fully general: **C1 (name), C2 (challenge), C3 (no-false-validate), C7 (stay-on-target), C9 (affect)**. Structure the rest as no-ops.
- **/evals:** keep the on/off harness + scoreboard; it's the proof + regression suite.
- **Memory:** all three tiers as in §8; persist long-term to IndexedDB (or in-memory if time-boxed).

**Cut (north star, not now):** full BKT; prerequisite-graph traversal (use linear KC order); the offline authoring *pipeline* (hand-author one lesson); Pyodide; PWA / model-picker / offline; all 10 scenarios (implement the ~5 mapped to built constraints; structure for the rest); REVIEW act polish.

**Demo narrative the MVP supports:** student learns a real lesson; the *engine* visibly decides explain→ask→hint→correct→advance; /evals shows scenarios passing with guardrails (constraints) on, failing off.

---

## 10. Critical review (senior engineer, attacking the design)

**1. NLU is the new single point of failure — and it's a small model.**
We moved brittleness from regex to a 1.5B classifier. Grammar constraints guarantee *valid JSON*, not *correct labels*. If NLU mislabels `affect` or `intent`, the deterministic brain makes a *confident wrong* decision. **Mitigation (and partial retreat):** keep correctness deterministic (tools) so NLU never gates the high-stakes signal; treat `affect`/`intent` as advisory with safe defaults; regex-backstop `preference` and `request_answer`. **Honest recommendation:** for the MVP, consider making student answers *semi-structured* (the UI knows the active check type → MCQ buttons / numeric field / code box), so **grading needs no NLU at all**, and use the LLM-NLU only for free-text intent/affect. This de-risks the riskiest new component dramatically. *I'd lead with this simplification.*

**2. Two LLM calls per turn — latency on a $150 phone.**
NLU + NLG could be 5–15s on a weak device. **Mitigation:** template all non-content acts (no LLM); skip NLU when the answer is structured/gradeable; keep NLU output tiny. **Don't** merge NLU+NLG into one call — that puts the model back in the middle of the decision. Accept slightly higher latency as the cost of the architecture, or run a 0.5B for NLU and 1.5B for NLG. Flagged, not solved.

**3. Is this over-engineered for a hackathon? Partly — yes.**
A formal behavior-tree library, BKT, and a prerequisite graph are **overkill for a 2–3 KC demo**. The ordered rule cascade (§4) is just as deterministic and far simpler to build/debug. **Recommendation:** ship the cascade + mastery counter + linear KC order (already in §9). Promote to BT/BKT/graph only if the content scales. *Calling it: BT and BKT are north-star, not MVP.*

**4. Determinism vs. naturalness — the scripted-feel risk.**
A rigid cascade can feel robotic, and it has **no answer for off-script questions** (student asks something tangential). **Mitigation:** add a bounded `FREE_RESPONSE` act for the long tail — but it reintroduces the LLM as mini-controller, so constrain it hard (don't advance, don't leak, must return to the active target). This is a genuine tension; we accept a small controlled LLM-led path for tangents.

**5. Offline authoring isn't risk-free.**
If the static domain JSON has a wrong expected answer or a bad misconception, the deterministic engine confidently teaches *wrong* — worse than an LLM hedging. **Mitigation:** an authoring-time validation pass (run the checks, sanity-test against the source lesson, human review). "$0 at runtime" ≠ "free of authoring risk."

**6. Free-text grading gap.**
For conceptual free answers with no deterministic key, *who decides correct?* If we use LLM-as-judge (a small model), we reintroduce unreliability into the authoritative path. **MVP decision:** restrict checks to deterministically-gradeable types (MCQ/numeric/code/keyword). Acknowledge that rich free-text assessment is out of MVP scope.

**7. Cold start.**
First interaction has no mastery/affect data → policy uses defaults (treat KCs as unseen, neutral affect). Fine, but note that adaptivity only *appears* after a few turns — the demo should run long enough to show it.

**Simpler alternative I'd seriously consider for the hackathon:**
> **FSM(lesson phase) + ordered rule policy + deterministic grading + constrained NLG, with LLM-NLU optional (semi-structured input instead).** This keeps the philosophy intact (engine is the brain, LLM only renders) while removing the two riskiest pieces (small-model NLU reliability + double latency) from the critical path. It's *less* impressive on paper but far more likely to *work live* — which, for a demo judged on a working product, matters more.

**Bottom line:** the architecture is right and well-grounded. The two things I'd change before coding: **(a) make LLM-NLU optional via semi-structured answers for the MVP**, and **(b) use the ordered rule cascade, not a formal BT, and a mastery counter, not BKT.** Both are already reflected in §9; §10 is me arguing they're not just acceptable but *preferable* for a hackathon.

---

### Open decisions for sign-off
1. **LLM-NLU in MVP, or semi-structured input + LLM-NLU only for free-text?** (I recommend the latter.)
2. **Rule cascade vs. formal behavior tree for MVP?** (I recommend cascade.)
3. **Which lesson** to author the 2–3 KCs from — the while-loop (AI-SWE) we already have, or a BIZ unit-economics lesson? (Recommend while-loop; we have it and code is deterministically gradeable.)
