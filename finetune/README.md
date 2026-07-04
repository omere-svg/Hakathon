# finetune/ — the Maestro on-device fine-tuning pipeline

Distills ideal per-call behaviour into the app's Qwen3-1.7B and ships it to the browser as
a sharded GGUF served by the wllama backend. Executed and shipped 2026-07-04; the full
narrative, results, and decisions are in
[`../maestro-pocket-hackathon-knowledge-base/05-research/fine-tuning-v2-execution.md`](../maestro-pocket-hackathon-knowledge-base/05-research/fine-tuning-v2-execution.md).

**Everything reproducible is one command:** `bash scripts/round2.sh` (~15 min: build data →
train → pick best checkpoint → fuse → GGUF → shard → stage into the app → eval base vs tuned).

## Layout

```
gen/
  prompts.py        Python port of maestro-open/src/engine/milestone/prompts.ts.
                    MUST stay byte-identical to the TS builders — training on prompts the
                    engine doesn't actually send is wasted. Parity is enforced (below).
  build_dataset.py  Renders data/scenarios/*.json specs through prompts.py into
                    work/dataset/{train,valid}.jsonl (mlx_lm chat format, ` /no_think`
                    baked into system) + eval.jsonl (call type + reference, for grading).
                    Validates every spec structurally and dedups.
  AGENT_GUIDE.md    The authoring contract the data-generation agents followed: spec
                    schema per call type, tutor-voice rules, the non-negotiable behaviors
                    (honesty about wrong answers, escalation compliance, sync conservatism,
                    classify balance, no answer-leaks in chips…), diversity requirements.

data/
  scenarios/*.json  THE dataset (775 specs, committed): builder inputs + ideal outputs,
                    per call type. Prompts are rendered at build time, so engine prompt
                    rewording does NOT invalidate these — just re-sync prompts.py.
                    assess-accept.json is the round-2 corrective batch (see execution doc §4).
  parity-fixtures.json  Shared fixtures for the parity check.

scripts/
  round2.sh         The whole pipeline end-to-end (canonical entry point).
  train.sh          Older round-1 variant (kept for reference; round2.sh supersedes it).
  eval_model.py     Runs work/dataset/eval.jsonl through a model (base or fused) with
                    per-type structural + verdict checks → work/eval/{base,tuned}.json.
  eval_compare.py   Base-vs-tuned table, flags regressions.
  dump_prompts.py   Renders parity fixtures through gen/prompts.py → work/parity/py-dump.json.
  parity_check.py   Byte-exact diff of py-dump vs ts-dump. Exit 0 = in sync.

work/               (gitignored) venv, base model, llama.cpp clone, adapters, fused
                    weights, GGUFs, datasets, eval results, bench results.
```

The TS side of the parity check lives at `maestro-open/scripts/dumpPrompts.ts`
(`npx vite-node scripts/dumpPrompts.ts` from maestro-open/). Run the trio after ANY change
to prompts.ts:

```bash
(cd ../maestro-open && npx vite-node scripts/dumpPrompts.ts)
work/venv/bin/python scripts/dump_prompts.py
work/venv/bin/python scripts/parity_check.py
```

## Environment (already set up in work/venv)

- Python 3.12 venv with **`mlx-lm==0.28.4` and `transformers<5`** — do NOT upgrade:
  mlx-lm 0.31.x requires transformers 5 and crashes with it on import.
- `brew install llama.cpp` (provides `llama-quantize`, `llama-gguf-split`) + a clone of
  llama.cpp in work/ (provides `convert_hf_to_gguf.py`).
- Base model: `work/models/Qwen3-1.7B` (HF safetensors).

## Training facts (what shipped)

- LoRA via `mlx_lm lora --mask-prompt` (loss on assistant tokens only), batch 2, lr 1e-4,
  600 iters, checkpoints every 50. ~5 min on the M5 Pro, peak 8.7 GB.
- Val loss overfits past ~iter 250–350 — round2.sh auto-fuses the **best-val-loss
  checkpoint**, never the final one.
- Quantization: **Q4_K_M** via llama-quantize. (For MLC the research said q4f16_1-never-ft;
  for GGUF, Q4_K_M is the standard pick.)
- Output staged as `maestro-open/public/models/qwen3-1.7b-maestro-q4_k_m-*-of-00003.gguf`
  (~1.05 GB total). **Sharding ≤400 MB is mandatory** — wllama's WASM aborts on a single
  1.2 GB file.

## Using / toggling the model in the app

- `backend` flag in `maestro-open/src/config/features.ts` — default is **`'wllama'`**
  (fine-tuned GGUF, CPU); `'webllm'` = stock Qwen3 on WebGPU.
- Model catalog + adapter: `maestro-open/src/llm/wllama.ts` (implements the same LLMEngine
  seam as webllm.ts; reuses the Qwen3 quirks).
- Multi-thread WASM needs the COOP/COEP headers set in vite.config.ts — production hosting
  must send the same two headers or inference silently drops to single-thread.
- Bench/smoke: open `http://localhost:5174/bench.html?run=1` — runs stock-GGUF vs
  tuned-GGUF vs WebLLM on real engine prompts; results land in
  `finetune/work/bench/bench-results.json`. One run per `?run=1` visit (the page strips
  the param so hot-reloads don't re-run). Don't run it while MLX is training.

## Headline results (round 2, held-out; full table in the execution doc)

- assess verdict 50%→58.3%, classify 90%→100%, completion rules 0%→100%,
  refine format 33%→100%, teach one-question 90.9%→100%; all JSON-format checks 100%.
- Known watch-items: rare low-temperature repetition loops on structured calls (the
  engine rails cap/salvage these) and one observed suggestions answer-leak.
- Browser: tuned model loads ~1.6 s, averages ~970 ms per engine call (CPU, 15 threads);
  WebLLM ~570 ms for comparison. RAM in-tab ≈ 1.6–1.8 GB.
