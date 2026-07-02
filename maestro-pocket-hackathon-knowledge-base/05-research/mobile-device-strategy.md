# Mobile Device Strategy

> The students we're reaching are mostly **low-income and study on phones** (per the problem background). So "runs in the browser" isn't enough — it has to run on a **cheap Android in a weak-network area**, and degrade gracefully when it can't. This doc is the device-tiering, fallback, model-picker, and offline plan.
> Builds on [webllm-research.md](webllm-research.md) and [local-models-comparison.md](local-models-comparison.md).
>
> **Update — 2026-07-02:** §1 and §3 rewritten after researching what browsers actually expose about device capability, and the device→model policy here is now **implemented** in [`llm/models.ts`](../../maestro-open/src/llm/models.ts) (`probeDevice` / `pickModel`) with a load-time step-down in [`llm/engine.ts`](../../maestro-open/src/llm/engine.ts).

---

## 1. How we support weak devices

Principle: **detect capability up front, then commit to the heaviest experience the device can actually sustain — never more.** A crashed tab is far worse than a smaller model. Because no single signal is trustworthy, we combine coarse signals for the *initial* pick and rely on a **load-time step-down** as the actual guarantee.

### 1a. What we can (and can't) read about the device — 2026 reality

| Signal | What it tells us | Reliability caveat (researched) |
|---|---|---|
| `navigator.gpu` + `requestAdapter()` | Is WebGPU usable at all | The gate. Present but adapter can still be refused. |
| `adapter.limits.maxBufferSize` / `maxStorageBufferBindingSize` | GPU buffer ceiling — a **tier proxy** (~128–256 MB mobile → 2–4 GB desktop) | Browsers report **tiered/normalized** values, not exact, to resist fingerprinting. **WebGPU deliberately never exposes total or available VRAM.** MLC shards weights, so these are a *hint*, not a hard per-model gate. |
| `navigator.deviceMemory` | System RAM in GB (good budget proxy for integrated GPUs) | **Chromium-only** (Chrome/Edge/Opera/Brave). Rounded to {0.25,0.5,1,2,4,8} and **capped at 8**. **`undefined` on Safari/iOS and Firefox.** |
| `navigator.hardwareConcurrency` | Logical cores | Broad support, but **capped at 2 on iOS**, 8 on macOS Safari → weak tiebreaker only. |
| UA + `maxTouchPoints` | iOS vs Android vs desktop | iPadOS 13+ reports a **desktop-Mac UA** → disambiguate via `maxTouchPoints > 1`. |

**Takeaway:** you can't ask "how much VRAM is free." You infer a tier from coarse hints, then **attempt to load and catch the out-of-memory / device-lost error** — the only reliable feedback the platform gives.

### 1b. Capability probe on first load (as implemented in `probeDevice`)
1. `navigator.gpu` present? Request an adapter. No adapter → **No-WebGPU path** (§2).
2. Read `adapter.limits` (`maxBufferSize`, `maxStorageBufferBindingSize`).
3. Read `navigator.deviceMemory`, `hardwareConcurrency`, and detect iOS/Safari from UA + `maxTouchPoints`.
4. Feed all of it to the pure `pickModel(probe)` policy (§3) → a recommended model.
5. **Attempt load; on OOM/device-lost, step down one tier and retry** (`engine.ts` `loadWithStepDown`).

**Tactics for weak-but-capable devices:** size down by default and let users opt up; cap context length + keep tutor turns short (less KV-cache memory); free the engine between lessons on iOS; Wi-Fi-only resumable download; ship only `q4f16_1`; show lesson text from static JSON while weights download.

**Tactics for weak-but-capable devices:**
- **Size down by default**, let users opt up. Start a low-tier device on Qwen2.5-0.5B, not 1.5B.
- **Cap context length** and keep tutor turns short (our Socratic pedagogy wants short turns anyway) → less KV-cache memory, faster tokens.
- **One engine at a time**: free the WebLLM engine between lessons on memory-tight devices (especially iOS) to avoid creep → crash.
- **Wi-Fi-only download prompt** + resumable, cached weights so a metered/cheap data plan isn't burned on a 1 GB download.
- **Quantize hard** (`q4f16_1`) — the only builds we ship on mobile.
- **Show value before the model finishes loading**: lesson text, objectives, and the first scaffold render from static lesson JSON while weights download in the background.

## 2. What to do if WebGPU is unavailable

A real minority of our users (older iOS <26, older Android, Firefox mobile, locked-down/enterprise devices) have **no WebGPU**. We must not show a dead screen. Three-rung ladder, best-effort first:

1. **WASM / CPU fallback (wllama).** WebLLM/companion runtimes can fall back to a **WebAssembly CPU** path (e.g. wllama) running a tiny model (SmolLM2-360M / Qwen2.5-0.5B). Slow, but it *works* and keeps the $0-COGS promise. Use for short, scaffolded turns only.
2. **"Lite mode" — lessons without free-form generation.** Every lesson ships as **static structured content** (explanation, worked example, quiz questions, hints, answer checks) authored from the Maestro lesson + the TutorBench-style rubric. The student still learns the full lesson and gets **deterministic feedback** (right/wrong, targeted hints, calculator) — just no open-ended chat. This is genuinely useful and **100% offline, $0, runs anywhere** (no GPU, no WASM model). It's our universal floor.
3. **Optional opt-in cloud (explicitly off by default).** Not part of the $0 product. If we ever want a "boost" toggle it must be user-initiated and clearly not the default, to keep COGS at $0. Mention only; do not build for the hackathon.

**Decision:** ship **WASM fallback + Lite mode**. Lite mode is the safety net that guarantees *every* device gets a working lesson, which is itself a strong differentiator vs. competitors who'll show a "WebGPU required" error on half the phones in the developing world.

## 3. Model-picker — the implemented policy

The brief's research question is literally "ask the user their phone vs. pick one model for everyone." Our answer: **auto-detect + let the user override, with a load-time step-down net.** Best of both, and robust to the fact that the signals lie.

### 3a. Tiers (Qwen3 spine — see [local-models-comparison.md](local-models-comparison.md))
| Tier | Model | ~VRAM | Who gets it |
|---|---|---|---|
| `floor` | Qwen2.5-0.5B | ~0.95 GB | Old/very weak devices; bottom rung of the step-down |
| `low` | **Qwen3-0.6B** | ~1.4 GB | Most phones |
| `mid` ⭐ | **Qwen3-1.7B** | ~2.0 GB | Modern phone (6 GB+), iPhone iOS 26 — the default |
| `high` | **Qwen3-4B** | ~3.4 GB | Laptops / strong phones |

### 3b. `pickModel(probe)` — the pure decision (conservative on purpose)
- **iOS/iPadOS:** never `high` (Metal per-buffer caps + aggressive tab kills). If the buffer ceiling looks like an older iPhone (`maxStorageBufferBindingSize < 512 MB`) → `floor`; a large `maxBufferSize` (≥1500 MB, e.g. iPad Pro / recent iPhone) → `mid`; otherwise `low`.
- **Everything else:** estimate a budget (GB) — prefer `deviceMemory`; else infer a tier from `maxBufferSize` (≥2000→8, ≥1000→6, else 4); else assume 6 (unknown, e.g. Firefox). Pick the **largest model whose `approxGB × 1.6` (headroom for KV cache + browser/OS) fits the budget.**
- Memory is the hard wall: a too-big model **crashes the tab**; a too-small one is merely weaker. So we round *down*.

### 3c. The step-down net (`engine.ts` `loadWithStepDown`) — the real guarantee
Signals only *guess* the tier. On an out-of-memory / device-lost error we **step down to the next-smaller catalog model and retry**, telling the user ("switching to a lighter one…"). Disabled for explicit ids (the benchmark) so comparisons stay honest. This is what turns an over-optimistic guess into a smaller model instead of a dead tab.

### 3d. "Pick my tutor" UX
- On first run, show the probe-backed recommendation in plain language ("We picked *Balanced* — it runs smoothly on your phone. Want a smarter, heavier one?"). The Settings picker already renders the catalog + live recommendation (`recommendModelAsync`).
- Show **download size + a one-tap "try a sample turn"** so the user feels the speed before committing; persist the choice; offer to re-pick after repeated slow turns or an OOM recovery.

This makes device-adaptivity a *visible product feature* ("it tuned itself to your phone") and is the concrete answer to the brief's question.

## 4. Offline / PWA strategy

On-device inference + offline lessons is a natural, compelling **PWA** — "install once, learn anywhere, even with no signal." This is real value for low-connectivity students and reinforces the privacy/$0 story.

- **Installable PWA**: web app manifest, add-to-home-screen, standalone display. Feels like a native app, ships like a website.
- **Service worker** caches the **app shell** (HTML/CSS/JS) cache-first → instant launch, works offline.
- **Lesson content** (Maestro lesson JSON + rubrics + scaffolds) bundled/cached → all lessons available offline.
- **Model weights** persisted via WebLLM's **Cache API / IndexedDB / OPFS** → no re-download; offline inference after first load.
- **Progress, mastery state, preferences, and eval results** stored in **IndexedDB**, fully local (privacy + offline). Optional export/import (JSON) so a student can move devices without a backend.
- **No backend = nothing to keep running = $0.** Static hosting only.

**Onboarding sequencing for weak networks:** install PWA → load Lite-mode lessons immediately (tiny) → offer model download on Wi-Fi in the background → upgrade to chat tutor when ready. The student is never blocked waiting on a 1 GB download.

---

### Summary
| Situation | What the user gets |
|---|---|
| Modern phone/laptop, WebGPU | Full on-device chat tutor, model sized to device, offline after first load |
| Weak but WebGPU-capable | Smaller model (0.5B), short turns, Wi-Fi-only download |
| No WebGPU | WASM tiny model, or **Lite mode** (static lessons + deterministic feedback) |
| Offline / no signal | PWA: cached app + lessons + weights, fully local progress |

The mobile strategy *is* part of the product story: **"a tutor that tunes itself to whatever device you have, and keeps working with no internet — at zero cost to the school."**

---

### Sources
- [WebGPU is now supported in major browsers (web.dev)](https://web.dev/blog/webgpu-supported-major-browsers)
- [Can I use: WebGPU](https://caniuse.com/webgpu)
- [GPUSupportedLimits — MDN](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits) — `maxBufferSize`, `maxStorageBufferBindingSize`
- [WebGPU limits & features (webgpufundamentals)](https://webgpufundamentals.org/webgpu/lessons/webgpu-limits-and-features.html) — browsers report *tiered* limits, and spec hides total VRAM (fingerprinting)
- [navigator.deviceMemory & fingerprinting (VeilFlux)](https://veilflux.com/knowledge/how-device-memory-affects-your-privacy-scan) — Chromium-only, rounded, capped at 8, undefined on Safari/Firefox
- [navigator.hardwareConcurrency (caniuse)](https://caniuse.com/hardwareconcurrency) — capped at 2 on iOS, 8 on macOS Safari
- [WebLLM device-lost / insufficient-memory (issue #517)](https://github.com/mlc-ai/web-llm/issues/517) · [issue #647](https://github.com/mlc-ai/web-llm/issues/647) — the OOM error we step down on
- [WebGPU browser AI inference — capability check + fallback from day one (buildmvpfast, 2026)](https://www.buildmvpfast.com/blog/webgpu-browser-ai-inference-cost-savings-2026) — Safari Metal per-buffer caps (256 MB old iPhones)
- [webgpu-webllm-app: WebLLM with automatic WASM (wllama) fallback (GitHub)](https://github.com/krtarunsingh/webgpu-webllm-app)
- [Cross-Browser Local LLM Inference Using WebAssembly (Picovoice)](https://picovoice.ai/blog/cross-browser-local-llm-inference-using-webassembly/)
- [mlc-ai/web-llm (GitHub)](https://github.com/mlc-ai/web-llm)
