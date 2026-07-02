# Local Models Comparison

> Which on-device model should the Maestro Open tutor run? Constraint: must run **in the browser via WebLLM/WebGPU** (see [webllm-research.md](webllm-research.md)), on devices ranging from **cheap Android phones to laptops**. The teaching quality bar is set by the **10 TutorBench failure scenarios** ([../03-scenarios-and-evals](../03-scenarios-and-evals)).
>
> **Update — 2026-07-02:** rewritten after verifying the **actual WebLLM prebuilt registry** (`config.ts`) and researching the 2026 small-model landscape. Two changes from the prior version: (1) **Qwen3 (0.6B / 1.7B / 4B) is now prebuilt in WebLLM** and is a genuine generational jump — it becomes our recommended family; (2) **SmolLM3-3B is NOT in the WebLLM registry** (only SmolLM2 is), so the earlier "SmolLM3 desktop upgrade" idea is dropped — it would require self-compiling MLC, out of scope. Also reframed for the **current architecture**: a fully model-driven milestone engine with **no deterministic net** and grammar/JSON mode **disabled**, which raises the reasoning + free-text-JSON bar on the model.

---

## 0. Why the model choice matters MORE now than in the v2.5 design

The old design treated the model as "the voice" and let deterministic guardrails own correctness. **That is no longer the architecture.** The shipped engine ([`engine/milestone/engine.ts`](../../maestro-open/src/engine/milestone/engine.ts)) is **fully model-driven with no verify/guard net** — the local model owns decomposition, per-milestone assessment, cross-check/sync, teaching, and suggestion generation. On top of that, WebLLM 0.2.84's grammar/JSON-schema mode is **disabled** (`config/features.ts` — it throws an uncatchable error and hangs the turn), so every JSON verdict is parsed from **free text** via a regex fallback ([`json.ts`](../../maestro-open/src/engine/milestone/json.ts)).

Consequence: the deciding qualities are now **instruction-following + light reasoning (for assessment) + clean JSON without a grammar to lean on**. That is exactly where Qwen3 improves most over Qwen2.5. Model choice is now a first-order quality lever, not a cosmetic one.

## 1. The realistic candidate set (verified against WebLLM `config.ts`, q4f16_1 builds)

We can only use models that exist as **WebLLM prebuilt artifacts**. VRAM below is the figure WebLLM reports for the `q4f16_1` (4-bit) build we'd actually ship; it is close to the download size.

| Model | Params | `q4f16_1` VRAM | In WebLLM? | Teaching-quality lens (small-model) | Best fit |
|---|---|---|---|---|---|
| **SmolLM2-360M-Instruct** | 0.36B | ~0.38 GB | ✅ | Weak; canned/scaffolded flows only. | WASM/no-WebGPU floor |
| **Qwen2.5-0.5B-Instruct** | 0.5B | ~0.95 GB | ✅ | Decent instruction-following for size; error-prone reasoning. | Ultra-safe low-end floor |
| **gemma3-1b-it** | 1B | ~0.71 GB | ✅ | Tiny + polished tone, but weaker *free-text JSON* than Qwen → risky for our parse-from-text path. | Optional light option, not default |
| **Qwen3-0.6B** | 0.6B | ~1.4 GB | ✅ | New-gen 0.6B; better instruction-following + JSON than Qwen2.5-0.5B. | ⭐ **Low tier** |
| **Llama-3.2-1B-Instruct** | 1B | ~0.88 GB | ✅ | Friendly tone; weak multi-step reasoning + weaker JSON reliability. | Tone-sensitive low alt |
| **SmolLM2-1.7B-Instruct** | 1.7B | ~1.77 GB | ✅ | Solid for size; behind Qwen3-1.7B on reasoning. | Alt mid |
| **Qwen2.5-1.5B-Instruct** | 1.5B | ~1.63 GB | ✅ | Previous default; strong quality-per-MB. | Superseded by Qwen3-1.7B |
| **Qwen3-1.7B** | 1.7B | ~2.0 GB | ✅ | **≈ Qwen2.5-3B-class reasoning at a phone footprint** (per Qwen3 report); native JSON/tool-calling. | ⭐ **Default / mid** |
| **Qwen2.5-3B-Instruct** | 3B | ~2.5 GB | ✅ | Prior laptop tier; strong. | Superseded by Qwen3-4B |
| **Llama-3.2-3B-Instruct** | 3B | ~2.26 GB | ✅ | Good tone, but **JSON parse rate ~48–57%** — too low for our parse-from-text path. | Avoid as spine |
| **Qwen3-4B** | 4B | ~3.4 GB | ✅ | Best in-browser quality we can run; strongest assessment reasoning. | ⭐ **High / laptop** |
| **Phi-4-mini-instruct** | 3.8B | ~3.44 GB | ✅ | Strong STEM reasoning; historically repetition/length-compliance risk in chat. | Optional STEM power-user |
| SmolLM3-3B | 3B | — | ❌ **not in WebLLM** | Beats Qwen2.5-3B on paper, but unavailable without self-compiling MLC. | Out of scope |

Notes that drive the decision:
- **Free-text JSON reliability is now critical** (grammar mode is off; we parse verdicts from text). **Qwen** is the most reliable structured family at small sizes; **Llama-3.2-3B's ~48–57% JSON parse rate** disqualifies it as the spine. This is why we stay on the Qwen line.
- **Qwen3 is a real generational jump.** Alibaba's Qwen3 report positions **Qwen3-1.7B (non-thinking) against Qwen2.5-3B-Instruct**, and the family adds first-class JSON/tool-calling and better instruction-following — the exact axes our netless engine leans on. Footprint rises modestly (1.63→2.0 GB for the mid tier).
- **SmolLM3-3B is not prebuilt in WebLLM** — drop it (would need MLC self-compile).

## 2. Which model to START with (and demo)

**Default / dev / demo: `Qwen3-1.7B-q4f16_1-MLC` (~2.0 GB), run in non-thinking mode.**

Why:
- ~2.0 GB still fits the **phone-first reality** while delivering ~3B-class assessment reasoning — the quality our netless milestone loop depends on to judge "is this milestone achieved?"
- Best **quality-per-MB** in the runs-on-a-decent-phone band, and the same family scales cleanly across tiers (one prompt style: dev on 1.7B, 4B to laptops, 0.6B to weak devices).
- Native JSON/tool-calling gives cleaner free-text JSON for `parseAchieved` / decomposition / sync than Qwen2.5.

## 3. ⚠️ Qwen3-specific requirement — run NON-THINKING (`/no_think`)

Qwen3 is a **hybrid thinking model**. Left in thinking mode it emits `<think>…</think>` blocks, which will:
1. **Break `extractJson` / `parseAchieved`** (the reasoning text is not valid JSON), and
2. **Triple latency** — and the engine already does **2–3 serial on-device calls per student turn** (see [milestone-engine-weak-spots.md](milestone-engine-weak-spots.md) #5).

**Mandatory when moving to Qwen3:**
- Append **`/no_think`** to the system prompt on *every* engine call ([`prompts.ts`](../../maestro-open/src/engine/milestone/prompts.ts)) — the reliable soft switch in WebLLM (there's no `apply_chat_template` kwargs surface in the browser API).
- **Strip any `<think>…</think>` block** in [`json.ts`](../../maestro-open/src/engine/milestone/json.ts) before parsing (belt-and-suspenders).
- On the WebLLM version that ships Qwen3, **re-test the `structuredOutput` flag** — if JSON-grammar mode is fixed, re-enabling it directly kills weak-spot #3 (fragile achievement parsing) and is the single biggest reliability win.

(Thinking mode *could* help the assessment step specifically, but with grammar off + regex parsing + a 3-call turn, force non-thinking everywhere for the hackathon; revisit selectively later.)

## 4. Safest demo choices

- **Safest phone demo:** `Qwen3-0.6B` (~1.4 GB) or the ultra-safe `Qwen2.5-0.5B` (~0.95 GB). Almost always loads on a WebGPU phone without OOM; fast. The #1 on-stage mobile risk is an iOS/Android OOM kill, not quality.
- **Safest laptop demo:** `Qwen3-4B` (~3.4 GB) on a Chrome/Edge laptop with a real/integrated GPU — best visible quality, low crash risk. This is the main on-stage demo model.
- **Demo rule:** pre-download and pre-cache the model on the demo device before presenting (first download is the only slow part). Keep the 0.6B as a hot backup if the venue device is weak.

## 5. Tradeoffs: quality vs. speed vs. memory

- **Quality ↑ with size**, but so do **memory** (crash risk on phones/Safari) and **latency** (tokens/sec drops on weak GPUs → laggy chat, amplified by our 2–3 calls/turn).
- **Memory is the hard wall**, not speed: a slow model is annoying; a model that exceeds the device budget **crashes the tab**. Size *down* to fit memory first.
- **The reframe for the current engine:** we pick the **largest model that reliably fits the device** and run it non-thinking for latency, because the model — not a guardrail layer — is now doing the judging. Cheap deterministic *rails* (attempt counters, `<think>`-strip, evidence-cited verdicts; see weak-spots doc) buy back reliability without moving the judgment off the model.

### Decision summary
| Tier | Device | Model (`q4f16_1`) | ~VRAM | Rationale |
|---|---|---|---|---|
| Floor / fallback | No WebGPU, very weak | SmolLM2-360M (WASM) or Lite mode | ~0.38 GB | Just needs to run / degrade gracefully |
| **Low** | Cheap ≤4 GB Android, older iOS | **Qwen3-0.6B** (ultra-safe alt: Qwen2.5-0.5B) | ~1.4 / 0.95 GB | Loads without OOM, fast |
| **Default** ⭐ | Modern phone 6 GB+, iPhone iOS 26 | **Qwen3-1.7B** | ~2.0 GB | ≈ 3B-class reasoning at phone footprint |
| **High** | Laptop / good GPU | **Qwen3-4B** | ~3.4 GB | Best visible quality, low crash risk |
| Power (optional) | Strong GPU, STEM track | Phi-4-mini | ~3.44 GB | Extra STEM reasoning |

## 6. How much work is a model swap? (implementation note)

The model is fully parameterized: `MODELS` catalog → `getSelectedModelId()` → `createWebLLMEngine(onProgress, modelId)` ([`engine.ts`](../../maestro-open/src/llm/engine.ts)). Nothing downstream hardcodes a model.

- **Within a family (Qwen 0.6→1.7→4B):** editing the `MODELS` array in [`models.ts`](../../maestro-open/src/llm/models.ts) (+ collapsing the duplicate `DEFAULT_MODEL` in [`webllm.ts`](../../maestro-open/src/llm/webllm.ts) onto it). Effectively one place. Also update `approxGB`/`tier` and the `recommendModel()` memory thresholds.
- **Across families (Qwen2.5 → Qwen3):** the above **plus** the `/no_think` switch and `<think>`-strip in §3. Required, not optional — but ~2 small edits.

## 7. Auto-matching the model to the device (feasibility)

Doable and already scaffolded (`recommendModel()` reads `navigator.deviceMemory`), but signals are coarse: `deviceMemory` is rounded, capped at 8, and **`undefined` on Safari/iOS**. Ship it as **defense-in-depth**, not a single trusted call:
1. Coarse pick from `deviceMemory` / UA, **upgraded** by reading **WebGPU adapter limits** (`maxBufferSize`, `maxStorageBufferBindingSize`) — a real ceiling (probe specced in [mobile-device-strategy.md](mobile-device-strategy.md), not yet wired).
2. **Attempt load → catch OOM → auto-step-down one tier** and tell the user. This is the only reliable guarantee; signals alone will occasionally mispredict.
3. **User override** (the Settings picker already exists) + persist the choice.

Answer to the brief's explicit question ("ask the device vs. one model for all"): **auto-detect + override — both, with an OOM step-down net.**

---

### Sources
- [WebLLM prebuilt config (`config.ts`, verified model IDs + VRAM)](https://github.com/mlc-ai/web-llm/blob/main/src/config.ts)
- [WebLLM prebuilt model list (GitHub issue #683)](https://github.com/mlc-ai/web-llm/issues/683)
- [Qwen3 Technical Report (arXiv 2505.09388)](https://arxiv.org/pdf/2505.09388) — small-tier positioning vs Qwen2.5
- [Qwen3 full lineup guide 2026](https://baeseokjae.github.io/posts/qwen-3-full-lineup-guide-2026/) — thinking/non-thinking, edge sizing
- [Disabling Qwen3 thinking (QwenLM discussion #1300)](https://github.com/QwenLM/Qwen3/discussions/1300)
- [Best Open-Source Small Language Models in 2026 (BentoML)](https://www.bentoml.com/blog/the-best-open-source-small-language-models) — SmolLM3 / 3B-class comparison
- [Small LLM Performance Benchmark (AscentCore, 2026)](https://ascentcore.com/2026/04/01/small-llm-performance-benchmark/)
- [Best Models Under 3B (InsiderLLM)](https://insiderllm.com/guides/best-models-under-3b-parameters/)
</content>
</invoke>
