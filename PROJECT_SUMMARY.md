# Maestro Open — a $0-cost AI tutor that runs entirely on your device

**One-liner:** A private, personal AI tutor that runs a real language model *inside the browser* — no servers, no API keys, no per-user cost — kept reliable by a deterministic engine that guards exactly the places small models fail.

---

## The problem

AI tutoring works, but serving it with frontier-model APIs costs real money per student and sends every conversation to a third party. Small on-device models are free and private — but on their own they hallucinate arithmetic, leak answers, validate wrong work, and get students stuck in loops.

## The solution

Maestro Open pairs a small on-device model (Qwen3, 0.6B–4B, via WebGPU) with the **Milestone Engine** — a thin deterministic layer that owns structure and correctness while the model owns the teaching:

```
Lesson goal
  → Decompose      model breaks the goal into a strictly ordered milestone queue
  → Milestone loop each milestone is taught in ISOLATED context (model sees only
                   this milestone's messages — small models stay focused)
       Assess      "is THIS milestone achieved?" — a focused yes/no judgment
       Teach       if not achieved, keep teaching; escalate hint → worked example
  → Sync           on completion, cross-check which remaining milestones were
                   implicitly achieved; update the queue, clear context, advance
```

**Deterministic rails** catch what a 1–2B model predictably gets wrong:

| Failure mode | Rail |
|---|---|
| Botched live arithmetic (`17 // 5`) | Every numeric claim is re-computed and corrected |
| Student trapped repeating one milestone | Escalating scaffold + hard force-advance cap |
| Malformed JSON from the model | Extraction + repair layer |
| Answer leaks, empty praise, ignored distress | Scrubbers + signal detection on every reply |

## Fine-tuned for the job

We distilled ideal per-call behaviour into the app's Qwen3-1.7B model with a reproducible one-command pipeline (`finetune/scripts/round2.sh`): **775 hand-specified scenarios** → LoRA training (mlx-lm) → fused → sharded GGUF → served in-browser by wllama. A byte-exact parity check guarantees the model is trained on the *same prompts* the engine actually sends.

## Why it matters

- **$0 COGS** — inference happens on the student's device; scaling to 1M students costs the same as 1.
- **Private by construction** — no conversation ever leaves the browser.
- **Works on real phones** — a device-tier picker chooses the largest safe model (0.5B → 4B) and steps down automatically on out-of-memory.
- **Honest** — no template fallbacks; if the device can't run a model, we say so.

## Tech & rigor

React + TypeScript + Vite · WebLLM (WebGPU) with a wllama (WASM/GGUF) backend for the fine-tuned model · mlx-lm fine-tuning pipeline · **328 unit tests** covering the engine, rails, math verification, JSON repair, and prompts · custom lesson authoring + session persistence.

## Run it

```bash
cd maestro-open
npm install && npm run dev    # lesson at "/", model + feature toggles at "/#/settings"
npm run verify:all            # typecheck + build + full test suite
```
