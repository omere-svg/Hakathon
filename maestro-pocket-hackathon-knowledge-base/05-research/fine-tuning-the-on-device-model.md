# Fine-tuning the on-device model — is it worth it, and can AI do the work?

**Status:** research synthesis + recommendation. **No code changed.**
**Date:** 2026-07-02
**Scope:** whether Maestro should fine-tune its on-device LLM, grounded in the real setup
(small open-weight Qwen model, 4-bit `q4f16_1`, MLC format, in-browser via WebLLM/WebGPU —
see [`webllm-research.md`], [`local-models-comparison.md`], [`small-llm-performance-playbook.md`]).
Answers two product questions: **(a)** can AI tools do most of the work, and **(b)** will it
improve the product.

> **Model-catalog note.** This research was run against **Qwen2.5-1.5B** (the default at the time).
> The catalog has since moved to the **Qwen3 family — `Qwen3-1.7B-q4f16_1-MLC` is now the default**
> (0.6B / 1.7B / 4B, with Qwen2.5-0.5B kept as a floor; see [`local-models-comparison.md`]). Same
> class of small on-device Qwen model, so the findings transfer directly. Where a finding is
> **Qwen3-specific**, it is flagged — one of them (the `q4f16_ft` caveat, §2) is now *more* relevant.

Confidence is tagged per claim. Claims that the research's own verification pass **refuted** are
marked ⚠️ **CORRECTED** — do not repeat the wrong version.

---

## Bottom line first

- **(a) Can AI/tools do most of the work? — Yes, ~80% of the *mechanical* work.** Training a
  1.5B/1.7B with LoRA is cheap (~1 hour on a free Colab / an 8GB GPU) and heavily automated.
  Generating the training data by **distilling from a large teacher model** is also automatable.
  What tools *cannot* do for you: **data-quality curation, eval design, and — the real risk —
  getting a fine-tuned model to actually run in the browser via WebLLM.**
- **(b) Will it improve the product? — Conditionally yes for JSON/protocol adherence; not clearly
  for the long-conversation problem; and only *after* cheaper fixes are exhausted.** Small models
  are exactly where fine-tuning pays off, but we have strong free alternatives to try first.
- **This is only possible because it's *our* open-weight model.** You cannot meaningfully fine-tune
  a hosted frontier model (and Anthropic doesn't offer general Claude fine-tuning); a small
  open-weight Qwen we control is the opposite case — the best case for fine-tuning.

**Recommended order (highest leverage first):**
1. **Cheap wins first** — tighter grammar-constrained decoding + "reason-then-emit-JSON" interface
   redesign + few-shot on the milestone engine's structured turns. Likely fixes most JSON
   reliability with **zero training**.
2. **Prove the WebLLM deployment path** for a fine-tuned `q4f16_1` model in the real browser target.
   This is the **go/no-go gate** — see §2.
3. **Only then**, if (1) is insufficient: **distill tutoring behaviour from a large teacher into the
   1.7B via LoRA-SFT**, then merge → quantize `q4f16_1` → convert to MLC → serve.

---

## (a) How much can AI / tools do for you?

**The training itself is nearly a solved, automated problem at this model size.** *(high confidence)*
- A profiling paper fine-tuned **Qwen2.5-1.5B on an 8GB consumer GPU: peak VRAM 6.2–8.1 GB, ~58 min
  for 3 epochs** on ~1.7M tokens. Compute cost is **negligible** — free Colab/Kaggle works.
  Gotcha: on that RTX 4060, **fp16 beat bf16** (628 vs 360 tok/s). Source:
  [arXiv 2509.12229](https://arxiv.org/pdf/2509.12229). *(single-author preprint, but the feasibility
  claim is uncontroversial and corroborated.)*
- **Unsloth** — LoRA/QLoRA with ~70% less VRAM, ~2× faster; kernel/memory details fully abstracted.
  [unsloth.ai docs](https://unsloth.ai/docs/get-started/fine-tuning-llms-guide). A merged LoRA
  adapter adds **zero inference latency** (folds back into the weights).
  [QLoRA guide](https://pockit.tools/blog/fine-tuning-llms-qlora-unsloth-complete-guide/).
- **Distillation/synthetic-data pipelines are automatable end-to-end** — **EasyDistill**
  ([arXiv 2505.20888](https://arxiv.org/html/2505.20888v1)) runs the whole KD job (incl. data
  synthesis) from one CLI command and supports **black-box SFT** (train on teacher *output text* —
  no logit access needed, so any teacher including Claude works); **Distilabel** (Apache-2.0,
  [distilabel.argilla.io](https://distilabel.argilla.io)) is one API over OpenAI/Anthropic/vLLM/etc.
  for generation + LLM-as-judge.

**What still needs a human expert (irreducible):** *(high confidence)*
1. **Data curation & review** — "quality … will largely reflect the end result of your fine-tune";
   teacher output is "plausible-sounding but incorrect" and must be filtered.
2. **Data-generation prompt engineering** — diversity (audiences × styles) matters more than volume.
   [rlhfbook.com/c/12-synthetic-data](https://rlhfbook.com/c/12-synthetic-data).
3. **Eval design** — no push-button standard; needs quantitative + LLM-as-judge + human review.
4. **Overfitting/forgetting judgment** — 1–3 epochs only; loss→0 signals overfitting.
5. **The WebLLM/MLC deployment step (§2)** — no tool automates this; it is the biggest fragility.

---

## (2) THE PIPELINE QUESTION — can a fine-tuned model actually run in WebLLM?

**Yes, and the happy path is short — but the browser stage is a genuinely separate, fragile failure
surface. This is the highest-risk part of the whole plan; de-risk it before investing in training.**

**The path** *(all steps high confidence, from official [MLC](https://llm.mlc.ai/docs/compilation/convert_weights.html)
+ [WebLLM](https://llm.mlc.ai/docs/deploy/webllm.html) docs):*
1. Merge the LoRA adapter into base weights (PEFT `merge_and_unload()`) → standard HF safetensors.
2. `mlc_llm convert_weight ./model/ --quantization q4f16_1 -o OUT` — **quantization happens here;
   source weights need NOT be pre-quantized.** `q4f16_1` (our exact format) is directly supported.
3. `mlc_llm gen_config ... --quantization q4f16_1 --conv-template ...` → `mlc-chat-config.json`
   (**non-optional**).
4. **Compile is often skippable** — because it's a supported architecture at a supported quant, you
   can reuse an existing `model_lib` WASM (MLC "Path 1: weight conversion only"). Full
   `mlc_llm compile` (needs TVM + Emscripten/`emcc`) is only required if arch or quant differs.
5. Serve in WebLLM by registering a `ModelRecord` (weights URL + `model_lib` WASM URL + `model_id`).

**Fragility caveats** *(high confidence):*
- **A fine-tuned model can run on desktop MLC yet crash *only in the browser*** with an opaque error.
  Documented real case ([mlc-llm#2601](https://github.com/mlc-ai/mlc-llm/issues/2601)): a fine-tuned
  Qwen2-0.5B crashed only in-browser; the fault traveled with the fine-tuned model's `tokenizer.json`
  + thread-parallelism, and the fix was **upstream in the WebLLM runtime (npm 0.2.57)** — outside the
  product team's control, ~7 weeks to land.
  ⚠️ **CORRECTED:** an earlier draft blamed a specific `padding` field in `tokenizer.json`; that was
  only the reporter's initial guess — the actual fix set `TOKENIZERS_PARALLELISM=false`. Trust the
  *narrative* (browser is a distinct failure surface), **not** the "padding field" root cause.
- Custom conversation templates require rebuilding MLC from source (relevant if the tutoring persona
  needs a non-standard chat format).

**Quantization-after-fine-tuning gotcha — now Qwen3-relevant** *(high confidence):*
- `q4f16_ft` ("fine-tune-optimized") quantization produced **gibberish (repeated Cyrillic) on small
  models**, while **`q4f16_1` was stable** on the same weights
  ([mlc-llm#3272](https://github.com/mlc-ai/mlc-llm/issues/3272)).
  ⚠️ **CORRECTED / and note:** the earlier draft over-applied this. The issue is specifically about
  **Qwen3-0.6B / 1.7B** — **which is now our exact model family** — and the *failing* format is
  `q4f16_ft`, **not** our `q4f16_1`, which is the confirmed-stable one. **Net: reassuring — keep
  `q4f16_1` (we already do); never switch a fine-tuned build to `q4f16_ft`.**
- In-flight: [mlc-llm PR #3281](https://github.com/mlc-ai/mlc-llm/pull/3281) adds runtime LoRA-adapter
  support; if it reaches WebLLM we could ship a small adapter over the stock base instead of
  re-converting merged weights. Not in a stable release yet.

---

## (b) Will fine-tuning actually improve the product?

### Evidence FOR (distillation into a 1.5B/1.7B) — strong *(high confidence)*
- **DistilQwen2.5** — distilling a teacher into small Qwen2.5 improves instruction-following, **gains
  largest on the smallest models**. For the **1.5B: IFEval strict-prompt 40.11 → 74.49 (+86%)** — a
  big protocol/format-adherence jump. 3B gains far less (already high).
  [arXiv 2504.15027](https://arxiv.org/html/2504.15027v1).
- **EasyDistill** into Qwen2.5-1.5B: IFEval instruct-loose 55.4 → 61.1; AlpacaEval 2.0 6.7 → 13.7.
  [arXiv 2505.20888](https://arxiv.org/html/2505.20888v1).
- **ThinkJSON** — a trained Qwen2.5-1.5B **beat 600B+ models on JSON schema adherence** (62.4% mean
  field match vs 41.4% for DeepSeek-R1 671B). [arXiv 2502.14905](https://arxiv.org/html/2502.14905).
  ⚠️ **CORRECTED:** *not* "modest compute" — it used ~20h on 8×H100 (GRPO RL) + 3h on 1×A100 (SFT).
  Treat as *proof small models can reach top-tier JSON*, **not** a cheap recipe.

### Cheaper alternatives are strong — try first *(medium–high confidence)*
- **Prompting alone** recovered small-model JSON validity to **84–87%** with no training (via an
  iterative prompt-optimizer). [arXiv 2605.02363](https://arxiv.org/abs/2605.02363).
  *(caveat: tested on 7–9B, not our 0.5–4B — scale mismatch.)*
- **Grammar-constrained decoding (GCD)** guarantees structural validity and lets off-the-shelf models
  "match or beat task-specific finetuned models" on structured tasks (peer-reviewed,
  [arXiv 2305.13971](https://arxiv.org/pdf/2305.13971)).
  ⚠️ **CORRECTED — good news for us:** an earlier "3.6–8.2× latency penalty" claim was **refuted**.
  WebLLM/MLC ships **XGrammar** ([arXiv 2411.15100](https://arxiv.org/abs/2411.15100)) with
  **near-zero (<40µs/token) overhead**. So **grammar-constrained JSON is cheap for us on-device** —
  a strong reason to push interface/grammar fixes before training.

### The "constraint tax" — a real trap *(medium confidence, contested)*
- Over-rigid schemas convert *visible* failures into *valid-but-WRONG* outputs. On **Qwen2.5-1.5B**,
  a tool-call task: prompt-only 91.5% executable accuracy vs hard-schema 48.0% — both 100% valid JSON;
  the 43.5-pt loss is semantic. [arXiv 2605.26128](https://arxiv.org/pdf/2605.26128).
  *(single-author preprint; its own main-suite tax is smaller ~8.7 pts — don't over-generalize.)*
- **Does not vanish at 3–4B** — a 3B still lost 15.3 pts under hard schema decoding.
- **"Reason free, constrain late"** + **rationale-bearing schemas** beat rigid JSON-mode with **no
  training** — i.e. better output-interface design is a free win. (This maps cleanly onto the Qwen3
  `<think>` handling already in `webllm.ts`: let it reason, then emit JSON.)

### Long-conversation drift — the honest gap 🔴 *(high confidence on the gap)*
- Persona fidelity + instruction-following **measurably degrade over long dialogues** (>100 rounds),
  worst in goal-oriented chats — exactly the tutoring case; models regress to default behaviour.
  [arXiv 2512.12775](https://arxiv.org/pdf/2512.12775) (EACL 2026). Larger models drift *less* but
  never eliminate it.
- **CRITICAL GAP:** every long-conversation/persona study found tested **prompting only, on ≥4B
  models, and did NOT test fine-tuning.** They document the failure mode we want to fix but give
  **no evidence that fine-tuning solves it.** So do **not** assume a fine-tune fixes long-conversation
  drift — address it with engine rails instead (see [`milestone-engine-long-conversation.md`]).

---

## (4) When fine-tuning is NOT worth it — and the decision order

*(central, high confidence)*
- A fine-tuned model is a **new artifact needing versioning, eval, deployment, monitoring** — ongoing
  MLOps burden. [moveo.ai](https://moveo.ai/blog/fine-tuning-rag-or-prompt-engineering).
- **Tiny-model risks:** catastrophic forgetting, overfitting (memorization on small data), alignment
  breakage. Mitigate with LoRA (frozen base), low LR, 1–3 epochs, early stopping.
- **Data-quality hard dependency & model collapse** if trained purely on model generations —
  **retaining ~10% real data dramatically limits degradation**; use diverse teachers, dedup, filters.
- **Distillation-SFT fragility:** copying the teacher's path can **overfit hard cases while failing on
  simple ones** ([aclanthology 2025.inlg-main.36](https://aclanthology.org/2025.inlg-main.36.pdf)) —
  a naïve tutoring distill could get *worse* on easy turns. Not a quantization artifact.

**Decision order:** **Prompt/interface + grammar → RAG (ground answers) → distillation SFT → LoRA**,
each only after the previous proves insufficient.

---

## What this means for Maestro (recommendation)

1. **Do the cheap wins on the milestone engine's structured turns first** — stricter grammar/schema
   (XGrammar is ~free on-device), "reason-then-emit-JSON" interface (pairs with the existing Qwen3
   `<think>` handling), few-shot exemplars. Likely resolves most JSON reliability with no training.
2. **Spike the WebLLM deployment path** — prove a *merged, `q4f16_1`, fine-tuned Qwen3* actually runs
   in the real browser target (not just desktop MLC). This is the go/no-go gate (§2). Keep `q4f16_1`;
   never `q4f16_ft`.
3. **If (1) is insufficient, pilot distillation** — large teacher (Claude / a big Qwen) → generate
   ~thousands of ideal tutoring turns in the exact milestone+JSON format → LoRA-SFT the 1.7B → merge →
   `q4f16_1` → MLC → serve. Mix in ~10% human-reviewed real data; use diverse teachers.
4. **Do NOT rely on fine-tuning for long-conversation drift** — fix that with engine rails
   ([`milestone-engine-long-conversation.md`], [`milestone-engine-weak-spots.md`]).

**Automatable vs human:** ~80% of the mechanical work automates (LoRA/QLoRA training, synthetic-data
generation, distillation orchestration, LLM-as-judge evals). Irreducible human work: data
curation/review, data-gen prompt engineering, eval design, overfitting judgment, and — most
critically — the **browser-deployment integration/debugging**, which no tool does for you.

---

## Confidence & caveats on this research
- Several §(b)/§(4) numbers come from **2026 single-author preprints** (Constraint Tax, prompt-optimizer)
  with synthetic tasks and no independent replication — medium confidence. Peer-reviewed anchors: GCD
  (EMNLP), Persistent Personas (EACL 2026), catastrophic forgetting (EMNLP 2024).
- **Corrected claims — do not repeat the wrong version:** (1) the `padding`-field root cause of #2601
  (unconfirmed); (2) `q4f16_ft` gibberish does **not** apply to our `q4f16_1`; (3) the 3.6–8.2×
  grammar-decoding latency (contradicted by XGrammar on-device); (4) ThinkJSON's "modest compute"
  (it was 8×H100 RL).
- **Biggest evidence gap:** no source directly tests whether fine-tuning fixes long-conversation drift
  at our model sizes.
- Method note: synthesized from a multi-agent web-research run (search → fetch → adversarial verify).
  The run gathered and verified sources but crashed before writing its own file; this doc is the
  salvaged synthesis.
