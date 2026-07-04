#!/bin/bash
# LoRA-SFT of Qwen3-1.7B on the assembled dataset, then fuse + convert to GGUF.
# Run from finetune/:  bash scripts/train.sh
# Stages can be skipped: SKIP_TRAIN=1 bash scripts/train.sh  (re-fuse/convert only)
set -euo pipefail
cd "$(dirname "$0")/.."

PY=work/venv/bin/python
MODEL=work/models/Qwen3-1.7B
[ -d "$MODEL" ] || MODEL=work/models/Qwen3-1.7B  # single canonical location
ADAPTERS=work/adapters
FUSED=work/fused
ITERS="${ITERS:-600}"
LR="${LR:-1e-4}"
BATCH="${BATCH:-2}"

echo "== 1. build dataset =="
$PY gen/build_dataset.py

if [ "${SKIP_TRAIN:-0}" != "1" ]; then
  echo "== 2. LoRA train (iters=$ITERS lr=$LR batch=$BATCH) =="
  # --mask-prompt: loss on assistant tokens only — we teach outputs, not prompts.
  $PY -m mlx_lm lora \
    --model "$MODEL" \
    --train \
    --data work/dataset \
    --fine-tune-type lora \
    --mask-prompt \
    --batch-size "$BATCH" \
    --iters "$ITERS" \
    --learning-rate "$LR" \
    --steps-per-eval 50 \
    --save-every 50 \
    --adapter-path "$ADAPTERS" \
    2>&1 | tee work/train.log
fi

echo "== 3. fuse adapter into base weights =="
rm -rf "$FUSED"
$PY -m mlx_lm fuse --model "$MODEL" --adapter-path "$ADAPTERS" --save-path "$FUSED"

echo "== 4. convert fused -> GGUF f16 -> Q4_K_M =="
$PY work/llama.cpp/convert_hf_to_gguf.py "$FUSED" --outfile work/gguf/qwen3-1.7b-maestro-f16.gguf --outtype f16
llama-quantize work/gguf/qwen3-1.7b-maestro-f16.gguf work/gguf/qwen3-1.7b-maestro-q4_k_m.gguf Q4_K_M

echo "== 5. stage into the app (sharded ≤400MB — single 1.2GB files abort wllama's WASM) =="
rm -f ../maestro-open/public/models/qwen3-1.7b-maestro-q4_k_m-*.gguf
llama-gguf-split --split --split-max-size 400M \
  work/gguf/qwen3-1.7b-maestro-q4_k_m.gguf \
  ../maestro-open/public/models/qwen3-1.7b-maestro-q4_k_m
ls -lh ../maestro-open/public/models/

echo "DONE. Next: scripts/eval_model.py (base vs tuned), then the in-browser smoke test."
