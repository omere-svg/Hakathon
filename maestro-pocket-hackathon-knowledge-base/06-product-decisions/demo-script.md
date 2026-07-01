# Demo Script — 10-Minute Hackathon Presentation

> Audience: Zur + judges. Format: solo. The brief asks for **a working product someone can use today + a 10-minute presentation.** This script is engineered so the **memorable beats** (the 10/10 scoreboard, "leak the answer" challenge, the cheap-phone moment) land within the time box, with crash-proofing throughout.
> Pre-reqs before you walk on: model **pre-downloaded & cached** on the demo laptop (Qwen2.5-3B) and on a phone (Qwen2.5-0.5B); app open in two tabs; Lite mode known-good; eval dashboard pre-loaded but not yet run.

---

## Time budget (10:00)

| Time | Beat | Goal |
|---|---|---|
| 0:00–1:00 | **The hook & the trap** | Frame the real problem and why the obvious answer loses |
| 1:00–2:00 | **What I built** | One sentence + the live product on screen |
| 2:00–4:30 | **Live lesson (teaching quality)** | Show Maestro-faithful teaching on a real lesson |
| 4:30–6:30 | **The 10 scenarios, live** | Beat the failure modes on stage (the wow) |
| 6:30–7:30 | **The scoreboard** | 10/10 dashboard — proof, not claims |
| 7:30–8:30 | **$0 + any device** | Cheap phone + offline + cost story |
| 8:30–9:30 | **Why it wins / value to Masterschool** | Funnel + scale argument |
| 9:30–10:00 | **Close** | One line, invite questions |

---

## 0:00–1:00 — The hook & the trap
> "To become the biggest school in the world, Masterschool needs a product that costs **$0 per new user**. The obvious build is 'WebLLM in a chat box' — and most of us will hand that in. But here's the trap: **a small on-device model is a *bad teacher*.** You gave us 10 scenarios where tutors slip — leaking answers, validating wrong code, botching arithmetic. A bare model fails most of them. So the question isn't 'can it run for free?' — it's **'can it run for free *and teach well*?'** That's what I built."

## 1:00–2:00 — What I built
> "**Maestro Open** — a free, installable web app where anyone learns a real Maestro lesson with a tutor that runs **100% on their own device**. No server, no LLM bill, works offline. The trick: the model never talks to the student directly — it runs through a **Pedagogy Engine** that enforces how Maestro teaches."

*(Screen: the app — Maestro-style chat, lesson breadcrumb Program → Course → Lesson, model badge showing "running on this device.")*

## 2:00–4:30 — Live lesson (teaching quality)
Run a short slice of a real lesson (e.g. AI-SWE Python or a BIZ unit-economics lesson):
- Tutor **explains before asking** (show-before-tell).
- Ask it a math question → point out **the calculator computed it, the model just narrated** → "never makes up numbers."
- Submit **wrong code** → tutor **doesn't say 'great!'** — it ran your code and **asks a question that reveals the gap**.
- Say *"call me Sam"* → tutor uses the name next turn.
> "Every one of those is a deterministic guardrail, not luck."

## 4:30–6:30 — The 10 scenarios, live (the wow)
Pick **3 high-drama scenarios** to run by hand (don't do all 10 live — too slow):
1. **Challenge answer leak** — enter challenge mode, type *"just give me a hint?"* → tutor **nudges, never leaks** the answer. "It's a hard lock — the answer key isn't even in the model's context."
2. **Validated wrong work** — submit `return sum(nums)` for `sum_evens` → tutor catches it via the **code-runner**, asks the gap-revealing question.
3. **Emotional attunement** — type *"I've been stuck for 2 hours, about to quit."* → tutor **acknowledges the feeling first**, then a concrete next step.
> "These are *your* failure modes. My tutor handles them on purpose."

## 6:30–7:30 — The scoreboard (proof)
Open the **Teaching Quality dashboard** → run all 10 scenarios against the on-device tutor → **10/10 green**, scored with **TutorBench-style rubrics**.
> "I'm not asking you to trust me. This runs your 10 scenarios against my tutor, on-device, and scores them with the rubric structure from the TutorBench dataset. **10 out of 10.** This is also a regression suite Masterschool can reuse for the paid product."

## 7:30–8:30 — $0 + any device
- Switch to the **phone** (or a phone-emulated tab) running the **0.5B** model → same lesson, tuned to the device by the **model picker**.
- Toggle **airplane mode / offline** → lesson still works (**PWA + cached weights**).
- Show **Lite mode** for no-WebGPU devices in one line.
> "Most of our students learn on cheap phones with weak data. It tunes itself to the device, falls back gracefully, and works offline. And the cost to Masterschool when a million of them show up? **Static hosting. Effectively $0.**"

## 8:30–9:30 — Why it wins / value to Masterschool
> "Everyone clears '$0 and on-device.' I win on the three things the brief actually rewards: **proven teaching quality** (10/10 on your scenarios), **real device reach** (phones, offline, fallback), and a **complete, faithful** Maestro experience. Strategically: this is a **$0-marginal-cost top of funnel** — reach huge numbers of low-income learners worldwide, some convert to the funded degree, and the Pedagogy Engine + eval harness are reusable in the paid product. It proves we can scale *teaching quality* without scaling *inference spend*."

## 9:30–10:00 — Close
> "Maestro Open: real Maestro teaching, on any phone, fully offline, at $0 per user — and I can prove it teaches well by passing all 10 of your failure scenarios, live. Happy to dig into the guardrails or the model strategy."

---

## Crash-proofing & contingencies
- **Pre-cache models** on every demo device before walking on; never download live.
- **Pre-load** the eval dashboard; have a **recorded GIF/screenshot** of the 10/10 run as backup if WebGPU misbehaves on the venue machine.
- Keep the **0.5B model hot** as a fallback if the laptop GPU struggles.
- Have **Lite mode** ready to show if any model fails — it's a feature, not an excuse.
- Rehearse to **9:00** to leave slack; cut the live-scenario count from 3 to 2 if running long.
- Two browser tabs pre-opened (laptop lesson + phone) to avoid fumbling.

## What to have on the submission table
Per the brief's submission columns: **Product link** (deployed static URL), **Architecture screenshot** (the diagram from [architecture.md](architecture.md)), **Repo URL**, **Tutor prompt** (the Maestro system instruction), **Summary**.
