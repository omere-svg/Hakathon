# Product Idea — Maestro Open

> The final product concept for the hackathon, the target user, why it can win against 7 other juniors, and the value it brings Masterschool.
> Grounded in: the [hackathon brief](../01-hackathon-brief), the [problem background](../01-hackathon-brief), the [10 TutorBench failure scenarios](../03-scenarios-and-evals), and the research in [05-research](../05-research).

---

## 1. Final product concept

**Maestro Open** — a free, installable web app (PWA) where anyone, on any device, can learn a real Maestro lesson with an AI tutor **that runs entirely on their own phone or laptop**. Zero cost to Masterschool per user, works offline, and — crucially — **teaches the way Maestro teaches**, not the way a raw small model would.

The product is built around one sharp insight:

> **A tiny on-device model is cheap but a bad teacher. The 10 scenarios Masterschool gave us are exactly where small (and even large) models slip — they validate wrong code, leak challenge answers, fumble arithmetic, dump answers instead of scaffolding, miss a distressed student, forget a student's name. So the product is not "a small model in a chat box," and not even "a chatbot with guardrails." It's a real AI tutor with a deterministic teaching engine underneath — a small on-device Intelligent Tutoring System — where the engine decides what to teach next and the LLM only understands the student and phrases the reply. At $0.**

Concretely, Maestro Open is three things stacked:
1. **A faithful Maestro lesson experience** — same structure (program → course → lesson → mastery goals → teach/ask/answer loop), same chat UI feel as the real product (see [the UI reference](../02-maestro-product-reference/maestro%20ui%20example.png)).
2. **An on-device LLM tutor wrapped in a deterministic verify-and-repair layer** — the model teaches and understands (engaging, handles any input); deterministic **tools** judge correctness, a **verifier** re-prompts the model when it breaks a pedagogical rule, and a **guard** structurally guarantees the name + no-answer-leak rules. Backed by a domain model (knowledge components, misconceptions, hint ladders) + a student model (mastery, affect, preferences). The 10 failure modes are prevented as a *consequence* of universal constraints (C1–C10), not handled case-by-case. **No template fallbacks — what you see is the model.** This is the moat. (See [architecture.md](architecture.md).)
3. **A live "Teaching Quality" dashboard** — runs the 10 scenarios (and TutorBench-style rubrics) against our tutor in-browser and shows **pass/fail per scenario**, proving the tutor teaches well. This turns "trust me, it's a good tutor" into a demonstrated, scored claim.

All three run on-device. No per-user server. No cloud LLM bill. (See [webllm-research.md](../05-research/webllm-research.md).)

## 2. Target user

**Primary:** A prospective Masterschool student — **low-income, motivated, studying on a mid/low-end phone, often on a weak or metered connection**, who can't be reached by a product that costs money per user. They want to *feel* what learning a CS or Business concept with Maestro is like, for free, without signing up or paying.

**Why this user is the right bet:** the problem background says Masterschool's growth depends on reaching *many more* such users cheaply, having them love the product, and converting a fraction into degree students (whom the government funds). The funnel only works if acquisition is **$0 marginal cost** — which is exactly the on-device constraint. So the target user and the technical constraint are the same coin.

**Secondary:** Existing Maestro students who want an **offline / low-data** way to review lessons, and Masterschool itself (the dashboard is a QA tool for tutor quality).

## 3. Why this can win

**Honest read on what the other 7 juniors will build:** almost everyone will ship "WebLLM in a chat box with a lesson loaded." It satisfies the literal brief (on-device, $0) and demos in a day. So *that* is table stakes, not a differentiator. The judges have explicitly said the bar is **teaching well on the 10 scenarios**, not just answering — and a bare small model **fails most of them**. Whoever only ships the chat box will visibly leak a challenge answer or validate wrong code on stage.

**My edge — win on the part everyone else will skip:**
1. **Pass the 10 scenarios on purpose.** The brief makes the 10 failure modes the real test. I treat them as the spec and engineer deterministic guardrails for each (challenge-mode lock, answer-verification before validation, calculator for math, scaffolding pacer, emotion/preference detectors, mode-shift signaling). My tutor *handles them*; theirs *trips on them*.
2. **Prove it with the eval dashboard.** I don't claim good teaching — I **show a green scoreboard** of 10/10 scenarios passing, live, on-device, using TutorBench-style rubrics. That's a memorable, defensible demo moment no one else will have.
3. **Actually reaches the real users.** Device-tiered model picker + WASM fallback + **Lite mode** + offline PWA (see [mobile-device-strategy.md](../05-research/mobile-device-strategy.md)) means it works on the cheap phones our students actually use — not just the presenter's MacBook. "At scale, on any device" is a brief goal most will quietly fail.
4. **End-to-end and polished.** The brief says "a simple product that fully works beats a pile of half-features." One complete, faithful, installable Maestro lesson with great teaching beats five rough features.

In short: everyone clears "$0 + on-device." **I win on teaching quality (proven), device reach, and product completeness** — the three things the brief actually rewards.

## 4. What value it brings Masterschool

- **A $0-marginal-cost top-of-funnel growth engine.** Anyone, anywhere, on any device can experience real Maestro teaching for free. Some convert to the funded degree → government revenue. The economics the problem statement describes only close at $0 COGS, and this delivers it.
- **Global, low-end reach.** Offline PWA + tiny models + Lite mode unlock exactly the markets Masterschool wants to expand into (more countries, low-income students on phones).
- **A reusable quality bar.** The teaching engine and the scenario/rubric eval harness are **directly applicable to the paid product** — they're a blueprint and a regression test for "does our tutor teach well," usable far beyond this hackathon.
- **Content that scales at $0.** The domain model (knowledge components, expected answers, misconception maps, hint ladders) is **authored offline by a big frontier model from existing Maestro lessons and frozen to static JSON** — the expensive intelligence is paid once at build time, never per user. This is how teaching quality scales to thousands of lessons and new countries while runtime stays on-device and free.
- **Brand-safe trust.** Deterministic guardrails + on-device privacy mean the free product won't embarrass a brand that grants government-recognized degrees (no leaked answers, no made-up math, student data never leaves the phone).
- **Strategic proof point:** demonstrates Masterschool can scale teaching quality **without scaling inference spend** — the core thesis behind "the biggest school in the world."

---

### One-liner for the pitch
**"Maestro Open: real Maestro teaching, on any phone, fully offline, at $0 per user — and we can prove it teaches well by passing all 10 of your own failure scenarios, live, on-device."**
