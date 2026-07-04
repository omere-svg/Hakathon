# Fine-tuning v2 — execution record, pipeline, and results

**Status:** EXECUTED and SHIPPED. **Date:** 2026-07-04.
**What happened:** Qwen3-1.7B was LoRA-distilled on ~775 teacher-authored examples covering
every LLM call the milestone engine makes, deployed to the browser via **wllama/GGUF**
(bypassing the broken MLC toolchain that killed attempt v1), evaluated against the base
model, and made the app default. Operational how-to lives in [`finetune/README.md`](../../finetune/README.md);
the original research/decision doc is [`fine-tuning-the-on-device-model.md`](fine-tuning-the-on-device-model.md).

---

## 1. Why v2 exists, and the one decision that made it work

Attempt v1 (2026-07-02) proved training is easy — MLX LoRA on the M5 Pro took ~5 minutes —
but died at deployment: MLC's `q4f16_1` conversion wheels are broken upstream on every
platform (orphaned nightly, TVM-FFI double-registration in stable), so the fine-tuned
weights could never reach WebLLM.

**v2's core decision: deploy through llama.cpp's toolchain instead.**
`convert_hf_to_gguf.py` → `llama-quantize Q4_K_M` → **wllama** (llama.cpp compiled to WASM,
running on CPU in the browser). Every step of that chain is robust and it worked on the
first try. The de-risking order was also inverted vs v1: the browser deployment path was
proven with the *stock* model **before** any training investment.

**Cost of the trade:** wllama is CPU, not WebGPU. Measured: ~2× slower per call than WebLLM
(tuned model averages **970 ms per engine call**, WebLLM ~570 ms; 35–65 tok/s on 15 threads).
Entirely usable for the tutoring loop.

## 2. The training-data philosophy (the important part)

The model was **not** trained on generic tutoring conversations. It was trained **per engine
call**: one dataset row = the exact `(system, user)` prompt one of the nine engine call types
sends (byte-for-byte, including the runtime ` /no_think` suffix) + the ideal output for it.

Two mechanisms keep this honest:

- **Byte-exact parity harness.** `finetune/gen/prompts.py` is a Python port of
  `maestro-open/src/engine/milestone/prompts.ts`. `scripts/parity_check.py` renders shared
  fixtures through BOTH implementations and diffs — run it after any prompts.ts change.
  If prompts drift, training data silently trains the model on inputs it will never see.
- **Specs, not rendered prompts, are stored.** `finetune/data/scenarios/*.json` holds
  builder *inputs* + ideal *outputs*; prompts are rendered at build time by
  `gen/build_dataset.py`. A prompt rewording in the engine therefore only requires
  re-syncing `prompts.py` and rebuilding — the 775 teacher outputs survive.

The data is **rails-aware**: it includes the deterministic engine's escalation notes
(attempts 1/2/3), regeneration notes (NO_PRAISE / REPETITION / EXPLAIN_FIRST /
VACUOUS_QUESTION / SYNTAX / OFF_TOPIC), grader-evidence inputs, distress cues, bridges,
and production-milestone rules — so the model gets better exactly where the rails currently
have to catch and regenerate.

**Dataset (775 specs, 8 generator agents + 1 corrective batch):**

| call type | n | what the outputs teach |
|---|---|---|
| teach | 190 | tutor voice, one producing question, honesty about wrong answers, escalation compliance, transitions without meta-talk |
| assess | 160 | strict-but-fair JSON grading; evidence must quote the student (see §4 for the 110→160 story) |
| classify | 110 | one-word ATOMIC/SPLIT, ~50/50 balanced, depth≥1 leans ATOMIC (counteracts measured split-bias) |
| expand | 80 | pure-JSON 2–3 ordered sub-goals, no parent-rephrasing, no content leakage |
| suggestions | 70 | exactly 4 student-voice chips, never leak the answer (MC exception) |
| refine | 55 | merge/drop/reorder to 1–4 bare lines, no padding |
| coverage | 45 | enumerate-only requirement lines |
| sync | 45 | conservatism: 75% of examples are `{"alsoAchieved": []}` |
| completion | 20 | warm 1–2 sentences, no question |

Split: 713 train / 62 valid (+ `eval.jsonl` companion carrying call-type + reference for grading).

## 3. Training

MLX LoRA on the M5 Pro (`mlx_lm lora`): rank-default LoRA on 0.289% of params,
`--mask-prompt` (loss on assistant tokens only), batch 2, lr 1e-4, 600 iters, checkpoint
every 50. A full run takes **~5 minutes** (~180 tok/s, peak 8.7 GB).

Key discipline: **never ship the final iteration.** Both rounds overfit past their sweet
spot (round 1: val 5.69 → **1.176 @ iter 250** → 1.24 by 600; round 2: 6.08 → **1.184 @
iter 350** → 1.35 by 600). `round2.sh` parses the val-loss log and fuses the argmin
checkpoint automatically.

Toolchain gotcha: `mlx-lm` 0.31.x declares transformers≥5 and crashes with it — pin
**`mlx-lm==0.28.4` + `transformers<5`**.

## 4. Evaluation and the round-1 lesson

`scripts/eval_model.py` runs the held-out set through base and tuned models with per-type
structural checks (JSON validity/schema, exact one-word verdicts, 4-line chips, bare lines,
teach style rules) and verdict-accuracy checks where the reference encodes a judgment
(classify word, assess bool, sync emptiness). `eval_compare.py` diffs and flags regressions.

**Round 1 caught the classic distillation trap.** The first assess dataset (50 true /
60 false, with vivid strictness rationales) made the tuned grader **over-strict**: 7 of 8
misses were false-*negatives* with pedantic, sometimes self-contradictory rationales
("a correct f-string" → `achieved: false`). The base model fails in the opposite direction
(all its misses were false-positives — praising told/parroted answers). Fix: a corrective
50-spec batch (`assess-accept.json`, 42 true / 8 false) teaching *acceptance* of correct
substance — terse, hedged, typo'd, paraphrased, after-hint, and multi-message answers.

**Round 2 results (shipped), base → tuned:**

| check | base | tuned |
|---|---|---|
| assess verdict | 50.0% | **58.3%** |
| classify verdict | 90.0% | **100%** |
| completion no-question | 0% | **100%** |
| refine format (bare lines) | 33.3% | **100%** |
| teach one-question | 90.9% | **100%** |
| all JSON format checks | 100% | 100% |
| expand format | 100% | 90.0% ⚠ |
| refine length ≤5 | 100% | 66.7% ⚠ |
| suggestions 4-line | 100% | 87.5% ⚠ |

The three ⚠ dips are each a single eval item and share one failure mode: **low-temperature
repetition loops** (e.g. two refine lines repeated 5×). The engine's deterministic layer
already caps/salvages exactly these (subGoal caps, draft+1 step cap, chips take-first-4),
so they were accepted rather than chasing a third round. Known watch-items: those loops,
plus one observed suggestions answer-leak on an MC-adjacent question.

Live corroboration from the benchmark: the *base* model produced malformed JSON
(`"…"]]`) and a 1-line suggestions reply on real engine prompts in the same run — the
exact failures the tune eliminates.

## 5. Deployment

- **Artifact:** `qwen3-1.7b-maestro-q4_k_m-0000N-of-00003.gguf` in
  `maestro-open/public/models/` (gitignored). **~1.05 GB download / disk; ~1.6–1.8 GB RAM**
  in-tab at n_ctx 4096 (vs ~2 GB for the stock WebLLM build it replaces).
- **Sharding is mandatory:** wllama's WASM **aborts** loading a single 1.2 GB file
  (observed live). `llama-gguf-split --split-max-size 400M`; point the URL at shard 1.
- **Adapter:** `src/llm/wllama.ts` implements the same `LLMEngine` seam as webllm.ts and
  reuses the Qwen3 quirks (`/no_think`, `<think>`-stripping, sampling). Selected by the
  `backend` feature flag (`src/config/features.ts`) — **now defaulting to `'wllama'`** with
  the Maestro model; `'webllm'` = stock WebGPU fallback.
- **Multi-threading needs COOP/COEP headers** (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: credentialless`) — set for dev in vite.config.ts;
  **production hosting must send the same two headers** or wllama silently runs
  single-threaded (several× slower). `credentialless` (not `require-corp`) keeps WebLLM's
  HF-CDN fetches working.
- **Smoke/bench harness:** `maestro-open/bench.html?run=1` runs stock-GGUF vs tuned-GGUF vs
  WebLLM on real engine prompts; streams progress to `finetune/work/bench/bench-progress.log`
  and posts results to `bench-results.json`. Final smoke: **0 errors**, tuned loads in
  ~1.6 s, avg 970 ms/call.
- Two operational landmines the harness now guards against: don't benchmark while MLX
  trains (WebGPU device drops), and never two bench tabs at once (they race on wllama's
  OPFS model cache) — hence the one-shot `?run=1` gate.

## 6. Redo recipe (when the algorithm changes)

1. Freeze prompts.ts → run the parity trio (`dumpPrompts.ts`, `dump_prompts.py`,
   `parity_check.py`); re-sync `gen/prompts.py` if it fails.
2. Add/adjust scenario specs if new call types or rails appeared.
3. `bash finetune/scripts/round2.sh` — rebuilds data, trains, picks best checkpoint, fuses,
   converts, shards, stages, evals base-vs-tuned, prints the comparison (~15 min total).
4. Check `eval_compare.py` output for regressions; smoke via `bench.html?run=1`.
