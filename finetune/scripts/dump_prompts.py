"""Render the shared parity fixtures through the Python port (gen/prompts.py) and
write finetune/work/parity/py-dump.json. Counterpart of maestro-open/scripts/dumpPrompts.ts.
Run from finetune/:  work/venv/bin/python scripts/dump_prompts.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from gen import prompts as P  # noqa: E402

fixtures = json.loads((ROOT / "data" / "parity-fixtures.json").read_text())


def pair(system, user):
    return {"system": P.sys(system), "user": user}


out = {
    "classify": [
        pair(*P.classify_prompt(f["lessonTitle"], f["goal"], f["depth"], f["maxDepth"]))
        for f in fixtures["classify"]
    ],
    "expand": [pair(*P.expand_prompt(f["goal"])) for f in fixtures["expand"]],
    "refine": [pair(*P.refine_prompt(f["goals"], f["draftSteps"])) for f in fixtures["refine"]],
    "coverage": [pair(*P.coverage_prompt(f["statement"])) for f in fixtures["coverage"]],
    "teach": [
        pair(
            *P.teach_prompt(
                f["milestone"],
                f["justAdvanced"],
                bridge=f.get("bridge"),
                attempts=f.get("attempts", 0),
                rails=f.get("rails"),
            )
        )
        for f in fixtures["teach"]
    ],
    "suggestions": [
        pair(*P.suggestions_prompt(f["tutorReply"], f["milestoneTitle"]))
        for f in fixtures["suggestions"]
    ],
    "assess": [pair(*P.assess_prompt(f["milestone"])) for f in fixtures["assess"]],
    "sync": [pair(*P.sync_prompt(f["completed"], f["remaining"])) for f in fixtures["sync"]],
    "completion": [pair(*P.completion_prompt(f["title"])) for f in fixtures["completion"]],
}

out_dir = ROOT / "work" / "parity"
out_dir.mkdir(parents=True, exist_ok=True)
(out_dir / "py-dump.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
print(f"wrote {out_dir / 'py-dump.json'}")
