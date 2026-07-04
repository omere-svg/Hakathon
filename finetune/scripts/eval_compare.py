"""Side-by-side of work/eval/base.json vs work/eval/tuned.json per call type."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
base = json.loads((ROOT / "work" / "eval" / "base.json").read_text())
tuned = json.loads((ROOT / "work" / "eval" / "tuned.json").read_text())


def pct(frac):
    ok, n = frac.split("/")
    return f"{100 * int(ok) / int(n):5.1f}%" if int(n) else "  n/a"


types = sorted(set(base["summary"]) | set(tuned["summary"]))
print(f"{'type':12} {'check':14} {'base':>8} {'tuned':>8}")
regressions = 0
for t in types:
    checks = sorted(set(base["summary"].get(t, {})) | set(tuned["summary"].get(t, {})))
    for c in checks:
        b = base["summary"].get(t, {}).get(c, "0/0")
        u = tuned["summary"].get(t, {}).get(c, "0/0")
        b_ok, b_n = map(int, b.split("/"))
        u_ok, u_n = map(int, u.split("/"))
        flag = ""
        if b_n and u_n and (u_ok / u_n) < (b_ok / b_n):
            flag = "  ⚠ REGRESSION"
            regressions += 1
        print(f"{t:12} {c:14} {pct(b):>8} {pct(u):>8}{flag}")
print(f"\n{regressions} regression(s).")
