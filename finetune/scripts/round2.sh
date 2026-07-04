#!/bin/bash
# Round-2 retrain with the rebalanced assess data: train → pick BEST val-loss
# checkpoint → fuse → GGUF → shard → stage → eval base+tuned → compare.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=work/venv/bin/python

echo "== rebuild dataset =="
$PY gen/build_dataset.py

echo "== train =="
rm -rf work/adapters
$PY -m mlx_lm lora \
  --model work/models/Qwen3-1.7B --train --data work/dataset \
  --fine-tune-type lora --mask-prompt --batch-size 2 --iters 600 \
  --learning-rate 1e-4 --steps-per-eval 50 --save-every 50 \
  --adapter-path work/adapters 2>&1 | tee work/train2.log

echo "== pick best checkpoint by val loss =="
BEST=$($PY - <<'EOF'
import re
losses = re.findall(r"Iter (\d+): Val loss ([\d.]+)", open("work/train2.log").read())
best = min(losses, key=lambda t: float(t[1]))
print(best[0].zfill(7))
EOF
)
echo "best iter: $BEST"
mkdir -p work/adapters-best && rm -f work/adapters-best/*
cp "work/adapters/${BEST}_adapters.safetensors" work/adapters-best/adapters.safetensors
cp work/adapters/adapter_config.json work/adapters-best/

echo "== fuse + convert + shard + stage =="
rm -rf work/fused
$PY -m mlx_lm fuse --model work/models/Qwen3-1.7B --adapter-path work/adapters-best --save-path work/fused
$PY work/llama.cpp/convert_hf_to_gguf.py work/fused --outfile work/gguf/qwen3-1.7b-maestro-f16.gguf --outtype f16
llama-quantize work/gguf/qwen3-1.7b-maestro-f16.gguf work/gguf/qwen3-1.7b-maestro-q4_k_m.gguf Q4_K_M
rm -f ../maestro-open/public/models/qwen3-1.7b-maestro-q4_k_m-*.gguf
llama-gguf-split --split --split-max-size 400M \
  work/gguf/qwen3-1.7b-maestro-q4_k_m.gguf \
  ../maestro-open/public/models/qwen3-1.7b-maestro-q4_k_m

echo "== eval base + tuned on the fresh eval split =="
$PY scripts/eval_model.py --model work/models/Qwen3-1.7B --out work/eval/base.json
$PY scripts/eval_model.py --model work/fused --out work/eval/tuned.json
echo "== compare =="
$PY scripts/eval_compare.py
echo "ROUND2 DONE"
