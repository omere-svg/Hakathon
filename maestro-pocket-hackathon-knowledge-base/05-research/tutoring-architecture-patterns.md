# Tutoring & Dialogue Architecture Patterns

> Written after a design critique of the first vertical slice. The slice worked but exposed a structural flaw: **the LLM was the de-facto controller** (it free-generated each turn; we checked and patched afterward). That is backwards for what we want — *a real AI tutor with a deterministic teaching engine underneath, where the LLM mainly generates natural language.*
> This doc surveys the prior art we should **borrow instead of invent**, so our design sits on 40 years of intelligent-tutoring research and standard dialogue-system engineering rather than ad-hoc guardrails.
> Conclusions feed the rewritten [architecture.md](../06-product-decisions/architecture.md).

---

## 0. The core realization

We are not building "a chatbot with guardrails." We are building an **Intelligent Tutoring System (ITS)** whose dialogue runs through a **task-oriented dialogue pipeline**, where the **policy is deterministic** and the **LLM is confined to two jobs it is actually good at: understanding the student (NLU) and phrasing replies (NLG).**

The 10 TutorBench scenarios are **acceptance tests**, not implementation targets. If the engine is built on the right general mechanisms, the scenarios pass *as a consequence*. (See the mapping in [architecture.md](../06-product-decisions/architecture.md).)

## 1. Intelligent Tutoring Systems — the four-component model

ITS research (Anderson's Cognitive Tutors; VanLehn) converges on a **modular architecture** that has survived from rule-based systems into today's LLM-based ones. Four components:

1. **Domain model** — expert knowledge: the concepts/skills, their dependencies, expected solutions, and *common errors*. Encoded as rules, knowledge graphs, or curated content.
2. **Student (learner) model** — an evolving estimate of what *this* learner knows, can do, and how they feel. Bayesian (BKT), deep (DKT), or simple counters.
3. **Tutoring (pedagogical) model** — decides *what to do next*: explain, ask, hint, remediate, advance.
4. **Communication / UI** — how it talks to the learner.

**Why we adopt it:** the user's requested behavior ("decide what concept comes next, decide explain/ask/hint/advance, track mastery, keep the model inside the structure") is *literally the tutoring model + student model + domain model*. Our current code has only a thin UI and a persona string — it is **missing the student and domain models entirely**, which is why it can only react to the last message instead of *teaching*.

## 2. Constraint-Based Modeling (CBM) — general error handling without scripting every case

CBM (Ohlsson; Mitrovic, **SQL-Tutor** — the first constraint-based tutor) expresses domain knowledge as **constraints**, each with two parts:
- a **relevance condition** ("this situation applies"), and
- a **satisfaction condition** ("…and here's what must then be true").

If a student state is *relevant* but *not satisfied* → that's an error → the violated constraint says what feedback to give. CBM was invented precisely to **avoid intractable, hand-authored per-case student models** while staying "precise enough to guide instruction and computationally tractable." Empirically effective (SQL-Tutor improved exam performance; added positive feedback ~2× learning speed).

**Why we adopt it:** this is the principled version of our "guardrails," and it directly answers the user's rule *"general mechanisms, not scenario-specific logic."* Our guardrails become **constraints**:
- "If the student stated a preferred name (relevant), the tutor's reply must use it and not the rejected one (satisfaction)." → handles SWE-10/BIZ-10.
- "If the tutor asked about target T (relevant), the next tutor turn must address T or explicitly signpost a switch (satisfaction)." → handles SWE-04/BIZ-04.
- "If in challenge mode (relevant), the reply must not contain the answer (satisfaction)." → handles SWE-03/BIZ-03.
Each TutorBench failure mode = one violated constraint = one acceptance test. We never write code "for SWE-10"; we write the general constraint and SWE-10 passes as a side effect.

## 3. Bayesian Knowledge Tracing (BKT) — a tiny, on-device student model

BKT (Corbett & Anderson) models mastery of each **knowledge component (KC)** as a hidden binary state, updated from correct/incorrect evidence with four parameters (prior, learn, slip, guess). It is **cheap, interpretable, and runs trivially on-device** — a few floats per KC in IndexedDB.

**Why we adopt it (in lean form):** it gives the tutoring model something real to consult ("is this KC mastered yet?") so progression is **evidence-driven**, not vibes. For a hackathon we can start even simpler (a mastery counter + threshold = *mastery learning*, Bloom) and upgrade to BKT later. Either way, **a student model is the missing leg** that turns "reactor" into "tutor," and it is what makes the tutor *feel adaptive/intelligent* without a bigger LLM.

## 4. Task-oriented dialogue pipeline — "what to say" vs "how to say it"

Standard task-oriented dialogue (TOD) systems are a pipeline: **NLU → Dialogue State Tracking (DST) → Dialogue Policy → NLG.** A key, repeatedly-validated principle: **separate semantics ("what to say", a *dialogue act*) from surface realization ("how to say it", natural language).** Modern practice even uses a **deterministic FSM/script as the dialogue backbone to strictly constrain the LLM's action space**, ensuring it follows the expert-authored protocol, while the LLM handles understanding and phrasing.

**Why we adopt it:** this *is* the user's philosophy, and it's a solved engineering pattern — we don't invent it. Our per-turn loop becomes:
1. **NLU (LLM, constrained output):** read the student's message → structured facts (answer correct? misconception? distress? preference? intent?). The LLM does the messy language understanding it's good at — replacing brittle regex.
2. **State update (deterministic):** update student model, affect, preferences, active target.
3. **Policy (deterministic):** choose one **dialogue act** + payload (which KC, hint level, remediation, next question).
4. **NLG (LLM, constrained — or a template):** render that act in warm Maestro voice. The LLM phrases; it cannot change the plan.

The LLM is now a **language layer at both ends**, never the controller.

## 5. Behavior Trees — the elegant shape for the tutoring policy

Game AI moved from **finite-state machines** to **behavior trees (BTs)** because FSMs suffer "state explosion": every new behavior adds transitions until the graph is a tangle. BTs are **modular and reusable** — every node has the same contract, so subtrees compose as building blocks; you add behaviors without touching existing ones. Best practice **separates *deciding* an action (BT) from *executing* a stateful mode (FSM)**.

**Why we adopt it:** the tutoring policy is a *prioritized decision* made every turn ("comfort first if distressed → never leak in challenge → fix a detected misconception → if KC mastered, advance → else teach the next beat / ask"). A BT expresses these **priorities and fallbacks** cleanly and stays extensible as we add the other scenarios — exactly where a pile of `if` statements (our current trajectory) would rot. A small lesson-phase FSM (teach → check → remediate → advance) handles the stateful mode; the BT picks the act within it.

## 6. Dialogue acts — the vocabulary the policy emits

From speech-act theory and TOD: the policy's output is a **dialogue act** from a small fixed set, e.g.:
`COMFORT, EXPLAIN, WORKED_EXAMPLE, ASK, HINT(level), CORRECT_MISCONCEPTION, ADVANCE, SIGNPOST_SWITCH, ACKNOWLEDGE`.
Each act has a **content payload** (which KC, which question, which hint) and a **rendering contract** (length, must-end-with-a-question, may/​may-not include the answer). Many acts (ADVANCE, SIGNPOST_SWITCH, ACKNOWLEDGE) can be **templated with no LLM call**, cutting latency and increasing determinism; only EXPLAIN/HINT/COMFORT really need NLG.

## 7. The authoring insight (cheap content, $0 per user)

A richer domain model (KCs, prerequisites, expected answers, **misconception→remediation** maps, **hint ladders**, constraints) sounds expensive to author. The resolution that keeps us at **$0 COGS**:

> **Author the domain model OFFLINE with a big frontier model (at build time, by us), then freeze and ship it as static JSON.** Per-user runtime stays on-device (tiny NLU + NLG calls + deterministic policy). The expensive intelligence is paid once, at authoring, not per user.

This also answers the Masterschool scaling question ("who writes all this content for thousands of lessons?") — a pipeline converts existing Maestro/LMS lessons into the domain-model JSON offline.

## 8. Risks this architecture introduces (be honest)

- **On-device NLU reliability.** A 1.5B model must emit reliable structured classifications. Mitigate with **grammar/JSON-constrained decoding** (WebLLM supports it), a **tiny label space** (a few enums/booleans — small models classify far better than they free-generate), and **deterministic ground truth where available** (a code-runner verifies code answers; MCQ is exact-match) so NLU isn't a single point of failure.
- **Latency: two LLM calls/turn.** Mitigate by **templating non-NL acts** (no LLM), keeping NLU output tiny, and short-circuiting NLU when a deterministic tool already knows the answer.
- **Scripted/robotic feel.** If the policy is too rigid, the tutor feels canned. Mitigate by letting **NLG own phrasing freely** within the act, and allowing a fallback "free Socratic reply" act for the conversational long tail — the spine is deterministic, the texture is not.
- **Over-engineering for a hackathon.** A full BKT + concept graph + CBM + BT is a lot. Ship the **minimum viable ITS** (ordered KCs + mastery counter, a 5–7 node BT, a handful of general constraints, NLU/NLG split) and grow it. Principled but lean.

---

### Summary — what we borrow
| Need | Pattern | Source |
|---|---|---|
| Overall structure | ITS 4-component model (domain/student/tutor/UI) | Anderson; VanLehn |
| General error handling (our "guardrails") | Constraint-Based Modeling | Ohlsson; Mitrovic (SQL-Tutor) |
| On-device mastery tracking | Bayesian Knowledge Tracing (lean: mastery learning) | Corbett & Anderson; Bloom |
| Engine-drives-LLM control flow | TOD pipeline NLU→DST→Policy→NLG; semantics vs realization | TOD literature |
| Tutoring policy shape | Behavior Tree (decide) + small FSM (execute) | Game AI |
| Policy output vocabulary | Dialogue acts | Speech-act theory / TOD |
| $0 COGS + scale | Offline authoring with a big model, frozen to static JSON | (our synthesis) |

### Sources
- [A Comprehensive Review of AI-based Intelligent Tutoring Systems (arXiv 2025)](https://arxiv.org/pdf/2507.18882)
- [AI-Based Intelligent Tutoring Systems (overview)](https://www.emergentmind.com/topics/ai-based-tutoring-systems)
- [Enhancing traditional ITS architectures with LLMs for motivational feedback (ScienceDirect 2025)](https://www.sciencedirect.com/science/article/pii/S2666920X25000736)
- [Fifteen years of constraint-based tutors (Mitrovic et al.)](https://dl.acm.org/doi/10.1007/s11257-011-9105-9)
- [Evaluating the effectiveness of feedback in SQL-Tutor (Mitrovic & Ohlsson)](https://www.researchgate.net/publication/3880738_Evaluating_the_effectiveness_of_feedback_in_SQL-Tutor)
- [A Survey on Recent Advances in LLM-based Multi-turn Dialogue Systems (ACM)](https://dl.acm.org/doi/pdf/10.1145/3771090)
- [Modelling Hierarchical Structure between Dialogue Policy and NLG (arXiv)](https://arxiv.org/pdf/2006.06814)
- [Comparison between Behavior Trees and Finite State Machines (arXiv 2024)](https://arxiv.org/html/2405.16137v1)
- [Behavior Trees vs Finite State Machines (Opsive)](https://opsive.com/support/documentation/behavior-designer-pro/concepts/behavior-trees-vs-finite-state-machines/)
