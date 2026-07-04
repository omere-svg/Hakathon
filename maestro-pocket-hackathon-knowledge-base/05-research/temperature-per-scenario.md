# Temperature per Scenario — how to set sampling for each engine call

**Status:** researched + implemented (same day).
**Date:** 2026-07-02
**Owner question:** *"Research the temperature field and how to decide the score per scenario;
document it, then set the right temperature everywhere in the code."*
**Trigger incident:** after the 2026-07-02 rails pass set `temperature: 0` for decomposition,
the decomposer stopped splitting: both `expand@d0` calls returned unparseable output, both
retries came back `atomic`, and the "plan" was the raw mastery goals verbatim. This doc explains
why, and fixes the policy.

Scope: every `llm.complete()` call site in `maestro-open/src/engine/` and the defaults in
`maestro-open/src/llm/` (WebLLM · Qwen3-1.7B on-device).

---

## 1. What temperature actually does

Temperature rescales the token probability distribution before sampling:

- **temp → 0 (greedy):** always pick the single most-likely token. Fully deterministic.
- **temp < 1:** sharpen the distribution — likely tokens more likely. Conservative, repetitive.
- **temp = 1:** sample from the model's raw distribution.
- **temp > 1:** flatten it — more diversity, more derailment risk.

`top_p` (nucleus sampling) is the complementary knob: only sample from the smallest token set
whose cumulative probability ≥ p. Lower `top_p` = cut the long tail of weird tokens. WebLLM
0.2.84 exposes `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` per request
(no `top_k` / `min_p` at the request level).

## 2. Generic best practice (task-shaped)

The standard industry guidance, per task type:

| Task shape | Generic recommendation |
|---|---|
| Structured output / JSON extraction / classification / grading | **0.0–0.3** — one right answer, want reproducibility |
| Code generation | 0.0–0.3 |
| Conversational / explanatory prose | **0.6–0.8** |
| Creative writing / brainstorming | 0.9–1.2 |

Sources: [Tetrate LLM temperature guide](https://tetrate.io/learn/ai/llm-temperature-guide),
[IBM — What is LLM temperature](https://www.ibm.com/think/topics/llm-temperature),
[SurePrompts 2026 reference](https://sureprompts.com/blog/llm-temperature-sampling-complete-guide-2026),
[machinelearningplus — temperature/top-p/top-k](https://machinelearningplus.com/gen-ai/llm-temperature-top-p-top-k-explained/).

## 3. The Qwen3 override — DO NOT use greedy decoding

Generic guidance says "temperature 0 for JSON." **The model vendor overrides it.** The official
Qwen3 model card ([Qwen/Qwen3-1.7B](https://huggingface.co/Qwen/Qwen3-1.7B),
[Qwen quickstart](https://qwen.readthedocs.io/en/latest/getting_started/quickstart.html)) says:

> *"For thinking mode (`enable_thinking=True`), use `Temperature=0.6`, `TopP=0.95`, `TopK=20`,
> and `MinP=0`. **DO NOT use greedy decoding**, as it can lead to performance degradation and
> endless repetitions."*
>
> *"For non-thinking mode (`enable_thinking=False`), we suggest using `Temperature=0.7`,
> `TopP=0.8`, `TopK=20`, and `MinP=0`."*

Also confirmed by the [vendor parameter quick reference (muxup)](https://muxup.com/2025q2/recommended-llm-parameter-quick-reference)
and [EvalScope's Qwen3 best practices](https://evalscope.readthedocs.io/en/v0.15.1/best_practice/qwen3.html).
Qwen additionally suggests `presence_penalty` 0–2 to fight repetition (they used 1.5 for
writing benchmarks), warning that high values can cause language mixing — relevant someday,
not adopted now.

**Why greedy breaks Qwen3 specifically:** it's a hybrid *thinking* model post-trained to expect
sampling; greedy decoding puts it in a degenerate mode (repetition loops, malformed/empty
output). This is exactly what we observed: at temp 0 the failure is *deterministic* — the same
prompt shape fails the same way on every goal, every run. At temp 0.5 the old flakiness was
random; at temp 0 it became guaranteed.

## 4. The decision rule for this codebase

1. **Vendor floor first:** never temp 0 on Qwen3. "Deterministic" scenarios use the *bottom of
   the safe range*, not greedy.
2. **Task shape second:** within the safe range, structured/grading calls sit low (0.3),
   conversational teaching sits at the vendor's general-use setting (0.7).
3. **Determinism for JSON comes from the salvage layer** (`json.ts` repair/fallback parsing),
   the retry-with-nudge, and tight prompts — **not** from temp 0.
4. **`top_p` 0.8 everywhere in non-thinking mode** (vendor value); thinking mode uses 0.6/0.95.

## 5. The per-scenario table (as implemented)

| Scenario | Call labels | temp | top_p | Why |
|---|---|---|---|---|
| **Planning / decomposition** | `decompose:expand*`, `decompose:refine` | **0.3** | 0.8 | JSON with one right shape → low; >0 because greedy degenerates (§3). This is the fix for the trigger incident. |
| **Grading** | `assess`, `assess:retry` | **0.3** | 0.8 | Binary verdict, wants reproducibility; same greedy floor. |
| **Sync audit** | `sync`, `sync:retry` | **0.3** | 0.8 | Evidence-quoting JSON; also keeps its 512-token budget. |
| **Teaching prose** | `teach`, lesson wrap-up (`complete`) | **0.7** | 0.8 | Vendor general-use setting for non-thinking mode; teaching needs natural, varied phrasing. |
| **Compliance retries** | `teach:retry`, `teach:no-praise` | **0.3** | 0.8 | A retry exists because the model ignored an instruction — sharpen toward compliance, still not greedy. |
| **Quick-reply suggestions** | `suggestions` | **0.7** | 0.8 | Short student-voice replies; variety is the point, parsing is line-based and tolerant. |
| **Thinking mode (flag on)** | all of the above defaults | 0.6 base | 0.95 | Vendor thinking-mode numbers; per-call overrides still apply. |

Defaults live in the **model-quirks seam** (`src/llm/quirks.ts`) — they are a property of the
model family, not of the engine. Per-scenario overrides ride `GenOptions`
(`temperature`, `topP`, `maxTokens`) at each call site.

## 6. What we deliberately did NOT adopt

- **`presence_penalty` 1.5** — vendor uses it for creative benchmarks; our replies are 1–4
  sentences, repetition-within-reply isn't our failure mode. Revisit if loops appear at 0.7.
- **temp 0 anywhere** — see §3. If a future model family tolerates greedy, its quirks object
  can set that; the engine code stays untouched.
- **Per-call `top_k`/`min_p`** — not exposed by WebLLM 0.2.84's request API.

## 7. Verification signals

- Decompose on the "Booleans / equality vs identity" lesson should again produce >2 milestones
  with no `:retry` entries on most runs (dev panel → LLM CALLS).
- If `expand` retries persist at 0.3, the next suspect is the prompt, not the temperature —
  check the raw response in the dev panel before touching sampling again.
