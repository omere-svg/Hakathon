# WebLLM Research

> Research for the "Maestro Open" hackathon: a $0-COGS, on-device tutor.
> The hard constraint from the brief: **"It can't cost us money when a new user shows up. No cloud LLM bill per lesson, no per-user server. The model runs on the user's own device."** The brief explicitly names **web-llm** as the tool. This doc decides whether we can actually build on it and what breaks.

---

## 1. What WebLLM is

**WebLLM** (`github.com/mlc-ai/web-llm`) is an open-source (Apache-2.0) **in-browser LLM inference engine** from the MLC AI team. It runs a full LLM **entirely on the user's device, inside a normal web page** — no server, no API key, no network call after the model is downloaded once.

Key facts:
- It exposes an **OpenAI-compatible API** (`chat.completions.create`, streaming, JSON / structured output, function-calling-style grammars). This matters a lot: our pedagogy/guardrail code can be written against the same shape we'd use for a cloud model, so the rest of the app doesn't care that inference is local.
- Models are **pre-compiled** by the MLC toolchain (MLC-LLM) into two artifacts: (1) **WebGPU shader/kernel code** compiled via Apache TVM, and (2) **quantized weight files** (sharded). WebLLM downloads these once and caches them.
- It ships a **prebuilt model registry** (`prebuiltAppConfig` / `MLCEngine`) — you pick a model by string ID (e.g. `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`) and it handles download + load. See [local-models-comparison.md](local-models-comparison.md) for the shortlist.
- It runs the engine in a **Web Worker / Service Worker** so the heavy compute doesn't freeze the UI thread, and reports load/inference progress via callbacks (we use this for the download progress bar).
- Reported performance: **up to ~80% of native inference speed** on the same device via WebGPU.

In one line: **WebLLM turns the browser into the inference server, so the inference server costs us $0.**

## 2. How it runs locally

The lifecycle, and where each piece lives:

1. **First visit / model selection.** App calls `CreateMLCEngine(modelId, { initProgressCallback })`. WebLLM fetches the compiled WASM module + sharded weight files from a CDN (HuggingFace / GitHub by default; we can self-host on our own static CDN — still $0 to us at small scale, and free-tier static hosting at larger scale).
2. **Caching.** Weights are stored on-device using the **Cache API / IndexedDB**, and modern builds stream weights via **OPFS (Origin Private File System)** to avoid blowing up the WASM heap (important for Safari — see Risks). After the first download, **subsequent loads are offline and instant-ish** (read from disk, not network).
3. **Compute.** Token generation runs on the GPU through **WebGPU**. CPU-side subsystems (the grammar engine for structured output, paged KV-cache sequence management, kernel launch/tensor glue) are compiled C++ → **WebAssembly** via Emscripten. So WebLLM = **WebGPU for the matmuls + WASM for the orchestration.**
4. **Inference.** App calls the OpenAI-style API; tokens stream back. State (KV cache) lives in GPU memory for the session.

Practical implication for us: **the only "server" we run is a static file host** (app shell + optionally the model weights). That is trivially free (GitHub Pages / Cloudflare Pages / Vercel static / a bucket). No GPU, no inference endpoint, no per-user cost. This is exactly what the brief demands.

## 3. Browser / device requirements

WebLLM's hard dependency is **WebGPU**. WASM is universally available; WebGPU is the gate. Status as of 2026:

| Platform | WebGPU status (2026) | Notes for us |
|---|---|---|
| **Chrome / Edge desktop** | Stable since **Chrome 113** (2023) | Best target. Our laptop demo machine. |
| **Chrome on Android** | Stable since **Chrome 121**, on **Android 12+** with Qualcomm/ARM GPUs | The **majority case for our students** (most study on phones). Works, but mid/low-end Android GPUs are slow + memory-limited. |
| **Safari (iOS / iPadOS / macOS)** | Shipped **on by default in Safari 26** (iOS 26 / iPadOS 26 / macOS Tahoe 26) | Big unlock — iPhones are finally in scope — but **older iOS (<26) has no WebGPU**, and Safari has the strictest memory limits + known crash bugs (see Risks). |
| **Firefox** | Windows in **141**, Apple-Silicon macOS in **145/147**; Linux + Android still landing through 2026 | Treat as "works on desktop, don't rely on it for mobile." |

**Hardware floor (rule of thumb):**
- Needs a **WebGPU-capable GPU** and enough free VRAM/unified memory for the chosen model. Practical browser ceiling is **~4–6 GB for quantized weights** before crashes; realistic mobile budget is much smaller (~1–2 GB).
- This means **model choice must adapt to the device** — a phone gets a 0.5–1.5B model, a laptop can run 3B+. This drives the **model-picker** decision in [mobile-device-strategy.md](mobile-device-strategy.md).

**Global coverage:** WebGPU reached roughly **~70%+ of browsers** during 2024 and keeps climbing. So a meaningful minority of our low-income, older-device users will have **no WebGPU at all** — we must have a fallback, not a blank screen.

## 4. Pros / cons for this hackathon

**Pros**
- **Nails the one rule:** $0 marginal COGS, no per-user server inference. This is the single judged constraint that kills most "obvious" designs.
- **Named in the brief** — lowest-risk path to "did what was asked," and battle-tested (it's a real, maintained project).
- **OpenAI-compatible API + structured output / grammar** → we can enforce JSON-shaped tutor turns and build deterministic guardrails on top (this is our moat — see [architecture.md](../06-product-decisions/architecture.md)).
- **Offline after first load** → real value for low-connectivity students; pairs naturally with a **PWA** ("install once, learn anywhere").
- **Privacy story** — student data and chat never leave the device. Strong narrative for an education product serving vulnerable users.

**Cons**
- **First-download tax:** the model is hundreds of MB to ~2 GB. On a cheap phone with metered data this is a real onboarding cost (time + bandwidth, even if $0 to *us*). Mitigation: small default model, clear progress UI, cache aggressively, allow Wi-Fi-only download.
- **Small models are weak teachers.** A 0.5–3B model will, on its own, **fail most of the 10 TutorBench scenarios** (it will validate wrong code, leak challenge answers, make arithmetic errors, dump answers instead of scaffolding). WebLLM gives us cheap inference, **not** good pedagogy. The product's real work is the layer *around* the model.
- **Device variance is huge** — same code, wildly different speed/feasibility across a $150 Android and an M-series Mac.

## 5. Risks (and mitigations)

| Risk | Impact | Mitigation |
|---|---|---|
| **No WebGPU** (old iOS, old Android, Firefox mobile, locked-down devices) | App can't run the model at all | **WASM/CPU fallback** (wllama) with a tiny model; or graceful **"lite mode"** (structured lessons + quizzes without free-form generation). Detect `navigator.gpu` up front. See [mobile-device-strategy.md](mobile-device-strategy.md). |
| **Safari/iOS memory crashes** | iPhone tab killed mid-lesson; CPU stuck at 400%+, memory ballooning | Use the **smallest viable model on iOS**, prefer OPFS-streaming builds, cap context length, free the engine between lessons, test on a real iPhone early. |
| **First-load size/time** on slow networks | High bounce on onboarding | Default to a **sub-1GB model**, Wi-Fi-only prompt, resumable/cached downloads, show value (a lesson preview) before the full download finishes. |
| **Model is factually wrong** (math, definitions — see SWE-02, BIZ-02) | Tutor teaches errors → unacceptable for a degree-track brand | **Never trust the model for arithmetic.** Route calculations to a deterministic in-browser tool (JS / Pyodide), verify code by running it. Guardrail layer owns correctness. |
| **Slow tok/s on weak GPUs** | Laggy, frustrating UX | Pick model by device tier; stream tokens; keep turns short; show typing indicator. |
| **CDN / weight-hosting availability** | Download fails | Self-host weights on free static CDN; verify integrity; cache-first after load. |
| **WebGPU implementation bugs** across browsers | Sporadic failures | Feature-detect + try/catch around engine init; fall back to smaller model or lite mode on failure; log which path the user landed on. |

**Bottom line:** WebLLM is the correct foundation and the only one that satisfies the brief's hard rule. It is **necessary but not sufficient** — it makes inference free but does not make the tutor *good*. Our differentiation is everything we build on top of it (guardrails, deterministic tools, lesson engine, eval harness), plus a device-adaptive model strategy so it actually runs on the phones our students use.

---

### Sources
- [mlc-ai/web-llm (GitHub)](https://github.com/mlc-ai/web-llm)
- [WebLLM docs](https://webllm.mlc.ai/docs/)
- [WebLLM: A High-Performance In-Browser LLM Inference Engine (arXiv)](https://arxiv.org/html/2412.15803v1)
- [WebGPU is now supported in major browsers (web.dev)](https://web.dev/blog/webgpu-supported-major-browsers)
- [Can I use: WebGPU](https://caniuse.com/webgpu)
- [Cross-Browser Local LLM Inference Using WebAssembly (Picovoice)](https://picovoice.ai/blog/cross-browser-local-llm-inference-using-webassembly/)
- [WebGPU bugs are holding back the browser AI revolution (Medium)](https://medium.com/@marcelo.emmerich/webgpu-bugs-are-holding-back-the-browser-ai-revolution-27d5f8c1dfca)
