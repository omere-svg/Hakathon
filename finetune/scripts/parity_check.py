"""Byte-exact diff of the TS and Python prompt dumps. Exit 0 = in sync.
Run AFTER both dumpers:
  (cd ../maestro-open && npx vite-node scripts/dumpPrompts.ts)
  work/venv/bin/python scripts/dump_prompts.py
  work/venv/bin/python scripts/parity_check.py
"""

import difflib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ts = json.loads((ROOT / "work" / "parity" / "ts-dump.json").read_text())
py = json.loads((ROOT / "work" / "parity" / "py-dump.json").read_text())

failures = 0
for key in sorted(set(ts) | set(py)):
    a, b = ts.get(key, []), py.get(key, [])
    if len(a) != len(b):
        print(f"✗ {key}: {len(a)} TS cases vs {len(b)} PY cases")
        failures += 1
        continue
    for i, (ta, pb) in enumerate(zip(a, b)):
        for field in ("system", "user"):
            if ta[field] != pb[field]:
                failures += 1
                print(f"✗ {key}[{i}].{field} differs:")
                diff = difflib.unified_diff(
                    ta[field].splitlines(keepends=True),
                    pb[field].splitlines(keepends=True),
                    fromfile=f"ts/{key}[{i}].{field}",
                    tofile=f"py/{key}[{i}].{field}",
                )
                sys.stdout.writelines(list(diff)[:40])
                print()

if failures:
    print(f"\nPARITY FAILED: {failures} mismatch(es). Re-sync gen/prompts.py with prompts.ts.")
    sys.exit(1)
print("PARITY OK — Python port matches prompts.ts byte-for-byte on all fixtures.")
