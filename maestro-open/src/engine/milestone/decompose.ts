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
// The recursion is bounded on three axes so a small/erratic model can never run away:
//   maxDepth  — hard cap on how deep we split (deepest nodes are forced to be leaves),
//   maxLeaves — soft budget; once reached, remaining nodes stop splitting,
//   maxCalls  — hard cap on total model calls across the whole decomposition.
// Any model/parse failure at a node degrades gracefully: that node becomes a leaf.

import type { LessonBrief, LlmCall } from '../api';
import type { LLMEngine } from '../../llm/types';
import { extractJson, parseStringList } from './json';
import { expandPrompt, refinePrompt } from './prompts';
import type { Milestone } from './types';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

export interface DecomposeLimits {
  maxDepth: number;
  maxLeaves: number;
  maxCalls: number;
  minSubGoals: number;
  maxSubGoals: number;
}

export const DEFAULT_LIMITS: DecomposeLimits = {
  maxDepth: 3,
  maxLeaves: 8,
  maxCalls: 12,
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

/** Result of a decomposition run — the final milestones plus a trace for the dev panel. */
export interface DecomposeResult {
  milestones: Milestone[];
  stats: { rawLeaves: number; leaves: number; calls: number; maxDepthReached: number; refined: boolean };
  /** every model call this run made (expand ×N + the refine pass), for the dev "LLM calls" panel. */
  calls: LlmCall[];
}

class RecursiveDecomposer {
  private calls = 0;
  private leaves = 0;
  private maxDepthReached = 0;
  private refined = false;
  private readonly log: LlmCall[] = [];

  constructor(private readonly llm: LLMEngine, private readonly limits: DecomposeLimits) {}

  /** One model call, recorded for the dev panel. */
  private async complete(label: string, system: string, user: string): Promise<string> {
    const t0 = now();
    const response = await this.llm.complete(system, user);
    this.log.push({ label, system, user, response, ms: now() - t0 });
    return response;
  }

  async run(brief: LessonBrief): Promise<DecomposeResult> {
    const goals = brief.goals.length
      ? brief.goals
      : [{ id: 'g1', statement: brief.title, reference: undefined }];
    // Each top-level Mastery Goal is a recursion root; the authored order is the tree order.
    const roots: TreeNode[] = goals.map((g) => ({
      title: g.statement.slice(0, 60),
      description: g.reference ? `${g.statement} — ${g.reference}` : g.statement,
      children: [],
    }));
    for (const root of roots) await this.expand(root, 0, brief.title);

    const leaves = roots.flatMap((r) => flatten(r));
    const rawLeaves = leaves.length;
    let milestones: Milestone[] = leaves.map((n, i) => ({
      id: `m${i + 1}`,
      title: n.title,
      description: n.description,
      status: 'pending',
      context: [],
    }));

    // Consolidation pass: merge duplicates / drop redundancy / reorder by dependency.
    milestones = await this.refine(brief, milestones);

    return {
      milestones,
      stats: { rawLeaves, leaves: milestones.length, calls: this.calls, maxDepthReached: this.maxDepthReached, refined: this.refined },
      calls: this.log,
    };
  }

  /** One extra model call that cleans up the raw draft into a final, ordered, de-duplicated
   *  plan. Falls back to the draft unchanged if the model can't produce a usable list. */
  private async refine(brief: LessonBrief, draft: Milestone[]): Promise<Milestone[]> {
    if (draft.length < 2) return draft;
    this.calls++;
    try {
      const goals = brief.goals.length ? brief.goals.map((g) => g.statement) : [brief.title];
      const p = refinePrompt(goals, draft.map((m) => m.description || m.title));
      const raw = await this.complete('decompose:refine', p.system, p.user);
      const items = parseStringList(raw).slice(0, this.limits.maxLeaves);
      if (items.length >= 2) {
        this.refined = true;
        return items.map((t, i) => ({
          id: `m${i + 1}`,
          title: t.length > 60 ? `${t.slice(0, 59)}…` : t,
          description: t,
          status: 'pending',
          context: [],
        }));
      }
    } catch {
      /* keep the draft as-is */
    }
    return draft;
  }

  private async expand(node: TreeNode, depth: number, lessonTitle: string): Promise<void> {
    this.maxDepthReached = Math.max(this.maxDepthReached, depth);
    const canSplit = depth < this.limits.maxDepth && this.leaves < this.limits.maxLeaves && this.calls < this.limits.maxCalls;
    if (canSplit) {
      const subs = await this.askSplit(node, depth, lessonTitle);
      if (subs.length >= this.limits.minSubGoals) {
        node.children = subs.slice(0, this.limits.maxSubGoals).map((s) => ({
          title: s.title,
          description: s.description,
          children: [],
        }));
        for (const child of node.children) await this.expand(child, depth + 1, lessonTitle);
        return;
      }
    }
    // Atomic (or budget-capped): this node is a leaf.
    this.leaves++;
  }

  /** Ask the model to split one goal, or signal atomic. Returns [] to mean "leaf". */
  private async askSplit(node: TreeNode, depth: number, lessonTitle: string): Promise<SubGoal[]> {
    this.calls++;
    try {
      const p = expandPrompt(lessonTitle, node.description, depth, this.limits.maxDepth);
      const raw = await this.complete(`decompose:expand@d${depth}`, p.system, p.user);
      const parsed = extractJson<{ atomic?: unknown; subGoals?: unknown }>(raw);
      if (!parsed || parsed.atomic === true) return [];
      const arr = Array.isArray(parsed.subGoals) ? parsed.subGoals : [];
      return arr.map(normalizeSub).filter((s): s is SubGoal => s !== null);
    } catch {
      return [];
    }
  }
}

function normalizeSub(raw: unknown): SubGoal | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { title?: unknown; description?: unknown };
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const description = typeof r.description === 'string' ? r.description.trim() : '';
  if (!title && !description) return null;
  return { title: title || description.slice(0, 48), description: description || title };
}

function flatten(node: TreeNode): TreeNode[] {
  return node.children.length ? node.children.flatMap(flatten) : [node];
}

/** Recursively decompose a lesson brief into a flat, ordered list of micro-milestones. */
export async function decomposeRecursive(
  brief: LessonBrief,
  llm: LLMEngine,
  limits: DecomposeLimits = DEFAULT_LIMITS,
): Promise<DecomposeResult> {
  return new RecursiveDecomposer(llm, limits).run(brief);
}
