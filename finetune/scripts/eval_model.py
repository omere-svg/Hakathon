"""Per-call-type evaluation of a model (base or fine-tuned) on work/dataset/eval.jsonl.

Grades every held-out prompt with STRUCTURAL checks (format compliance) plus
VERDICT checks where the reference encodes a judgment (classify word, assess
achieved-bool, sync empty-vs-nonempty). Teach/completion get style checks.

Usage:
  work/venv/bin/python scripts/eval_model.py --model models/Qwen3-1.7B --out work/eval/base.json
  work/venv/bin/python scripts/eval_model.py --model work/fused --out work/eval/tuned.json
Compare:
  work/venv/bin/python scripts/eval_compare.py
"""

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler

ROOT = Path(__file__).resolve().parent.parent

# Mirrors the engine's per-scenario sampling: structured calls run cold, teaching warm.
STRUCTURED = {"classify", "expand", "refine", "coverage", "assess", "sync"}
MAX_TOKENS = {"classify": 8, "expand": 280, "refine": 200, "coverage": 120,
              "teach": 280, "suggestions": 120, "assess": 160, "sync": 220, "completion": 90}


def strip_think(text: str) -> str:
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<think>[\s\S]*$", "", text, flags=re.IGNORECASE)
    return re.sub(r"/(?:no_)?think\b", "", text, flags=re.IGNORECASE).strip()


def salvage_json(text: str):
    """Rough analogue of the engine's salvage parser: first {...} block."""
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def grade(row, output):
    t, ref = row["type"], row["reference"]
    out = strip_think(output)
    checks = {}
    if t == "classify":
        word = out.strip().upper()
        checks["format"] = word in ("ATOMIC", "SPLIT")
        checks["verdict"] = word == ref.strip().upper()
    elif t == "expand":
        obj = salvage_json(out)
        ok = obj is not None and (
            obj == {"atomic": True}
            or (obj.get("atomic") is False and 2 <= len(obj.get("subGoals", [])) <= 3
                and all(isinstance(s, dict) and s.get("title") and s.get("description")
                        for s in obj.get("subGoals", [])))
        )
        checks["format"] = ok
        checks["strict_json"] = out.startswith("{") and out.endswith("}")
    elif t == "assess":
        obj = salvage_json(out)
        checks["format"] = obj is not None and isinstance(obj.get("achieved"), bool) and bool(obj.get("evidence"))
        if checks["format"]:
            checks["verdict"] = obj["achieved"] == json.loads(ref)["achieved"]
    elif t == "sync":
        obj = salvage_json(out)
        checks["format"] = obj is not None and isinstance(obj.get("alsoAchieved"), list)
        if checks["format"]:
            ref_empty = len(json.loads(ref)["alsoAchieved"]) == 0
            checks["verdict"] = (len(obj["alsoAchieved"]) == 0) == ref_empty
    elif t in ("refine", "coverage"):
        lines = [l for l in out.splitlines() if l.strip()]
        checks["format"] = bool(lines) and all(
            not re.match(r"\s*(?:[-*•]|\d+[.)])", l) for l in lines
        )
        if t == "refine":
            checks["length"] = len(lines) <= 5
    elif t == "suggestions":
        lines = [l for l in out.splitlines() if l.strip()]
        checks["format"] = len(lines) == 4
        checks["short"] = all(len(l.split()) <= 14 for l in lines)
    elif t == "teach":
        sentences = re.split(r"(?<=[.!?])\s+", out)
        checks["ends_question"] = out.rstrip().endswith("?")
        checks["one_question"] = out.count("?") <= 2  # allow a rhetorical + the ask
        checks["length"] = 1 <= len(sentences) <= 6
        checks["no_markdown"] = not re.search(r"^#|\*\*|```", out, flags=re.MULTILINE)
        checks["no_label"] = not re.match(r"\s*(?:Tutor|Student)\s*:", out)
    elif t == "completion":
        checks["no_question"] = "?" not in out
        checks["short"] = len(re.split(r"(?<=[.!?])\s+", out)) <= 3
    return checks, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--adapter-path", default=None)
    args = ap.parse_args()

    model, tokenizer = load(args.model, adapter_path=args.adapter_path)
    rows = [json.loads(l) for l in (ROOT / "work" / "dataset" / "eval.jsonl").read_text().splitlines()]

    results, agg = [], defaultdict(lambda: defaultdict(lambda: [0, 0]))
    for i, row in enumerate(rows):
        temp = 0.3 if row["type"] in STRUCTURED else 0.7
        top_p = 0.8
        prompt = tokenizer.apply_chat_template(
            [{"role": "system", "content": row["system"]}, {"role": "user", "content": row["user"]}],
            add_generation_prompt=True,
        )
        output = generate(
            model, tokenizer, prompt=prompt,
            max_tokens=MAX_TOKENS.get(row["type"], 280),
            sampler=make_sampler(temp=temp, top_p=top_p),
        )
        checks, cleaned = grade(row, output)
        for name, ok in checks.items():
            agg[row["type"]][name][1] += 1
            agg[row["type"]][name][0] += int(ok)
        results.append({"type": row["type"], "checks": checks, "output": cleaned, "reference": row["reference"]})
        if (i + 1) % 10 == 0:
            print(f"{i + 1}/{len(rows)}")

    summary = {
        t: {name: f"{ok}/{n}" for name, (ok, n) in per.items()} for t, per in sorted(agg.items())
    }
    out_path = ROOT / args.out if not args.out.startswith("/") else Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"model": args.model, "summary": summary, "results": results}, indent=2, ensure_ascii=False))
    print(json.dumps(summary, indent=2))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
