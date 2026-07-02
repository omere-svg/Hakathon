# Loading-Screen Micro-Game — filling the "cold start" dead time

**Status:** proposal / recommendation. No code written yet.
**Date:** 2026-07-01
**Owner question:** *"present a fun short interactive game while the local model and the first
message load. Easy to implement or importable — NOT my main focus."*

---

## 0. What we're actually covering (the two dead-time phases)

In [`LessonPage.tsx`](../../maestro-open/src/pages/LessonPage.tsx) there are **two** distinct waits,
and the game must cover both:

1. **Model download + WebGPU init** — `status === 'loading'`, driven by `loadNote` progress text.
   First visit this is the big one: pulling a 1–3B model into the browser cache can be **tens of
   seconds to a couple of minutes** on a cold cache / weak connection. Subsequent visits are fast
   (cached), so the game must **auto-dismiss instantly** when loading is quick.
2. **First-turn decomposition** — `busy === true` after `status` flips to `ready`. The milestone
   engine runs a *recursive* decomposition (up to 12 model calls, see `decompose.ts`) before the
   opening line appears. On a slow on-device model this alone can be **5–20s** of a bare typing dot.

Today both phases show only a `loadNote` string or a three-dot typing indicator. That's the
opportunity: turn the most fragile moment (first impression, nothing on screen) into something alive.

> **Constraint that rules out the lazy option:** Maestro Open's whole pitch is *"runs privately on
> your device, no servers, $0, data never leaves the device."* So **do NOT `iframe` a remotely-hosted
> game** — it needs network, can fail offline, and contradicts the story on the very screen where we
> make that promise. The game must be **bundled and dependency-free**.

---

## 1. Design constraints (so it stays "not the main focus")

- **Zero/near-zero deps.** Pure React + a `<canvas>` or divs. No game engine, no styled-components.
  (`react-game-engine` and `react-loading-screen` exist but drag in deps and are overkill — see
  sources.) A classic canvas game is ~100–200 lines and vendored as a single component.
- **Non-blocking & interruptible.** It's an *overlay*, not a gate. The instant the model is ready
  **and** the first turn has landed, it yields. Never make the learner "finish" to proceed.
- **Cheap to abandon.** No score persistence, no leaderboards, no assets to load (assets would add
  their own loading wait — ironic). Draw everything in code.
- **Respects the brand.** Calm, on-theme, dismissible. A "Skip" affordance always visible.
- **Works with no input device assumptions.** Tap/click or arrow keys; mobile-friendly (Maestro
  targets phones too — see `mobile-device-strategy.md`).

---

## 2. Options, ranked

### Option A — Bundled zero-dependency canvas mini-game *(recommended default)*
A single classic game vendored as one component (`<LoadingGame />`), shown as an overlay during
`loading || busy`, auto-dismissed on ready.

Best candidates (all trivially reimplementable, MIT-ish, no assets):
- **2048** — grid + swipe/arrow, ~150 lines, satisfying, pauses/resumes cleanly, mobile-friendly.
- **Snake** — canvas + tick loop, ~100 lines, universally understood.
- **Flappy-style one-tap** — smallest input surface, great on mobile, ~120 lines.

**Why recommended:** genuinely fun, reusable across every lesson, no lesson-specific authoring, and
small enough to never become "the focus." 2048 is the top pick — it's turn-based (no reflex
pressure while someone actually wants to start learning) and trivially pausable.

### Option B — On-brand "warm-up card" *(recommended if you want it to earn its keep)*
Instead of an arcade game, a **1–3 question topic warm-up** tied to the lesson. For the current
`whileLoopLesson` that's e.g. *"What does this loop print?"* with 3 tap options and instant feedback.

**Why it's compelling:** it's on-brand (a *tutoring* app), primes prior knowledge (a real
learning-science win — activating schema before instruction improves encoding), and it's even
*easier* to build than a game (just buttons + a reveal). Downside: it's lesson-specific content to
author, and it blurs into "the lesson" rather than feeling like a playful break.

### Option C — Ambient/generative toy (no win/lose)
A calming interactive visual — particles that follow the cursor, a Conway's Game of Life grid, a
little synth pad. ~50 lines, impossible to "lose," nothing to explain.

**Why consider:** lowest effort, zero rules to teach, on-theme for a "thinking…" moment. Downside:
less *fun*, more screensaver; won't hold attention for a 60s cold download.

### Option D — Import a library (`react-game-engine`, hosted HTML5 packs)
**Not recommended.** Adds dependencies/bundle weight for a throwaway feature, and hosted packs break
the offline/privacy story. Only revisit if you want many rotating games later.

---

## 3. Recommendation

**Ship Option A (2048 or Snake) as a dismissible loading overlay.** It's the best
effort-to-payoff: one self-contained file, no deps, no assets, reusable for every lesson, and it
directly rescues the worst UX moment (cold model download) without you having to think about it again.

If you have 30 spare minutes and want the dead time to *also* teach, do **Option B** and make the
warm-up feed the engine — e.g. a correct warm-up answer could be passed to the milestone engine's
Sync as early evidence (a nice bonus, not required).

**Concrete integration sketch (no code yet):**
- New `components/LoadingGame.tsx` — self-contained, `<canvas>`-based, own `requestAnimationFrame`
  loop, cleaned up on unmount.
- In `LessonPage`, render it as an overlay while `status === 'loading' || busy` during the intro
  turn. Keep the real `loadNote`/progress visible in a corner so the learner still sees "almost
  ready." Add a persistent **Skip** button.
- Auto-unmount the overlay when the first tutor message is set (dismiss the moment there's something
  real to do). Fast cached loads → the overlay barely flashes, which is correct.

**Effort:** ~half a day for Option A, less for B. No new dependencies. Isolated file — won't touch
the engine or risk the demo.

---

## Sources
- [react-game-engine (GitHub)](https://github.com/bberak/react-game-engine) — shows why a full engine is overkill for this.
- [react-loading-screen (GitHub)](https://github.com/mslavan/react-loading-screen) — pulls in styled-components; illustrative, not adopted.
- [Open-source HTML5 games list (edopedia)](https://www.edopedia.com/blog/open-source-html5-and-javascript-games/) — sources for a vendorable Snake/2048/Flappy.
- [Using React in web games (LogRocket)](https://blog.logrocket.com/using-react-web-games/) — canvas-in-React patterns and the RAF-loop cleanup gotcha.
- Cross-ref: [`mobile-device-strategy.md`](mobile-device-strategy.md) (mobile input), [`webllm-research.md`](webllm-research.md) (why the first-load download is slow).
</content>
</invoke>
