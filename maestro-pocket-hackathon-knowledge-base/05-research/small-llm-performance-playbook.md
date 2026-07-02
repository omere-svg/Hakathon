# Running GREAT on a Small On-Device LLM — the Performance Playbook

> The **technique catalogue** for making a small phone model teach well. The *principles* (reduce / constrain / verify / ground / speed / reach) are engine-agnostic and still the core pitch.
> ⚠️ **Implementation-status caveat (2026-07):** many "[DONE]" items below were implemented in the **removed verify engine** (structured turns, best-of-N, verify→re-prompt, exemplars, the `/benchmark` page, guard scrub) and **no longer exist** — the current model-driven **Milestone Engine** ([../06-product-decisions/architecture.md](../06-product-decisions/architecture.md)) implements only the **device picker + PWA + `/no_think`** from this list and applies "reduce/constrain" via bounded decomposition + tiny isolated contexts rather than authored JSON. Treat the marked statuses as the *verify-engine era*; §9 has the corrected current table. The removed levers are exactly the roadmap's "scenario-hardening" backlog.
> Status legend: **[DONE]** implemented · **[NEXT]** highest-leverage to build · **[LATER]** real-product depth.
> Builds on [offline-to-ondevice-pipeline.md](offline-to-ondevice-pipeline.md), [local-models-comparison.md](local-models-comparison.md), [webllm-research.md](webllm-research.md).

---

## 0. The thesis (say this on stage)

> **A small model's raw quality is fixed. Its *effective* quality as a tutor is a systems problem — and that's where we win.**

We don't try to make a 1.5B "smarter." We make the *system around it* so well-engineered that the model only ever does the narrow thing it's reliably good at — phrasing pre-authored pedagogy, in tightly-constrained outputs, checked and cheaply retried, grounded in tools. Six levers turn "model quality" into engineering we control:

1. **Reduce** what the model must decide (offline authoring).
2. **Constrain** how it's allowed to generate (grammar/structure).
3. **Verify cheaply** and retry / pick-best (the moat).
4. **Ground** it in tools + retrieved lesson content (no hallucinated facts).
5. **Speed** it up on the phone (caching, routing, short outputs).
6. **Reach** the actual device (tiering, fallback, offline).

Each lever is a concrete, demonstrable technique. Below, ranked by impact × demonstrability.

---

## 1. REDUCE — move judgment offline so the small model barely thinks **[DONE, deepen]**

- **[DONE] Presentation Guidelines** — the big model authors *how* to teach each concept (core idea, analogy, arc, emphasize, avoid). The small model renders, doesn't invent pedagogy. (See pipeline doc §1b.)
- **[DONE] Tools own correctness** — code-runner / calculator / answer-key produce the verdict; the model never judges right/wrong or does arithmetic.
- **[NEXT] Authored few-shot exemplars per act.** Ship 1–2 *gold* example turns (a great HINT, a great EXPLAIN) with each lesson, authored offline by the big model. **Small models imitate examples far better than they follow rule lists** — this is one of the cheapest, biggest quality lifts available, and it's free at runtime. The exemplar goes in the prompt for the matching act.
- **[NEXT] Difficulty-aware routing.** Many turns are deterministic (a topic transition, an acknowledgement, the exact authored question) — serve those as **templated text with no model call at all**. Only spend a model call on the genuinely conversational/adaptive turns. Fewer calls → less latency, less variance, less battery, fewer chances to slip. (Honest: templated *transitions* are not faked teaching — the substantive turns are all model.)

## 2. CONSTRAIN — grammar-constrained decoding (the single biggest reliability unlock) **[NEXT]**

WebLLM/MLC supports **structured / grammar-constrained generation** (JSON-schema response format and a grammar engine). This is the highest-impact unbuilt lever:

- **[NEXT] Structured turns.** Force the model to emit a small JSON object (`{ acknowledge?, teach?, question }`) instead of free prose. The structure is guaranteed; we render it. Eliminates rambling, missing questions, and format drift — the most common small-model failures.
- **[NEXT] Structurally impossible answer-leaks (logit ban).** In challenge mode, **forbid the answer's tokens at the decoder** so the model *cannot* emit them — a stronger guarantee than our current post-hoc `guard()` scrub. "The model literally cannot type the answer in challenge mode" is a crisp, defensible claim for judges.
- **[NEXT] Reliable NLU via JSON mode.** When we need the model to classify (e.g., grade a free-text conceptual answer against authored rubric criteria), constrain it to a tiny enum/boolean schema. Small models classify *far* better than they free-generate; grammar guarantees parseable output.

Why this matters most: a 1.5B asked to "write a good tutor turn" is unreliable; a 1.5B asked to "fill these three fields, and you may only output this grammar" is reliable. We convert open generation into constrained slot-filling.

## 3. VERIFY CHEAPLY — exploit that small models are cheap **[DONE, upgrade]**

- **[DONE] verify → re-prompt** with a precise correction (≤2). Already lifts compliance.
- **[DONE] Structural scrub (C1/C2)** — name + leaked-answer guaranteed by redaction.
- **[NEXT] Best-of-N + verifier-pick** (instead of, or before, serial re-prompt). Because tokens are cheap and turns are short, **sample N candidates in one batch, run the deterministic verifier on each, return the first that passes.** This raises pass-rate like self-consistency but **without an unreliable judge model** — our judge is deterministic code. It also bounds latency better than sequential re-prompts (one parallelizable round vs up to 3 serial calls). Combine: best-of-N first, re-prompt only if all N fail.
- **[LATER] Telemetry on repair** — record pass-rate, repair-rate, and which constraint fires most, per model. Feeds both the demo (§6) and prompt tuning.

## 4. GROUND — tools + retrieval keep a small model factual **[DONE, extend]**

- **[DONE] Calculator + code-runner** — all math/code verified; values handed to the model.
- **[DONE] Tiny, retrieved context** — only the current KC's guideline + relevant facts enter the prompt (not the whole course). Small context = focused small model + faster decode.
- **[NEXT] Model-initiated tool calls.** Let the model request a calculation/run via structured output when the student goes off the authored path (e.g., asks about `19 % 4`), results fed back. Keeps facts grounded even off-script. (Bounded, structured tool-use loop.)

## 5. SPEED ON THE PHONE — latency is a UX killer on weak GPUs **[NEXT]**

- **[NEXT] Prefix / KV-cache the constant context.** The system prompt (persona + lesson reference + guideline) is large and *unchanged within a lesson*; only the student's new message varies. Reuse the cached KV for the constant prefix so each turn decodes only the new tokens — a large latency win on phones. (Verify MLC prefix-cache reuse; structure prompts so the variable part is last.)
- **[DONE] Short outputs by design** (≤4 sentences, capped tokens) + **streaming** for perceived speed.
- **[NEXT] Difficulty routing** (see §1) — skip the model entirely on deterministic turns.
- **[LATER] Warm preload** during onboarding; persistent engine across turns; OPFS weight cache so it's instant on return.

## 6. REACH — actually run on the user's real phone **[LATER]**

- **[LATER] Device-tiered model picker** — auto-detect RAM/GPU → 0.5B / 1.5B / 3B; let the user override. (Brief explicitly asks: "ask the phone vs one model for all" — answer: auto-detect + override.)
- **[LATER] WASM/CPU fallback (wllama)** for no-WebGPU devices; **honest unsupported screen** only as the final floor.
- **[LATER] PWA + offline** — cache app shell + lesson JSON + weights; full offline after first load. Decisive for low-connectivity students (the actual target user).

---

## 7. The MEASUREMENT story — *prove* we make small models good **[NEXT — this is the demo centerpiece]**

The most persuasive thing for judges isn't a claim, it's a **number**:

> Build a **benchmark page** that runs the 10 TutorBench failure modes across **0.5B / 1.5B / 3B**, **with vs without the engine**, and shows pass-rate + median latency + repair-rate. Expected shape of the result: *raw small models fail most failure modes; wrapped in our engine they pass nearly all — and the lift is biggest on the smallest models.*

That single chart **is** the pitch: "Here is a phone-sized model failing. Here is the same model, same device, $0, passing — because of the engine. The smaller the model, the more our engine matters." Pair with a live `/evals` run on the real device.

---

## 8. Teaching like a professor on a 1.5B — pedagogical tricks unique to small models

> **The unifying principle (say this on stage):** a big model gets to *think*; a small model does not. A professor's job is half **reasoning** (which a 1.5B fails) and half **recognizing** what the student is doing and **saying the right thing warmly** (which a 1.5B is fine at). So **move every act of reasoning, creation, and judgment offline (big model) or into deterministic tools, and leave the small model only two things it's reliably good at: recognition (classification) and rephrasing (NLG).** Every trick below is an instance of that principle — and every one is *unnecessary for a 70B*, which can simply reason for itself.
>
> **The one thing a human tutor does that a small model always fails at:** *inhabit the student's mind* — infer the exact misconception behind a wrong answer — and *reason flawlessly while explaining*. Tricks 1–2 attack precisely those.

### Trick 1 — "Narrate, don't derive": precomputed, tool-verified reasoning
- **Professor superpower:** works every example correctly, live.
- **Why a 1.5B fails (a 70B wouldn't need this):** it generates *plausible-but-wrong* chains — arithmetic slips, skipped steps, invented lemmas.
- **The trick:** the small model is **never allowed to derive**. The reasoning trace is produced offline (authored) or at runtime by the **code-runner / calculator**, as an ordered list of *verified* steps. The model's only job is to **voice the next verified step** conversationally. "Do the math" becomes "rephrase this correct sentence." The tutor *cannot* make a computational error because it never computes.
- **Modules:** worked examples → `steps: {claim, verifiedBy}[]` + a reveal-one-step loop; calculator/code-runner already own facts (C4). **Status: 🟡** (facts done; step-narration loop = next).

### Trick 2 — Diagnosis-by-classification: the "Bug Library"
- **Professor superpower:** "Ah — you divided by cost, not price." Names the *exact* mental bug.
- **Why a 1.5B fails:** open-ended diagnosis is reasoning about a latent mind → it falls back to generic "review the material."
- **The trick:** author a **bug library** per concept offline (the big model enumerates the 3–5 classic misconceptions + a *signature* + a *gap-revealing remediation*). At runtime, convert **diagnosis → constrained multiple-choice**: hand the small model the wrong answer + the short candidate list and have it **pick the index** (grammar-constrained enum), or match by signature deterministically; then deliver the *authored* remediation. Research backs this: grammar constraints "substitute for in-context examples, especially for smaller models," and small models classify far more reliably than they generate.
- **Modules:** we have `misconceptions[]` + MCQ-index mapping; the upgrade is a constrained-classification diagnoser for free-text/code wrong answers. **Status: 🟡** (MCQ path done; free-text classifier = next).

### Trick 3 — The Representation Ladder: genuine re-explanation
- **Professor superpower:** you don't get analogy A → they switch to a concrete example, then a diagram, then a counterexample.
- **Why a 1.5B fails:** asked to "explain it differently," it *paraphrases the same representation* — inventing a new mental model needs knowledge/creativity it lacks.
- **The trick:** author **N distinct representations per concept** offline (formal / analogy / worked example / ASCII-visual / counterexample). The **engine** tracks which have been used and, on repeated confusion, hands the model the *next unused* one to deliver. "Explain another way" becomes `representations[used++]`. The variety comes from the offline library, not the model.
- **Modules:** extend `PresentationGuideline` with `representations: {kind, text}[]`; a confusion counter in the student model selects the next. **Status: ⬜ next** (presentation guideline is the hook).

### Trick 4 — Engine-scheduled metacognition: force the highest-ROI moves
- **Professor superpower:** knows *when* to quiz from memory (retrieval practice), ask you to explain it back (self-explanation), make you predict before revealing, throw a twist (desirable difficulty), and revisit last week's idea (spacing) — the techniques with the strongest evidence base in learning science.
- **Why a 1.5B fails:** these need *judgment about timing* — it won't spontaneously insert "before I show you, what do you predict?" And crucially, **students themselves under-rate and skip these effortful techniques**, so leaving it to either party fails.
- **The trick:** the **deterministic policy schedules them as authored beats** — predict-before-reveal, explain-back-after-master, a transfer/twist check *before* accepting mastery, spaced re-surfacing of weak KCs. The model only voices the scripted move; the pedagogy lives in the engine's schedule, not the model's judgment.
- **Modules:** policy beats + student-model mastery/affect + the spaced-repetition module. **Status: 🟡** (mastery gating + spaced-repetition-lite done; predict-before-reveal & explain-back beats = next).

### Trick 5 — Zero-authority rendering: calibration by construction
- **Professor superpower:** never states a fact they're unsure of; says "let's check."
- **Why a 1.5B fails:** it has **no calibration** — confidently wrong, with no reflex to hedge.
- **The trick:** architecturally strip the model of *authority*. Every assertion the tutor makes must trace to (a) authored content or (b) a tool result; the model may only **rephrase provided assertions, never originate one**. A **claim-grounding verifier** flags a sentence asserting something not present in the situation → re-prompt "use only the provided facts." The tutor can't hallucinate a fact because it isn't permitted to invent one.
- **Modules:** generalize the C4 factual-grounding verifier into a broader "grounded-claims" check. **Status: 🟡** (numeric grounding done; general claim-grounding = research-grade next).

**Across all five:** big models get to think; we don't trust ours to, so it only *recognizes and rephrases* while offline authoring + deterministic tools supply the thinking. That is how a 1.5B teaches like a professor — and exactly why none of it is needed at 70B.

## 9. Build status (current — Milestone Engine)

Corrected for the current build. Most verify-engine levers were **removed** with that engine; they're the "scenario-hardening" roadmap backlog.

| # | Technique | Lever | Status now |
|---|---|---|---|
| 1 | Grammar/JSON-constrained structured turns | Constrain | ⬜ removed — grammar mode disabled (WebLLM 0.2.84 bug); JSON salvaged from free text (`json.ts`) |
| 1b | Logit answer-ban / guard scrub | Constrain | ⬜ removed with the verify engine |
| 2 | Benchmark / eval page | Measure | ⬜ removed (`/benchmark`, `/evals` deleted) — roadmap "Later" |
| 3 | Authored few-shot exemplars | Reduce | ⬜ removed (authored-KC schema deleted) |
| 4 | Best-of-N + verifier-pick | Verify | ⬜ removed |
| 5 | Prefix-cache-friendly layout | Speed | 🟡 prompts still put the constant part first; no flag / explicit KV reuse |
| 6 | Device picker · PWA offline · OOM step-down | Reach | ✅ Qwen3 tiered picker + PWA + load-time step-down; ⬜ WASM fallback |
| 6b | Qwen3 `/no_think` + `<think>` strip | Speed/Constrain | ✅ (`webllm.ts`); dev `thinking` toggle |
| 7 | Bounded recursive decomposition + per-milestone context isolation | Reduce | ✅ the milestone engine's core "reduce what the model decides" |
| 8 | Persistent progress · spaced repetition · offline authoring | Product/Scale | ⬜ removed — roadmap items |

## 10. How the modules interact to keep COGS at $0

The whole system is engineered so the **only per-user cost is static file delivery** — never inference:
- **Authoring** (big model) runs **offline, once per course** (your key, not per user) → static JSON. The `author` scaffold emits the prompt; `validate` gates the output.
- **Exemplars + presentation guidelines** ride along in that static JSON — they make the small model better at **zero runtime cost**.
- **All inference is on-device** (WebLLM/WebGPU). Structured output, best-of-N, verify→re-prompt, and the guard scrub all run locally — they spend the *user's* compute, not ours.
- **Persistence + PWA** are on-device (localStorage / Cache API), so returning users cost nothing and can run **offline**.
- **The model picker** sizes the model to the device so weak phones still run locally rather than falling back to a paid cloud call.
- Net: more users → more static downloads (free-tier CDN) and more *on-device* compute → **$0 marginal COGS**, exactly the brief's rule.

## 11. Honest risks
- **Constrained decoding can feel stiff** if over-tight → keep the `question`/`teach` fields free-text within the grammar; constrain *structure*, not *wording*. (Research confirms over-constraining can reduce fluency/accuracy — hence "structure not wording," and the delimiter-hybrid option.)
- **Over-authoring → a slideshow.** The pedagogical tricks (§8) pre-stock content; keep the model owning the live conversation and a bounded free-response path for tangents, or it stops feeling like a tutor.
- **Best-of-N costs tokens/battery** → cap N at 2–3, only for turns that failed first verify.
- **Prefix-cache reuse** depends on MLC support + prompt layout → verify empirically; fall back to plain decode if unsupported.
- **The benchmark must stay honest** — real model both arms, no template masking (already our stance).

### Learning-science grounding (§8)
The tricks operationalize well-established findings: the **worked-example effect** + **cognitive load theory** (Sweller) → Trick 1; **constraint-based / bug-library tutoring** (Ohlsson; Mitrovic) + **grammar constraints as a substitute for in-context examples on small models** → Trick 2; **multiple representations** → Trick 3; **retrieval practice**, **self-explanation** (Chi), **desirable difficulties** (Bjork), and **spacing/distributed practice** — the highest-evidence techniques, which learners systematically under-use → Trick 4; **formative-assessment / epistemic-calibration** discipline → Trick 5.

### Sources
- [Using Retrieval Practice to Increase Student Learning (WashU CTL)](https://ctl.wustl.edu/resources/using-retrieval-practice-to-increase-student-learning/)
- [Retrieval Practice in Stepwise Worked Examples Improves Learning (ScienceDirect, 2025)](https://www.sciencedirect.com/science/article/pii/S0959475225001203)
- [Grammar-Constrained Decoding Makes LLMs Better Logical Parsers (ACL 2025)](https://aclanthology.org/2025.acl-industry.34/) — grammar constraints substitute for in-context examples, "especially beneficial for smaller models."
- [Beyond Free-Form Text: How Constrained Decoding is Reshaping Structured Generation](https://medium.com/@brijeshrn/beyond-free-form-text-how-constrained-decoding-is-reshaping-structured-generation-in-llms-5f7a38bef259)

### Consistency
Extends the v2.5 design in [../06-product-decisions/architecture.md](../06-product-decisions/architecture.md); model choices per [local-models-comparison.md](local-models-comparison.md); runtime constraints per [webllm-research.md](webllm-research.md) and [mobile-device-strategy.md](mobile-device-strategy.md).
