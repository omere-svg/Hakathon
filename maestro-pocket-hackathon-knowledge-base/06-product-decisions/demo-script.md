# Demo Script — 10-Minute Hackathon Presentation

> Audience: Zur + judges. Solo. The brief asks for **a working product someone can use today + a 10-minute presentation.** Built around the **current Milestone Engine** ([architecture.md](architecture.md)); memorable beats land within the box, crash-proofed throughout.
> Pre-reqs: model **pre-downloaded & cached** on the demo laptop (Qwen3-4B or 1.7B) and on a phone (Qwen3-0.6B); app open in two tabs; "Show engine" panel ready.
>
> ⚠️ **Honesty note:** the old "10/10 eval scoreboard" and "deterministic guardrail" beats describe the removed verify engine — they are **not in the current product** (see [product-idea.md](product-idea.md) §5). This script pitches the milestone engine's *real* strengths. If you want the scenario-proof beat back, reinstate a light eval first (roadmap "Later").

---

## Time budget (10:00)

| Time | Beat | Goal |
|---|---|---|
| 0:00–1:00 | **The hook & the trap** | Frame the real problem and why the obvious build loses |
| 1:00–2:00 | **What I built** | One sentence + the live product on screen |
| 2:00–3:30 | **The wow: live decomposition** | Model breaks a lesson goal into a plan, on-device |
| 3:30–5:30 | **Live lesson (teaching loop)** | Milestone-by-milestone teaching + self-assessment + advance |
| 5:30–6:30 | **Content-free generalisation** | Pull up a *random* lesson — it just teaches it |
| 6:30–8:00 | **$0 + any device** | Cheap phone + offline + device auto-tuning + cost story |
| 8:00–9:30 | **Why it wins / value to Masterschool** | Funnel + scale argument |
| 9:30–10:00 | **Close** | One line, invite questions |

---

## 0:00–1:00 — The hook & the trap
> "To become the biggest school in the world, Masterschool needs a product that costs **$0 per new user**. The obvious build is 'WebLLM in a chat box' — and most of us will hand that in. But a small on-device model is a **weak reasoner**: ask it to teach a whole lesson and it wanders. So the question isn't 'can it run for free?' — it's **'can a phone-sized model actually *teach* — for free?'** That's what I built."

## 1:00–2:00 — What I built
> "**Maestro Open** — a free, installable web app where anyone learns a real Maestro lesson with a tutor running **100% on their own device**. No server, no LLM bill, works offline. The trick: instead of asking the small model to reason about everything at once, it **breaks the lesson's goals into a plan of tiny milestones and teaches them one at a time**, judging when you've got each one."

*(Screen: the app — Maestro-style chat, breadcrumb Program → Course → Lesson, model badge "running on this device.")*

## 2:00–3:30 — The wow: live decomposition
Turn on **"Show engine."** Start a lesson and narrate the dev panel:
- **Mastery Goals** (the lesson's real outcomes) go in.
- **Goal decomposition** appears — the model splits a goal into an ordered list of micro-milestones, live, on-device.
- **LLM calls** panel shows each real call (prompt + response + latency) — proof it's a model reasoning locally, not a script.
> "That plan wasn't authored by me — the model built it just now, on this laptop, for free. Watch it teach the plan."

## 3:30–5:30 — Live lesson (the teaching loop)
Work through the first couple of milestones as a student:
- Tutor teaches **one milestone**, ends with a question.
- Answer → panel shows the **assess** step judging the milestone, then it **advances** to the next (with a natural bridge). Get one wrong / say "I'm confused" → it keeps teaching that milestone instead of moving on.
- Point at the panel: **"one micro-goal at a time, its own tiny context — that's how a 1.7B stays coherent."**

## 5:30–6:30 — Content-free generalisation
Reload → a **different random lesson** from the same Maestro course loads and the engine teaches it with **zero authoring**.
> "No per-lesson content pipeline. Give it any lesson's Mastery Goals and it teaches them. That's how this scales to thousands of lessons and new fields — at $0."

## 6:30–8:00 — $0 + any device
- Switch to the **phone** (or phone-emulated tab) running **Qwen3-0.6B** → same lesson, sized to the device by the **model picker** (it reads the device and picks the largest model that fits; if it OOMs, it steps down automatically).
- Toggle **offline** → lesson still works (**PWA + cached weights**).
> "Most of our students learn on cheap phones with weak data. It tunes itself to the device, recovers from out-of-memory, and works offline. Cost to Masterschool when a million show up? **Static hosting — effectively $0.**"

## 8:00–9:30 — Why it wins / value to Masterschool
> "Everyone clears '$0 and on-device.' I win on three things: a real **teaching loop** (not a chat box) that you can *see* reasoning on-device; **content-free generalisation** (any lesson, no authoring); and **real device reach** (phones, offline, auto-tuned). Strategically it's a **$0-marginal-cost top of funnel** — reach huge numbers of low-income learners worldwide, some convert to the funded degree — proving we can scale *teaching* without scaling *inference spend*."

## 9:30–10:00 — Close
> "Maestro Open: real Maestro teaching, on any phone, fully offline, at $0 per user — the model plans and teaches any lesson, live, on your own device. Happy to dig into the engine or the model strategy."

---

## Crash-proofing & contingencies
- **Pre-cache models** on every demo device before walking on; never download live.
- Keep **Qwen3-0.6B hot** as a fallback if the laptop GPU struggles; the OOM step-down also covers this.
- Have a **recorded GIF/screenshot** of a good decomposition + teaching run as backup if WebGPU misbehaves on the venue machine.
- Rehearse to **9:00** for slack; trim the live-lesson beat if running long.
- Two tabs pre-opened (laptop lesson + phone).

## Submission table (per the brief)
**Product link** (deployed static URL), **Architecture screenshot** (the diagram in [architecture.md](architecture.md)), **Repo URL**, **Tutor prompt** (the milestone engine's persona + teach prompt from `engine/milestone/prompts.ts`), **Summary**.
