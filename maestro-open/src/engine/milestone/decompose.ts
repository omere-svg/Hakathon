// Recursive decomposition — the init strategy for the MilestoneQueue.
//
// Instead of one flat "list the milestones" call, we build a tree: start from each top-level
// Mastery Goal, ask the local model to either declare it atomic (teachable + checkable in one
// ~3-5 minute turn) or split it into 2-3 smaller ordered sub-goals, and recurse on the splits.
// The leaves of the tree — flattened left-to-right, preserving goal order — become the queue.
//
// Why: each milestone the engine then teaches/assesses is micro-sized and strictly scoped,
// which keeps the model's per-milestone context tiny and makes assessment far more reliable.
//
// Decomposition is deliberately UNMETERED on model calls (product ruling 2026-07-04): it is
// the most important stage and may be slow. The recursion is still bounded on two axes so an
// erratic model can never run away:
//   maxDepth  — hard cap on how deep we split (deepest nodes are forced to be leaves),
//   maxLeaves — soft budget; once reached, remaining nodes stop splitting.
// Any model/parse failure at a node degrades gracefully: that node becomes a leaf.
//
// COVERAGE is guaranteed in layers (a real plan silently lost a whole mastery goal to the
// old global refine pass):
//   1. provenance — every step knows which goal it came from; merging absorbs provenance;
//   2. per-goal refine — consolidation runs inside each goal, so it can never drop ACROSS goals;
//   3. deterministic backstop — a goal with zero surviving steps gets its statement re-appended;
//   4. coverage audit — the model ENUMERATES each goal's requirements; a requirement no step
//      matches (deterministic stemmed overlap) is re-appended as its own step.

import type { LessonBrief, LlmCall, MasteryGoal } from '../api';
import type { GenOptions, LLMEngine } from '../../llm/types';
import { mentionsOtherLanguage } from './rails';
import { extractJson, parseStringList } from './json';
import { classifyPrompt, coveragePrompt, expandPrompt, refinePrompt } from './prompts';
import {
  contentWords,
  jaccard,
  NEAR_DUPLICATE,
  overlapRatio,
  sharesContent,
  stemmedOverlapRatio,
  verbMaskedJaccard,
  WORD_SET_MATCH,
} from './overlap';
import type { Milestone } from './types';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

/** Decomposition is a planning/JSON phase — low temperature, but NEVER 0: Qwen3 forbids
 *  greedy decoding (at temp 0 every expand call failed identically and the plan collapsed
 *  to the raw goals). Determinism comes from the salvage parser + retry, not from greedy.
 *  See knowledge base 05-research/temperature-per-scenario.md.
 *  maxTokens bounds fine-tune degeneration (a coverage call emitted the same line ~24
 *  times over 12.7s live); a correct split/refine/enumeration is well under 320 tokens,
 *  and truncated JSON is still salvaged by closeTruncated. */
const PLAN_OPTS: GenOptions = { temperature: 0.3, topP: 0.8, maxTokens: 320 };

/** Appended to a user prompt on the single retry after an unparseable JSON reply. */
const JSON_NUDGE = '\n\nIMPORTANT: Respond with ONLY the JSON object — no prose, no explanation, no code fences.';

/** Covered-threshold for CLAUSE fallback candidates in the coverage audit. Looser than
 *  NEAR_DUPLICATE because a statement clause naturally shares only part of its wording
 *  with the step that teaches it ("running total correctly inside a loop" vs "modify the
 *  running total variable within the loop" scores 0.6) — while a genuinely lost half
 *  ("Verify mutual exclusivity" vs condition-listing steps) scores ~0. */
const CLAUSE_COVERED = 0.5;

export interface DecomposeLimits {
  maxDepth: number;
  maxLeaves: number;
  minSubGoals: number;
  maxSubGoals: number;
}

export const DEFAULT_LIMITS: DecomposeLimits = {
  /** 2, not 3: in two consecutive live traces every useful step existed by depth 1 —
   *  everything below was rephrase, lesson-title bleed, or model confusion. */
  maxDepth: 2,
  maxLeaves: 8,
  minSubGoals: 2,
  maxSubGoals: 3,
};

interface TreeNode {
  title: string;
  description: string;
  children: TreeNode[];
}

interface SubGoal {
  title: string;
  description: string;
}

/** One step of the plan under construction, with the goal(s) it descends from — the
 *  provenance that makes "refine dropped a goal" detectable and repairable. */
interface Step {
  text: string;
  goalIds: Set<string>;
}

/** Result of a decomposition run — the final milestones plus a trace for the dev panel. */
export interface DecomposeResult {
  milestones: Milestone[];
  stats: {
    rawLeaves: number;
    leaves: number;
    calls: number;
    maxDepthReached: number;
    refined: boolean;
    /** goal statements re-appended by the backstop / coverage audit (0 = plan was complete). */
    appended: number;
  };
  /** every model call this run made (expand ×N + refines + coverage), for the dev "LLM calls" panel. */
  calls: LlmCall[];
}

class RecursiveDecomposer {
  private calls = 0;
  private leaves = 0;
  private maxDepthReached = 0;
  private refined = false;
  private appended = 0;
  /** the lesson's programming language — sub-goals naming a DIFFERENT one are rejected. */
  private language = '';
  private readonly log: LlmCall[] = [];

  constructor(private readonly llm: LLMEngine, private readonly limits: DecomposeLimits) {}

  /** One model call, recorded for the dev panel. */
  private async complete(label: string, system: string, user: string): Promise<string> {
    this.calls++;
    const t0 = now();
    const response = await this.llm.complete(system, user, PLAN_OPTS);
    this.log.push({ label, system, user, response, ms: now() - t0 });
    return response;
  }

  async run(brief: LessonBrief): Promise<DecomposeResult> {
    this.language = brief.language ?? '';
    const goals: MasteryGoal[] = brief.goals.length
      ? brief.goals.map((g, i) => ({ ...g, id: g.id || `g${i + 1}` }))
      : [{ id: 'g1', statement: brief.title, reference: undefined }];

    // Each top-level Mastery Goal is a recursion root; the authored order is the tree order.
    const roots = goals.map((g) => ({
      goal: g,
      node: {
        title: g.statement.slice(0, 60),
        description: g.reference ? `${g.statement} — ${g.reference}` : g.statement,
        children: [],
      } as TreeNode,
    }));
    for (const r of roots) await this.expand(r.node, 0, brief.title);

    // Per-goal consolidation: refine runs INSIDE each goal, so it can drop/merge redundant
    // steps of that goal but can never drop a different goal's material.
    let rawLeaves = 0;
    let steps: Step[] = [];
    for (const r of roots) {
      const goalLeaves = flatten(r.node).map(({ leaf, parent }) =>
        contextualizeLeaf(leaf.description || leaf.title, parent?.description ?? ''),
      );
      rawLeaves += goalLeaves.length;
      const refined = await this.refineGoal(r.goal, goalLeaves);
      // Normalization runs on the FINAL text (refine can strip formatting or reintroduce
      // spec-voice too): planner language out, author backticks back in.
      for (const text of refined) {
        steps.push({
          text: inheritBackticks(stripSpecVoice(text), r.goal.statement),
          goalIds: new Set([r.goal.id]),
        });
      }
    }

    // Deterministic near-dupe merge across the whole plan (the surviving step absorbs the
    // merged step's provenance, so no goal loses its trace to a merge).
    steps = mergeNearDuplicates(steps);

    // Deterministic backstop: a goal with zero surviving steps gets its statement back.
    for (const g of goals) {
      if (!steps.some((s) => s.goalIds.has(g.id))) {
        steps.push({ text: g.statement, goalIds: new Set([g.id]) });
        this.appended++;
      }
    }

    // Model-side coverage audit — catches partial loss the provenance layer can't see
    // (a goal that kept SOME steps but lost a distinct part of what it asked for).
    await this.auditCoverage(goals, steps);

    const milestones: Milestone[] = steps.map((s, i) => ({
      id: `m${i + 1}`,
      title: s.text.length > 60 ? `${s.text.slice(0, 59)}…` : s.text,
      description: s.text,
      status: 'pending',
      context: [],
    }));

    return {
      milestones,
      stats: {
        rawLeaves,
        leaves: milestones.length,
        calls: this.calls,
        maxDepthReached: this.maxDepthReached,
        refined: this.refined,
        appended: this.appended,
      },
      calls: this.log,
    };
  }

  /** Consolidate ONE goal's raw leaves into its final steps. Falls back to the draft
   *  unchanged if the model can't produce a usable list.
   *  Drafts of ≤2 steps skip the model call entirely: the only legitimate refine action
   *  at that size is merging true duplicates, which the deterministic merge already does —
   *  and a live 2-step draft (range(stop) + range(step)) came back as 1, silently deleting
   *  a variant. The third recorded refine deletion; small drafts are pure downside. */
  private async refineGoal(goal: MasteryGoal, draft: string[]): Promise<string[]> {
    if (draft.length <= 2) return draft;
    try {
      const p = refinePrompt([goal.statement], draft);
      const raw = await this.complete(`decompose:refine@${goal.id}`, p.system, p.user);
      // Hard cap at draft+1: refine may consolidate freely and add AT MOST one step (the
      // "missing goal content" capstone that has rescued coverage twice) — a 2-step draft
      // coming back as 5 was padding, not planning (observed live). Output is
      // dependency-ordered, so truncating the tail is safe.
      const items = parseStringList(raw).slice(0, Math.min(this.limits.maxLeaves, draft.length + 1));
      // Consolidating to ONE step is legitimate (the draft was all near-dupes) — but only
      // when that line visibly derives from the draft; an unrelated single line is refusal
      // prose ("nope"), not a consolidation.
      const usable =
        items.length >= 2 || (items.length === 1 && draft.some((d) => overlapRatio(items[0], d) > 0));
      if (usable) {
        this.refined = true;
        return items;
      }
    } catch {
      /* keep the draft as-is */
    }
    return draft;
  }

  /** Coverage audit, one call PER goal — ENUMERATE-then-MATCH. The previous yes/no audit
   *  ("do the steps cover everything?") rubber-stamped a live plan that had lost "update
   *  the counter inside the loop": a 1-2B model biased toward "covered: true" approves
   *  almost anything. Now the model only ENUMERATES what the goal requires (the task it is
   *  reliably good at) and the covered/uncovered decision is DETERMINISTIC — a requirement
   *  that matches no step (stemmed overlap, so "initialize" ≈ "initial value") is appended
   *  as its own step. Gates against a chatty enumerator: line shape (8-200 chars, ≤15
   *  words), must share content with the goal (not invented), must not already match a
   *  step, at most 3 appends per goal. Best-effort throughout: any failure changes nothing. */
  private async auditCoverage(goals: MasteryGoal[], steps: Step[]): Promise<void> {
    for (const goal of goals) {
      // A goal whose milestone IS its own statement lost nothing in decomposition — the
      // audit could only produce rephrasings of it (live: a fine-tune degeneration loop
      // emitted 24 of them over 12.7s and one shipped as a junk milestone). Skip both
      // the call and the risk; the audit still guards every goal that was actually split.
      if (steps.some((s) => s.goalIds.has(goal.id) && s.text === goal.statement)) continue;
      try {
        const p = coveragePrompt({ id: goal.id, statement: goal.statement });
        const raw = await this.complete(`decompose:coverage@${goal.id}`, p.system, p.user);
        // The model sometimes glues all requirements onto ONE line separated by periods
        // (live: "Write … range(stop). Write … range(start, stop). Write …" — 24 words, so
        // the prose gate discarded ALL of it and the lost variants stayed lost). A long
        // line that splits into sentences is a glued list, not prose — gate the pieces.
        const shaped = parseStringList(raw)
          .flatMap((l) =>
            l.split(/\s+/).length > 15 ? l.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean) : [l],
          )
          .slice(0, 8)
          .filter((l) => l.length >= 8 && l.length <= 200 && l.split(/\s+/).length <= 15);
        // FALLBACK NET (decision-tables trace): when the enumerator yields nothing usable,
        // derive candidates DETERMINISTICALLY from the goal statement's own clauses — the
        // "verify mutual exclusivity" half of a multi-part goal must not depend on the
        // model remembering to enumerate it. Only multi-part statements (≥2 raw clauses);
        // only substantial clauses (≥3 content words); matched at a looser threshold
        // because clause wording naturally diverges from step wording.
        let candidates = shaped;
        let clauseFallback = false;
        if (!shaped.length) {
          const clauses = goalClauses(goal.statement);
          if (clauses.length >= 2) {
            candidates = clauses.filter((c) => contentWords(c).size >= 3);
            clauseFallback = true;
          }
        }
        const coveredAt = clauseFallback ? CLAUSE_COVERED : NEAR_DUPLICATE;
        let appendedForGoal = 0;
        for (const req of candidates) {
          if (appendedForGoal >= 3) break; // goals legitimately require up to ~3 things
          if (!sharesContent(req, goal.statement)) continue; // invented, not from this goal
          if (steps.some((s) => stemmedOverlapRatio(req, s.text) >= coveredAt)) continue; // covered
          steps.push({
            text: inheritBackticks(stripSpecVoice(req), goal.statement),
            goalIds: new Set([goal.id]),
          });
          this.appended++;
          appendedForGoal++;
        }
      } catch {
        /* coverage audit is a safety net, never a blocker */
      }
    }
  }

  private async expand(node: TreeNode, depth: number, lessonTitle: string): Promise<void> {
    this.maxDepthReached = Math.max(this.maxDepthReached, depth);
    const canSplit =
      depth < this.limits.maxDepth &&
      this.leaves < this.limits.maxLeaves &&
      // Deterministic pre-gate, depth 1+ ONLY: prompt-side depth bias provably doesn't
      // move this model (three attempts, 0/3 deep ATOMIC verdicts), and deep splits are
      // where content gets lost. Authored depth-0 goals ALWAYS get the model classify.
      !(depth >= 1 && isSelfEvidentLeaf(node.description));
    if (canSplit) {
      const subs = await this.askSplit(node, depth, lessonTitle);
      if (subs.length > this.limits.maxSubGoals) {
        // OVER-SPLIT: the model ignored "2 or 3" and returned more, finer-grained sub-goals.
        // Slicing to maxSubGoals provably deletes curriculum — a live 6-way split of
        // "initialize and update a counter and running total" lost both "update … inside
        // the loop" halves (the core of the lesson) to the old slice(0, 3). An over-split's
        // sub-goals are already micro-steps, so keep them ALL (leaf-budget bounded) as
        // LEAVES: no recursion on them, no truncation.
        const budget = Math.max(this.limits.maxSubGoals, this.limits.maxLeaves - this.leaves);
        node.children = subs.slice(0, budget).map((s) => ({
          title: s.title,
          description: s.description,
          children: [],
        }));
        this.leaves += node.children.length;
        return;
      }
      if (subs.length >= this.limits.minSubGoals) {
        node.children = subs.map((s) => ({
          title: s.title,
          description: s.description,
          children: [],
        }));
        for (const child of node.children) await this.expand(child, depth + 1, lessonTitle);
        return;
      }
    }
    // Atomic (or leaf-budget-capped): this node is a leaf.
    this.leaves++;
  }

  /** Ask the model about one goal, in TWO steps. Returns [] to mean "leaf".
   *
   *  Step 1 — classify: a one-word ATOMIC/SPLIT binary with symmetric framing. Separated
   *  from the split so the "decompose" task framing can't bias the judgment (combined-prompt
   *  traces: 0/15 atomic). Anything that isn't an unambiguous SPLIT is a leaf.
   *
   *  Step 2 — split (only after a SPLIT verdict), with two bounded repair retries:
   *  - no recoverable JSON at all → one JSON-only nudge (otherwise an intermittently-flaky
   *    model yields an unpredictable mix of micro and macro milestones);
   *  - a non-atomic answer left with fewer than minSubGoals REAL sub-goals — either the model
   *    returned one (a rephrase), or its sub-goals restated the parent and were rejected by
   *    the overlap rail → one corrective ask for a genuine 2-3 split. Still under-split after
   *    the retry → leaf. */
  private async askSplit(node: TreeNode, depth: number, lessonTitle: string): Promise<SubGoal[]> {
    try {
      const c = classifyPrompt(lessonTitle, node.description, depth, this.limits.maxDepth);
      const verdict = await this.complete(`decompose:classify@d${depth}`, c.system, c.user);
      if (!isSplitVerdict(verdict)) return [];

      const p = expandPrompt(node.description);
      let raw = await this.complete(`decompose:expand@d${depth}`, p.system, p.user);
      let subs = parseSplit(raw);
      if (subs === null) {
        raw = await this.complete(`decompose:expand@d${depth}:retry`, p.system, p.user + JSON_NUDGE);
        subs = parseSplit(raw);
      }
      subs = subs ?? [];
      const claimedSplit = subs.length > 0;
      subs = rejectParentRephrase(node.description, subs);
      // Foreign-language drift (harness iter2): "Explain what `is` does in JavaScript"
      // emitted for a Python lesson. Rejecting it makes the answer under-split, so the
      // normal corrective-retry → leaf fallback keeps the goal whole instead.
      if (this.language) {
        subs = subs.filter((s) => !mentionsOtherLanguage(`${s.title} ${s.description}`, this.language));
      }
      if (claimedSplit && subs.length < this.limits.minSubGoals) {
        raw = await this.complete(
          `decompose:expand@d${depth}:fix`,
          p.system,
          p.user +
            '\n\nYour previous answer marked this goal as NOT atomic but did not give 2 or 3 GENUINELY ' +
            'smaller sub-goals — an answer with only ONE sub-goal, or sub-goals that merely restate the ' +
            'goal in other words, is invalid. Return {"atomic": false, "subGoals": [...]} with 2 or 3 ' +
            'strictly ordered sub-goals that are each clearly smaller than the goal, or {"atomic": true} ' +
            'if it truly cannot be split.',
        );
        subs = rejectParentRephrase(node.description, parseSplit(raw) ?? []);
        if (this.language) {
          subs = subs.filter((s) => !mentionsOtherLanguage(`${s.title} ${s.description}`, this.language));
        }
        if (subs.length < this.limits.minSubGoals) return [];
      }
      return subs;
    } catch {
      return [];
    }
  }
}

/** Deterministic leaf pre-gate for model-produced goals (depth 1+). A goal is a
 *  self-evident leaf only when it is short AND SPECIFIC:
 *  - single clause — no "and", no comma/semicolon list, at most one sentence;
 *  - at most 9 non-numeric words — not a bundle. Digit tokens don't count: numbers add
 *    specificity, never breadth ("create a range of even numbers from 0 to 10" is ONE
 *    teachable idea; counting "0"/"10" pushed it over the cap live and the model then
 *    "split" it into per-number garbage — "a range that includes 0" shipped as a milestone);
 *  - at least 4 content words — the specificity floor. Short-but-VAGUE goals
 *    ("Learn Python fundamentals": 3 content words) fail it and still go to the model,
 *    so a broad goal can never be leaf'd by the heuristic; a missed gate costs one
 *    cheap classify call, a wrong gate would cost lesson quality — the asymmetry is
 *    deliberately conservative. */
export function isSelfEvidentLeaf(description: string): boolean {
  const text = description.trim();
  // Two known ONE-concept patterns that contain a literal "and" (each cost ~4 wasted calls
  // live): a backticked code-literal pair (`True` and `False`) and a "between X and Y"
  // comparison. Neutralize them before the conjunction test; everything else about the
  // gate still runs on the original text.
  const neutralized = text
    .replace(/`[^`]+`\s+and\s+`[^`]+`/gi, 'PAIR')
    .replace(/\bbetween\s+\S+\s+and\s+\S+/gi, 'BETWEEN-PAIR');
  if (/\band\b/i.test(neutralized)) return false;
  if (/[,;]/.test(text)) return false;
  if ((text.match(/[.!?]/g) ?? []).length > 1) return false;
  const nonNumericWords = text
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^\d+$/.test(w.replace(/[^a-z0-9]/gi, '')));
  if (nonNumericWords.length > 9) return false;
  return contentWords(text).size >= 4;
}

/** Interpret the one-word classify answer. Only an unambiguous SPLIT proceeds to the split
 *  call — a garbled answer, both words, or neither means leaf (the conservative default,
 *  consistent with every other decompose failure path). Also tolerates the model answering
 *  with the old JSON shape ({"atomic": false} counts as SPLIT). */
export function isSplitVerdict(raw: string): boolean {
  const json = extractJson<{ atomic?: unknown }>(raw);
  if (json && typeof json.atomic === 'boolean') return !json.atomic;
  const saysAtomic = /\batomic\b/i.test(raw);
  const saysSplit = /\bsplit\b/i.test(raw);
  return saysSplit && !saysAtomic;
}

/** Parse one expand answer.
 *  - SubGoal[] with items → a split to recurse on;
 *  - []                   → a leaf (explicit atomic, or a parsed answer with nothing usable);
 *  - null                 → nothing recoverable at all (worth one JSON-only retry).
 *  Strict JSON alone loses most real splits: the model's characteristic failures are
 *  DUPLICATE "subGoals" keys (JSON.parse silently keeps only the last one) and naked
 *  arrays between items (invalid JSON entirely) — in both, the sub-goals themselves are
 *  fine. So whenever strict parsing yields fewer than 2, harvest every flat
 *  {"title", "description"} object straight from the raw text. */
function parseSplit(raw: string): SubGoal[] | null {
  const parsed = extractJson<{ atomic?: unknown; subGoals?: unknown }>(raw);
  if (parsed && parsed.atomic === true) return [];
  const arr = parsed && Array.isArray(parsed.subGoals) ? parsed.subGoals : [];
  let subs = arr.map(normalizeSub).filter((s): s is SubGoal => s !== null);
  if (subs.length < 2) {
    const harvested = harvestSubGoals(raw);
    if (harvested.length > subs.length) subs = harvested;
  }
  if (subs.length) return dedupeSubGoals(subs);
  return parsed ? [] : null;
}

/** A "sub-goal" that near-verbatim restates its parent is not a split — recursing on it
 *  re-decomposes the same goal one level deeper (observed live: "Define what a `while` loop
 *  is" returned as its own child). Drop those before counting the split. Jaccard, not
 *  containment: a short child inside a long parent is a NARROWER goal, which is exactly
 *  what a split should produce.
 *  The TITLE check runs at the STRICT tier: titles are compressed summaries that naturally
 *  resemble the parent — "Verify mutual exclusivity of conditions" under "Verify mutual
 *  exclusivity and completeness of the conditions" scored exactly 0.80 live and a
 *  legitimate split was vetoed. Only a verbatim-ish title (the trace-3 failure) rejects. */
function rejectParentRephrase(parentDescription: string, subs: SubGoal[]): SubGoal[] {
  return subs.filter(
    (s) =>
      jaccard(s.description, parentDescription) < NEAR_DUPLICATE &&
      jaccard(s.title, parentDescription) < WORD_SET_MATCH,
  );
}

/** Merge final steps that say the same thing in near-identical words (the per-goal refine
 *  cannot see across goals, and the model loops sometimes). First occurrence wins its spot;
 *  the survivor absorbs the merged step's goal provenance.
 *  STRICT word-set tier, same as sub-goal dedupe: containment here re-collapsed the
 *  progressive range() steps that dedupe had just been fixed to preserve — a wordwise
 *  subset can be a legitimate earlier step in a progression, not a duplicate. Every merge
 *  this pass has correctly made live was an identical-set pair (jaccard 1.0).
 *  PLUS the verb-masked tier: the counters trace shipped "create a variable named counter
 *  and assign it a initial value" AND "assign an initial value to the counter variable"
 *  as two milestones (jaccard 0.71 — under every plain tier), and the student answered
 *  the same trivial question twice. Same nouns + swapped setup verbs = one step. */
function mergeNearDuplicates(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    const twin = out.find(
      (s) =>
        jaccard(s.text, step.text) >= WORD_SET_MATCH ||
        verbMaskedJaccard(s.text, step.text) >= NEAR_DUPLICATE,
    );
    if (twin) {
      for (const id of step.goalIds) twin.goalIds.add(id);
    } else {
      out.push(step);
    }
  }
  return out;
}

/** Pull every flat {"title": …, "description": …} object out of free text, ignoring the
 *  surrounding structure. Sub-goal objects are flat (no nesting), so a no-inner-braces
 *  match is safe; each fragment still goes through extractJson for quote/key repair.
 *  Pre-normalization for the single most frequent malformation across every live trace:
 *  a sub-goal closed with `"]]` / `"]` junk instead of `"}` (once even joined by a
 *  full-width ，). In a FLAT object a `]` glued to the closing quote is never legal, so
 *  rewriting it to `"}` is safe — a correct `and`/`or`/`not` split was produced three
 *  times in one run and lost to exactly this shape every time. */
function harvestSubGoals(text: string): SubGoal[] {
  const normalized = text.replace(/，/g, ',').replace(/"(?:\s*\])+/g, '"}');
  const out: SubGoal[] = [];
  for (const fragment of normalized.match(/\{[^{}]*"description"[^{}]*\}/g) ?? []) {
    const sub = normalizeSub(extractJson(fragment));
    if (sub) out.push(sub);
  }
  return out;
}

/** Drop repeated sub-goals (the model loops sometimes). Same content-word set = same goal,
 *  whatever the order: word-swapped duplicates ("difference between assignment and equality"
 *  / "…equality and assignment") spawned two parallel subtrees for one idea (~6 wasted
 *  calls). Jaccard at the STRICT tier, not containment — containment destroyed the model's
 *  best-ever split (range(stop) ⊂ range(start, stop) ⊂ range(start, stop, step): progressive
 *  variants whose descriptions are wordwise supersets of each other, NOT duplicates).
 *  PLUS the verb-masked tier for the counters-trace failure: "define" and "declare" halves
 *  that are one step with the setup verb swapped (see verbMaskedJaccard for its guards —
 *  it returns 0 for the range() and `and`/`or` shapes, so those still survive). */
function dedupeSubGoals(subs: SubGoal[]): SubGoal[] {
  const kept: SubGoal[] = [];
  for (const s of subs) {
    const dup = kept.some(
      (k) =>
        k.description.toLowerCase() === s.description.toLowerCase() ||
        jaccard(k.description, s.description) >= WORD_SET_MATCH ||
        verbMaskedJaccard(k.description, s.description) >= NEAR_DUPLICATE,
    );
    if (!dup) kept.push(s);
  }
  return kept;
}

/** The model sometimes copies the prompt's template placeholders verbatim — those are
 *  not content. A placeholder title falls back to the description; a placeholder
 *  description voids the field. */
const PLACEHOLDER = /^<?\s*(?:3-6 words|what to demonstrate)\s*>?$/i;

function normalizeSub(raw: unknown): SubGoal | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { title?: unknown; description?: unknown };
  let title = typeof r.title === 'string' ? stripSpecVoice(r.title.trim()) : '';
  let description = typeof r.description === 'string' ? stripSpecVoice(r.description.trim()) : '';
  if (PLACEHOLDER.test(title)) title = '';
  if (PLACEHOLDER.test(description)) description = '';
  if (!title && !description) return null;
  return { title: title || description.slice(0, 48), description: description || title };
}

/** Leaves with the parent they hang from — the parent is what anchors an unanchored leaf. */
interface FlatLeaf {
  leaf: TreeNode;
  parent?: TreeNode;
}

function flatten(node: TreeNode, parent?: TreeNode): FlatLeaf[] {
  return node.children.length
    ? node.children.flatMap((c) => flatten(c, node))
    : [{ leaf: node, parent }];
}

/** Strip planner SPEC-VOICE from step text. The decision-tables trace shipped a milestone
 *  reading "The student must identify and explain the conditions." — requirement language
 *  that then rendered as "The student should be able to: The student must identify…" in
 *  every teach/assess prompt. Longest alternatives first so "should be able to" is eaten
 *  whole. Falls back to the original if stripping leaves nothing usable. */
const SPEC_VOICE =
  /^\s*the\s+(?:student|learner)\s+(?:should\s+be\s+able\s+to|is\s+able\s+to|needs?\s+to|has\s+to|must|should|will|can)\s+/i;

export function stripSpecVoice(text: string): string {
  const stripped = text.replace(SPEC_VOICE, '').trim();
  return stripped.length >= 4 ? stripped : text;
}

/** The clauses of a goal statement, split on connective boundaries (comma/semicolon/bare
 *  "and"), with backticked spans protected (`and` the operator is not a connective).
 *  Raw pieces, trimmed — the caller decides quality. Used by the coverage FALLBACK net. */
export function goalClauses(statement: string): string[] {
  const pieces: string[] = [];
  let buf = '';
  for (const seg of statement.split(/(`[^`]*`)/g)) {
    if (seg.startsWith('`')) {
      buf += seg;
      continue;
    }
    const parts = seg.split(/[,;]|\band\b/i);
    for (let i = 0; i < parts.length; i++) {
      buf += parts[i];
      if (i < parts.length - 1) {
        pieces.push(buf);
        buf = '';
      }
    }
  }
  pieces.push(buf);
  return pieces.map((p) => p.replace(/^[\s.,;]+|[\s.,;]+$/g, '')).filter(Boolean);
}

/** Re-wrap author-backticked code tokens the split model emitted bare. The booleans trace:
 *  the goal says "Use `True` and `False` in expressions…" but the milestone came out as
 *  "Compute the result of True and False in a boolean expression" — without the backticks
 *  the teach model read "True and False" as prose (two values) instead of code (one
 *  expression) and asked about "this expression" without ever showing one.
 *  SAFE SCOPE: only tokens that cannot be English prose — containing an uppercase letter,
 *  a digit, or a symbol (True, False, ==, range(stop)). Lowercase code words (`is`, `and`)
 *  stay unwrapped: they appear as ordinary prose everywhere and wrapping them would corrupt
 *  the text. Existing backticked spans are left untouched (no double-wrapping). */
export function inheritBackticks(text: string, source: string): string {
  const tokens = new Set<string>();
  for (const m of source.matchAll(/`([^`]+)`/g)) {
    const tok = m[1].trim();
    if (tok && (/[A-Z0-9]/.test(tok) || /[^a-zA-Z\s]/.test(tok))) tokens.add(tok);
  }
  if (!tokens.size) return text;
  // Process only the segments OUTSIDE existing backtick spans.
  return text
    .split(/(`[^`]*`)/g)
    .map((seg) => {
      if (seg.startsWith('`')) return seg;
      let out = seg;
      for (const tok of tokens) {
        const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Word-ish boundaries that also work for symbol tokens like `==`.
        out = out.replace(new RegExp(`(?<![\\w\`])${esc}(?![\\w\`])`, 'g'), `\`${tok}\``);
      }
      return out;
    })
    .join('');
}

/** A leaf like "assign a value to the variable" (WHICH variable?) teaches and grades
 *  terribly: the tutor asks filler and the grader degrades to word-matching. The prompt-side
 *  self-contained rules are the first defense; this deterministic backstop anchors what
 *  slips through by suffixing the parent goal. Fires only when the leaf is genuinely
 *  unanchored: a bare referent AND fewer than 2 content words shared with its parent.
 *  The referent list is deliberately tight ("the loop" in a loops lesson is self-evident;
 *  a missed vague leaf costs quality, a false positive uglifies a good step). */
const BARE_REFERENT = /\bthe (?:variable|value)\b|\bit\b/i;

export function contextualizeLeaf(text: string, parentDescription: string): string {
  if (!parentDescription || !BARE_REFERENT.test(text)) return text;
  const parentWords = contentWords(parentDescription);
  let shared = 0;
  for (const w of contentWords(text)) if (parentWords.has(w)) shared++;
  if (shared >= 2) return text;
  return `${text} (for: ${parentDescription})`;
}

/** Recursively decompose a lesson brief into a flat, ordered list of micro-milestones. */
export async function decomposeRecursive(
  brief: LessonBrief,
  llm: LLMEngine,
  limits: DecomposeLimits = DEFAULT_LIMITS,
): Promise<DecomposeResult> {
  return new RecursiveDecomposer(llm, limits).run(brief);
}
