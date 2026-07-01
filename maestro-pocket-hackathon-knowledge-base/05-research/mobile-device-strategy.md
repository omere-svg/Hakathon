# Mobile Device Strategy

> The students we're reaching are mostly **low-income and study on phones** (per the problem background). So "runs in the browser" isn't enough — it has to run on a **cheap Android in a weak-network area**, and degrade gracefully when it can't. This doc is the device-tiering, fallback, model-picker, and offline plan.
> Builds on [webllm-research.md](webllm-research.md) and [local-models-comparison.md](local-models-comparison.md).

---

## 1. How we support weak devices

Principle: **detect capability up front, then commit to the heaviest experience the device can actually sustain — never more.** A crashed tab is far worse than a smaller model.

**Capability probe on first load (in order):**
1. `navigator.gpu` present? → WebGPU candidate. If absent → **No-WebGPU path** (§2).
2. Request an adapter (`navigator.gpu.requestAdapter()`); read its limits (e.g. `maxBufferSize`, `maxStorageBufferBindingSize`). Failure → No-WebGPU path.
3. Read device signals: `navigator.deviceMemory` (GB hint), `navigator.hardwareConcurrency` (cores), screen size, UA platform (iOS vs Android).
4. Map signals → **device tier** → default model (table in [local-models-comparison.md](local-models-comparison.md#decision-summary)).

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

## 3. Model-picker idea

The brief's research question is literally "ask the user their phone vs. pick one model for everyone." Our answer: **auto-detect + let the user override.** Best of both.

**"Pick my tutor" flow:**
- On first run, the capability probe (§1) chooses a **recommended model** for the device and explains it in plain language: *"We picked the Fast tutor — it runs smoothly on your phone. Want a smarter, heavier one?"*
- A simple **3-choice slider**, not model jargon:
  - 🟢 **Fast & light** (Qwen2.5-0.5B) — "works on most phones"
  - 🔵 **Balanced** (Qwen2.5-1.5B) — "recommended"
  - 🟣 **Smart** (Qwen2.5-3B) — "best on laptops / strong phones"
- Show the **download size + a one-tap test** ("try a sample turn") so the user feels the speed before committing.
- Persist the choice (IndexedDB). Offer to **re-pick** if we detect repeated slow turns or an OOM recovery.
- If load fails/OOMs, **auto-step-down** one tier and tell the user.

This makes the device-adaptivity a *visible product feature* ("it tuned itself to your phone"), which demos well and is a concrete answer to the brief's question.

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
- [webgpu-webllm-app: WebLLM with automatic WASM (wllama) fallback (GitHub)](https://github.com/krtarunsingh/webgpu-webllm-app)
- [Cross-Browser Local LLM Inference Using WebAssembly (Picovoice)](https://picovoice.ai/blog/cross-browser-local-llm-inference-using-webassembly/)
- [mlc-ai/web-llm (GitHub)](https://github.com/mlc-ai/web-llm)
