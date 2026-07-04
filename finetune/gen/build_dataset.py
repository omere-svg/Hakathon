"""Assemble the fine-tuning dataset from scenario specs + teacher outputs.

Input:  data/scenarios/*.json — arrays of specs:
          { "type": "<call type>", "input": {...builder args...},
            "output": "<ideal assistant reply>", "tags": ["subject:python", ...] }
        The (system, user) pair is RENDERED AT BUILD TIME via gen/prompts.py, so a
        prompt-wording change in the engine only requires re-syncing prompts.py and
        re-running this script — the specs and teacher outputs survive.

Output: work/dataset/train.jsonl + valid.jsonl in mlx_lm chat format:
          {"messages": [{"role":"system",...},{"role":"user",...},{"role":"assistant",...}]}
        The runtime ` /no_think` suffix is baked into the system message — training
        inputs must match what webllm.ts/wllama.ts actually send.

Usage:  work/venv/bin/python gen/build_dataset.py [--valid-frac 0.08] [--seed 7]
"""

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from gen import prompts as P  # noqa: E402


def render(spec):
    t, i = spec["type"], spec["input"]
    if t == "classify":
        return P.classify_prompt(i["lessonTitle"], i["goal"], i["depth"], i["maxDepth"])
    if t == "expand":
        return P.expand_prompt(i["goal"])
    if t == "refine":
        return P.refine_prompt(i["goals"], i["draftSteps"])
    if t == "coverage":
        return P.coverage_prompt(i["statement"])
    if t == "teach":
        return P.teach_prompt(
            i["milestone"],
            i["justAdvanced"],
            bridge=i.get("bridge"),
            attempts=i.get("attempts", 0),
            rails=i.get("rails"),
        )
    if t == "suggestions":
        return P.suggestions_prompt(i["tutorReply"], i["milestoneTitle"])
    if t == "assess":
        return P.assess_prompt(i["milestone"])
    if t == "sync":
        return P.sync_prompt(i["completed"], i["remaining"])
    if t == "completion":
        return P.completion_prompt(i["title"], i.get("progress"))
    raise ValueError(f"unknown spec type: {t}")


# Notes some teach specs append to the USER prompt (regeneration rails). Applied after
# render() because the engine appends them to the built prompt the same way.
def apply_user_notes(spec, user):
    for note in spec.get("userNotes", []):
        if note == "NO_PRAISE":
            user += P.NO_PRAISE_NOTE
        elif note == "REPETITION":
            user += P.REPETITION_NOTE
        elif note == "EXPLAIN_FIRST":
            user += P.EXPLAIN_FIRST_NOTE
        elif note == "VACUOUS_QUESTION":
            user += P.VACUOUS_QUESTION_NOTE
        elif note == "FALSE_INFINITE":
            user += P.FALSE_INFINITE_NOTE
        elif note == "SECOND_PERSON":
            user += P.SECOND_PERSON_NOTE
        elif note.startswith("SYNTAX:"):
            user += P.syntax_note(note.split(":", 1)[1])
        elif note.startswith("OFF_TOPIC:"):
            user += P.off_topic_note(note.split(":", 1)[1])
        else:
            raise ValueError(f"unknown userNote: {note}")
    return user


def validate(spec):
    """Cheap structural checks on the teacher output — catches format drift early."""
    t, out = spec["type"], spec["output"].strip()
    if t == "classify":
        assert out in ("ATOMIC", "SPLIT"), f"classify output must be one word: {out!r}"
    elif t in ("expand", "assess", "sync"):
        obj = json.loads(out)  # must be pure JSON
        if t == "expand":
            assert obj == {"atomic": True} or (
                obj.get("atomic") is False and 2 <= len(obj.get("subGoals", [])) <= 3
            ), f"expand output invalid: {out[:80]}"
        if t == "assess":
            assert set(obj) == {"achieved", "evidence"} and isinstance(obj["achieved"], bool)
        if t == "sync":
            assert set(obj) == {"alsoAchieved"} and isinstance(obj["alsoAchieved"], list)
    elif t == "suggestions":
        lines = [l for l in out.splitlines() if l.strip()]
        assert len(lines) == 4, f"suggestions must be exactly 4 lines, got {len(lines)}"
    elif t in ("refine", "coverage"):
        lines = [l for l in out.splitlines() if l.strip()]
        assert lines and all(not l.lstrip().startswith(("-", "*", "1.", "2.")) for l in lines), (
            f"{t} output must be bare lines: {out[:80]}"
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--valid-frac", type=float, default=0.08)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    specs = []
    scen_dir = ROOT / "data" / "scenarios"
    for f in sorted(scen_dir.glob("*.json")):
        batch = json.loads(f.read_text())
        assert isinstance(batch, list), f"{f} must be a JSON array"
        specs.extend(batch)

    # Dedup on (type, user-prompt, output) — different agents may produce near-identical specs.
    seen, unique = set(), []
    examples = []
    for spec in specs:
        validate(spec)
        system, user = render(spec)
        user = apply_user_notes(spec, user)
        key = (spec["type"], user, spec["output"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(spec)
        examples.append(
            {
                "messages": [
                    {"role": "system", "content": P.sys(system)},
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": spec["output"]},
                ],
                "_type": spec["type"],
            }
        )

    rng = random.Random(args.seed)
    rng.shuffle(examples)
    n_valid = max(1, int(len(examples) * args.valid_frac))
    valid, train = examples[:n_valid], examples[n_valid:]

    out_dir = ROOT / "work" / "dataset"
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, rows in (("train", train), ("valid", valid)):
        with open(out_dir / f"{name}.jsonl", "w") as fh:
            for r in rows:
                fh.write(json.dumps({"messages": r["messages"]}, ensure_ascii=False) + "\n")

    # Eval companion for the valid split: keeps the call type + reference output so
    # scripts/eval_model.py can grade base vs tuned per call type.
    with open(out_dir / "eval.jsonl", "w") as fh:
        for r in valid:
            m = r["messages"]
            fh.write(
                json.dumps(
                    {
                        "type": r["_type"],
                        "system": m[0]["content"],
                        "user": m[1]["content"],
                        "reference": m[2]["content"],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    print(f"specs: {len(specs)} → unique: {len(unique)} (dropped {len(specs) - len(unique)} dups)")
    print(f"train: {len(train)}  valid: {len(valid)}")
    print("by type:", dict(Counter(e['_type'] for e in examples)))


if __name__ == "__main__":
    main()
