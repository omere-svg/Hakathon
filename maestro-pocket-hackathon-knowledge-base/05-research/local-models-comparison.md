# Local Models Comparison

> Which on-device model should the Maestro Open tutor run? Constraint: must run **in the browser via WebLLM/WebGPU** (see [webllm-research.md](webllm-research.md)), on devices ranging from **cheap Android phones to laptops**. The teaching quality bar is set by the **10 TutorBench failure scenarios** ([../03-scenarios-and-evals](../03-scenarios-and-evals)).

---

## 1. The realistic candidate set

We can only use models that exist as **WebLLM prebuilt artifacts** (or that we compile ourselves with MLC — out of scope for a hackathon). Sizes below are the **WebGPU VRAM required** for the `q4f16_1` (4-bit) build, which is what we'd actually ship. "Footprint" = roughly the download size.

| Model | Params | `q4f16_1` VRAM (approx) | Context | Teaching quality (small-model lens) | Best fit |
|---|---|---|---|---|---|
| **SmolLM2-360M-Instruct** | 0.36B | ~0.4 GB | 4k | Weak. OK for canned/scaffolded flows, unreliable free reasoning. | Absolute floor / no-WebGPU WASM fallback |
| **Qwen2.5-0.5B-Instruct** | 0.5B | ~0.95 GB | 4k+ | Surprisingly decent instruction-following for size; still error-prone on math/logic. | Low-end Android safe default |
| **Llama-3.2-1B-Instruct** | 1B | ~0.9–1.1 GB | 4k+ | Good instruction-following, friendly tone; weak multi-step reasoning. | Mid phones; good tone for empathy scenarios |
| **Qwen2.5-1.5B-Instruct** | 1.5B | ~1.6 GB | 4k+ | **Best quality-per-MB in the runnable-on-phones range.** Strong instruction-following, decent code + structured output. | ⭐ **Default target** |
| **Gemma-2-2b-it** | 2B | ~1.6–2.5 GB | 4k+ | Strong, polished tone; heavier. | Higher-end phones / tablets |
| **Qwen2.5-3B-Instruct** | 3B | ~2.5–2.9 GB | 4k+ | **Leads the 3B class**; best reasoning + code we can run without a real GPU desktop. | ⭐ **Laptop / desktop tier** |
| **Llama-3.2-3B-Instruct** | 3B | ~2.3–3.0 GB | 4k+ | Solid all-rounder, great tone, but weaker reliable JSON/structured output than Qwen. | Laptop alt (tone-sensitive) |
| **Phi-3.5-mini-instruct** | 3.8B | ~2.5–5.5 GB | 4k+ | Strong on technical/STEM reasoning, **but** high repetition + poor length compliance in some evals → risky for chat. | Optional "STEM-heavy desktop" |

Notes that drive the decision:
- **Structured output reliability matters to us** because our guardrail layer enforces JSON-shaped tutor turns (intent, mode, message). Reports put **Llama-3.2-3B JSON parse reliability around ~48–57%** — too low to lean on; **Qwen2.5** is the more reliable structured-output family at small sizes. This is why Qwen is our spine.
- **Phi-3.5** is the strongest *reasoner* per GB but shows **repetition / length-compliance problems** in production text generation — fine as an optional power-user choice, not the default chat tutor.
- **SmolLM3-3B** (newer) reportedly beats Llama-3.2-3B and Qwen2.5-3B at the 3B scale; if a stable WebLLM build is available, it's a drop-in upgrade for the desktop tier. Verify availability before relying on it.

## 2. Which model should we *start* with

**Start with `Qwen2.5-1.5B-Instruct-q4f16_1`.**

Why:
- ~1.6 GB fits the **phone-first reality** (most Masterschool students study on phones) while still following multi-turn instructions and emitting structured output well enough for our guardrail JSON.
- Best **quality-per-megabyte** in the "runs on a mid Android" band — the sweet spot between SmolLM (too weak to teach) and 3B (too heavy for many phones).
- Same family scales cleanly: dev on 1.5B, offer 3B to laptops, drop to 0.5B for weak devices — one prompt style across the tier.

This is the model we build and demo against. The guardrail layer (not the model) is what makes it *teach correctly* on the 10 scenarios.

## 3. Which model is safest for a mobile / laptop demo

- **Safest phone demo:** `Qwen2.5-0.5B-Instruct-q4f16_1` (~0.95 GB). Almost always loads on a WebGPU phone without OOM; fast. Quality is lower, but with our guardrails + canned lesson scaffolds it still demos well and **won't crash on stage** — the #1 demo risk on mobile is an iOS/Android OOM kill.
- **Safest laptop demo:** `Qwen2.5-3B-Instruct-q4f16_1` (~2.5–2.9 GB) on a Chrome/Edge laptop with a real/integrated GPU. Best visible quality without crash risk. This is what we'd run for the **main on-stage demo**.
- **Demo rule:** pre-download and pre-cache the model on the demo device before presenting (first download is the only slow part). Have the 0.5B as a hot backup if the venue device is weak.

## 4. Tradeoffs: quality vs. speed vs. memory

The three axes pull against each other; there is no single winner, which is exactly why we ship a **device-tiered picker** ([mobile-device-strategy.md](mobile-device-strategy.md)) rather than one model.

- **Quality ↑ with size**, but so does **memory** (crash risk on phones/Safari) and **latency** (tokens/sec drops on weak GPUs → laggy chat).
- **Memory is the hard wall**, not speed: a model that's slightly slow is annoying; a model that exceeds the device budget **crashes the tab**. So we size *down* to fit memory first, then accept the quality hit and **buy back quality with guardrails + deterministic tools** (calculator, code-runner, lesson scaffolds) instead of a bigger model.
- **Speed/UX:** stream tokens, keep tutor turns short (our pedagogy wants short Socratic turns anyway — see the scenario answers), and use the model for *phrasing*, not for *facts*.
- **The key reframe:** we are **not** trying to pick a model smart enough to teach well unaided — no sub-3B model is. We pick the **largest model that reliably fits the device**, and let the architecture guarantee correctness and pedagogy. Model = the voice; guardrails = the teacher.

### Decision summary
| Tier | Device | Model | Rationale |
|---|---|---|---|
| Floor / fallback | No WebGPU, very weak | SmolLM2-360M (WASM) or lite mode | Just needs to run / degrade gracefully |
| Low | Cheap/old Android, iOS | Qwen2.5-0.5B | Loads without OOM, fast |
| **Default** | Mid phone | **Qwen2.5-1.5B** | Best quality-per-MB on phones |
| Desktop | Laptop / good GPU | **Qwen2.5-3B** | Best visible quality, low crash risk |
| Power (optional) | Strong GPU, STEM | Phi-3.5-mini / SmolLM3-3B | Extra reasoning for technical tracks |

---

### Sources
- [WebLLM prebuilt model list (GitHub issue #683)](https://github.com/mlc-ai/web-llm/issues/683)
- [mlc-ai/web-llm (GitHub)](https://github.com/mlc-ai/web-llm)
- [Best Open-Source Small Language Models in 2026 (BentoML)](https://www.bentoml.com/blog/the-best-open-source-small-language-models)
- [Small LLM Performance Benchmark (AscentCore, 2026)](https://ascentcore.com/2026/04/01/small-llm-performance-benchmark/)
- [Best Models Under 3B (InsiderLLM)](https://insiderllm.com/guides/best-models-under-3b-parameters/)
