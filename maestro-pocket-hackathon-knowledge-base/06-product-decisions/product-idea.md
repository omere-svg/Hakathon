# Product Idea — Maestro Open

> The product concept, the target user, why it can win, and the value to Masterschool.
> Grounded in the [hackathon brief](../01-hackathon-brief), the [problem background](../01-hackathon-brief), the [10 TutorBench scenarios](../03-scenarios-and-evals), and [05-research](../05-research).
>
> **Reflects the current build:** the model-driven **Milestone Engine** (see [architecture.md](architecture.md)). An earlier verify-and-repair engine with a live "10/10" eval dashboard was removed — see *§5 Honest status* for what that means for the pitch.

---

## 1. Final product concept

**Maestro Open** — a free, installable web app (PWA) where anyone, on any device, can learn a real Maestro lesson with an AI tutor **that runs entirely on their own phone or laptop**. Zero cost to Masterschool per user, works offline after first load, and structured like Maestro (program → course → lesson → mastery goals → teach/ask/advance).

The sharp insight:

> **A tiny on-device model is cheap but a weak reasoner. So don't ask it to reason about a whole lesson at once — give it one micro-goal at a time.** The model takes a lesson's Mastery Goals, **decomposes them into an ordered plan of small milestones**, teaches each in an isolated tiny context, and **self-assesses** when to advance. No content authoring, no server, $0 — and it generalises to *any* lesson immediately because it's content-free.

Concretely, three things stacked:
1. **A faithful Maestro lesson experience** — same structure and chat feel as the real product ([UI reference](../02-maestro-product-reference/maestro%20ui%20example.png)); lessons come straight from the Maestro course reference.
2. **The Milestone Engine** — the model decomposes each goal (bounded recursive split), teaches milestone-by-milestone with strict per-milestone context isolation, assesses achievement, cross-checks the rest, and advances. Kept honest on a small model by cheap deterministic *rails* (bounded recursion, tiny context, free-text-JSON salvage, `/no_think`) rather than a heavy guardrail layer. (See [architecture.md](architecture.md).)
3. **A transparency panel** — a "Show engine" dev view exposes the live goal→milestone decomposition, the current milestone, and every on-device LLM call (prompt + response + latency). Proof that it's a real model reasoning on-device, not a script.

All of it runs on-device (WebLLM/WebGPU). No per-user server, no cloud LLM bill. (See [webllm-research.md](../05-research/webllm-research.md).)

## 2. Target user

**Primary:** a prospective Masterschool student — **low-income, motivated, on a mid/low-end phone, weak or metered connection** — who can't be reached by a product that costs money per user. They want to *feel* what learning a CS or Business concept with Maestro is like, for free, no signup.

**Why this user is the right bet:** Masterschool's growth depends on reaching many such users cheaply, having them love the product, and converting a fraction into (government-funded) degree students. The funnel only closes at **$0 marginal cost** — which is exactly the on-device constraint. Target user and technical constraint are the same coin.

**Secondary:** existing students wanting an offline/low-data review mode.

## 3. Why this can win

**Honest read on the other 7 juniors:** most will ship "WebLLM in a chat box with a lesson." That satisfies the literal brief (on-device, $0) and is therefore table stakes, not a differentiator.

**My edge:**
1. **A real teaching *loop*, not a chat box.** The engine decomposes a goal into an ordered plan and teaches it step by step, adapting per milestone — visibly more like a tutor than a Q&A bot. The "Show engine" panel makes that legible on stage.
2. **Content-free generalisation.** Because the model decomposes Mastery Goals live, it works on *any* Maestro lesson with zero authoring — I can pull up a random lesson and it just teaches it. That's a scale story competitors with hand-authored content can't match.
3. **Actually reaches the real users.** Device-tiered model picker (Qwen3 0.6B/1.7B/4B) with a load-time OOM step-down + offline PWA means it runs on the cheap phones our students use, not just the presenter's MacBook. (See [mobile-device-strategy.md](../05-research/mobile-device-strategy.md).)
4. **End-to-end and honest.** One complete, faithful, installable lesson that works — and where a device can't run it, an honest "unsupported" screen, never faked teaching.

## 4. Value to Masterschool

- **A $0-marginal-cost top-of-funnel.** Anyone, anywhere, any device experiences real Maestro teaching for free; some convert to the funded degree. The economics only close at $0 COGS, and this delivers it.
- **Global, low-end reach.** Offline PWA + device-adaptive tiny models unlock the markets Masterschool wants (more countries, phone-first low-income learners).
- **Content that scales at $0.** No per-lesson authoring pipeline to run — the engine teaches from Mastery Goals directly, so it extends to thousands of lessons and new fields without inference spend.
- **Strategic proof point:** teaching quality that scales **without** scaling inference cost — the thesis behind "the biggest school in the world."

## 5. Honest status (read before pitching)

The current build is the model-driven Milestone Engine. An earlier design wrapped the model in a **deterministic verify-and-repair engine** (constraints C1–C10, tool-graded correctness, an answer-key lock, and a **live `/evals` dashboard that scored the tutor 10/10 on the TutorBench scenarios**). That engine — and its "provable teaching quality" demo beat — **was removed** when the project pivoted to the milestone flow.

Implication for the pitch: the strongest old claim ("I can *prove* it teaches well — 10/10 on your own scenarios, live") **is not currently in the product.** The milestone engine also has **no rail yet** for several TutorBench failure modes (answer-leak, validating wrong work, impasse loops — see [milestone-engine-weak-spots.md](../05-research/milestone-engine-weak-spots.md)). Two honest options:
- **Pitch the milestone engine on its real strengths** (content-free generalisation, live decomposition, device reach) and present scenario-hardening as the roadmap; or
- **Reinstate a lightweight eval + a few targeted rails** before the demo so the "passes your scenarios" beat is true again.

This is a strategic decision, not a wording tweak — decide it deliberately.

---

### One-liner (strengths-honest version)
**"Maestro Open: real Maestro teaching on any phone, fully offline, at $0 per user — the model breaks any lesson into a plan and teaches it step by step, live, on your own device."**
