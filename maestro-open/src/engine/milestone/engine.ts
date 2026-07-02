// MilestoneEngine — a standalone, model-driven tutoring engine implementing TutorEngine.
//
// The algorithm (Goal-Oriented Milestone Flow):
//   Decomposition (init): the local model breaks the lesson goal into a strictly ordered
//     MilestoneQueue.
//   Milestone Loop: for the current milestone, with STRICT context isolation (the model
//     sees only this milestone's messages):
//       Focused Assessment — "is THIS milestone achieved?"
//       Execution — if no, keep teaching this milestone; if yes, trigger the Sync.
//   Milestone Sync (cleanup): the completed milestone's transcript + the remaining list go
//     to the model, which cross-checks which remaining milestones were implicitly achieved.
//     The engine updates the queue, clears context, and advances.
//
// This engine deliberately has NO deterministic verify/guard net — the model owns
// decomposition, assessment, and cross-checking.

import type { EngineDebug, LessonBrief, LlmCall, PlanStep, Suggestions, TurnView, TutorEngine } from '../api';
import type { LLMEngine } from '../../llm/types';
import { MilestoneQueue, type Milestone } from './types';
import { extractJson, parseAchieved, parseStringList } from './json';
import { assessPrompt, completionPrompt, suggestionsPrompt, syncPrompt, teachPrompt, type MilestoneBridge } from './prompts';
import { decomposeRecursive } from './decompose';

// Fallback chips used only if the model can't produce dynamic suggestions this turn.
const QUICK_REPLIES = [
  { label: 'I understand', text: 'I understand' },
  { label: 'Explain again', text: 'Can you explain that again?' },
  { label: 'Show an example', text: 'Show me an example' },
  { label: "I'm confused", text: "I'm confused" },
];

/** Strip role-play bleed: small models sometimes echo a "Tutor:" label and then continue the
 *  whole dialogue for both sides ("… Student: … Teacher: …"). Keep only the tutor's first turn. */
function cleanReply(text: string): string {
  let t = text.trim();
  // Drop a leading self-label the model sometimes emits.
  t = t.replace(/^\s*(tutor|teacher|maestro|assistant)\s*(\([^)]*\))?\s*:\s*/i, '');
  // Cut at the first fabricated turn marker (the model impersonating another speaker).
  const m = t.match(/\b(student|teacher|tutor|user|assistant)\s*(\([^)]*\))?\s*:/i);
  if (m && m.index !== undefined && m.index > 0) t = t.slice(0, m.index);
  return t.trim();
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

export class MilestoneEngine implements TutorEngine {
  readonly id = 'milestone';
  readonly name = 'Milestone Engine';

  private queue: MilestoneQueue | null = null;
  private lastEvidence = '';
  private planNote = '';
  private suggestSource: 'dynamic' | 'fallback' = 'fallback';
  /** every model call made during the CURRENT turn (reset each start/respond), for the dev panel. */
  private turnCalls: LlmCall[] = [];

  constructor(private readonly brief: LessonBrief, private readonly llm: LLMEngine) {}

  /** One model call, recorded (label + prompt + response + latency) for the dev "LLM calls" panel. */
  private async call(label: string, system: string, user: string): Promise<string> {
    const t0 = now();
    const response = await this.llm.complete(system, user);
    this.turnCalls.push({ label, system, user, response, ms: now() - t0 });
    return response;
  }

  async start(): Promise<TurnView> {
    this.requireModel();
    this.turnCalls = [];
    const milestones = await this.decompose();
    this.queue = new MilestoneQueue(milestones);
    const reply = await this.teach(this.queue.current()!, false);
    return this.view(reply, false);
  }

  async respond(message: string): Promise<TurnView> {
    this.requireModel();
    this.turnCalls = [];
    if (!this.queue) return this.start();
    if (this.queue.isComplete()) return this.view('This lesson is complete — great work!', true);

    const current = this.queue.current()!;
    const text = message.trim();
    if (text) current.context.push({ role: 'student', text });

    // Focused assessment: is ONLY this milestone achieved?
    const assessment = await this.assess(current);
    this.lastEvidence = assessment.evidence;

    if (!assessment.achieved) {
      // Execution: keep teaching this milestone (isolated context).
      const reply = await this.teach(current, false);
      return this.view(reply, false);
    }

    // Achieved → Milestone Sync, then advance.
    this.queue.achieveCurrent();
    await this.sync(current);
    this.queue.advance();

    if (this.queue.isComplete()) {
      const reply = await this.complete();
      return this.view(reply, true);
    }
    // Hand a minimal bridge from the just-completed milestone to the next one so the
    // transition reads as one continuous conversation (see teachPrompt / MilestoneBridge).
    const reply = await this.teach(this.queue.current()!, true, this.bridgeFrom(current));
    return this.view(reply, false);
  }

  /** Compress the just-completed milestone into a tiny handoff: its topic + the student's last
   *  message. Deliberately minimal — enough for continuity, not enough to pollute the new context. */
  private bridgeFrom(completed: Milestone): MilestoneBridge {
    const lastStudent = [...completed.context].reverse().find((m) => m.role === 'student')?.text ?? '';
    return { completedTitle: completed.title, lastStudentMessage: lastStudent.slice(0, 200) };
  }

  // ── phases ────────────────────────────────────────────────────────────────────

  /** Decomposition (recursive): split each goal into micro-milestones and flatten the leaves.
   *  Falls back to the brief's own ordered goals if recursion yields nothing usable — the
   *  goals are already an ordered curriculum, so we never dead-end. */
  private async decompose(): Promise<Milestone[]> {
    try {
      const { milestones, stats, calls } = await decomposeRecursive(this.brief, this.llm);
      this.turnCalls.push(...calls); // surface decompose/refine calls in the dev panel
      if (milestones.length) {
        this.planNote =
          `recursive · ${stats.rawLeaves}→${stats.leaves} steps${stats.refined ? ' (refined)' : ''} · ` +
          `depth ${stats.maxDepthReached} · ${stats.calls} calls`;
        return milestones;
      }
    } catch {
      /* fall through to goal fallback */
    }
    this.planNote = 'goal fallback (recursion unavailable)';
    return this.goalFallback();
  }

  private goalFallback(): Milestone[] {
    const goals = this.brief.goals.length
      ? this.brief.goals
      : [{ id: 'm1', statement: this.brief.title, reference: undefined }];
    return goals.map((g, i) => ({
      id: g.id || `m${i + 1}`,
      title: g.statement.slice(0, 48),
      description: g.reference ? `${g.statement} (${g.reference})` : g.statement,
      status: 'pending' as const,
      context: [],
    }));
  }

  /** Execution: draft one teaching turn for the milestone and record it in its context. */
  private async teach(milestone: Milestone, justAdvanced: boolean, bridge?: MilestoneBridge): Promise<string> {
    const p = teachPrompt(milestone, justAdvanced, bridge);
    const reply = cleanReply(await this.call('teach', p.system, p.user));
    milestone.context.push({ role: 'tutor', text: reply });
    return reply;
  }

  /** Focused assessment of a single milestone from its isolated context. */
  private async assess(milestone: Milestone): Promise<{ achieved: boolean; evidence: string }> {
    // Nothing to grade until the student has actually said something this milestone.
    const hasStudentTurn = milestone.context.some((m) => m.role === 'student');
    if (!hasStudentTurn) return { achieved: false, evidence: 'no student input yet' };
    try {
      const p = assessPrompt(milestone);
      const raw = await this.call('assess', p.system, p.user);
      return parseAchieved(raw);
    } catch {
      return { achieved: false, evidence: 'assessment failed; continuing to teach' };
    }
  }

  /** Milestone Sync: cross-check remaining milestones for implicit achievement. */
  private async sync(completed: Milestone): Promise<void> {
    const remaining = this.queue!.remaining();
    if (!remaining.length) return;
    try {
      const p = syncPrompt(completed, remaining);
      const raw = await this.call('sync', p.system, p.user);
      const parsed = extractJson<{ alsoAchieved?: unknown }>(raw);
      const list = Array.isArray(parsed?.alsoAchieved) ? (parsed!.alsoAchieved as unknown[]) : [];
      // Only accept an implicit completion that cites a concrete piece of STUDENT evidence.
      // A bare id (or too-short evidence) is rejected — this is what kept unrelated milestones
      // from being marked "done" on topic overlap alone.
      const ids = list
        .map((e) => {
          if (!e || typeof e !== 'object') return null;
          const o = e as { id?: unknown; evidence?: unknown };
          const id = typeof o.id === 'string' ? o.id : '';
          const evidence = typeof o.evidence === 'string' ? o.evidence.trim() : '';
          return id && evidence.length >= 8 ? id : null;
        })
        .filter((x): x is string => x !== null);
      this.queue!.markAchieved(ids);
    } catch {
      /* conservative: on failure, mark nothing extra achieved */
    }
  }

  private async complete(): Promise<string> {
    try {
      const p = completionPrompt(this.brief);
      return cleanReply(await this.call('complete', p.system, p.user));
    } catch {
      return `You've completed every milestone of "${this.brief.title}" — great work!`;
    }
  }

  // ── view / debug ────────────────────────────────────────────────────────────────

  private async view(reply: string, done: boolean): Promise<TurnView> {
    const q = this.queue;
    const status = q
      ? `Milestone ${q.position()}/${q.size()}${done ? ' · complete' : ` · ${q.current()?.status ?? 'done'}`}`
      : 'Initializing…';
    const suggestions = done ? undefined : await this.suggestReplies(reply);
    return { reply, done, status, suggestions, debug: this.debug() };
  }

  /** Dynamic quick replies: after the tutor's reply, ask the model for 4 plausible student
   *  responses so the chips track the conversation. Falls back to static chips on failure. */
  private async suggestReplies(reply: string): Promise<Suggestions> {
    const title = this.queue?.current()?.title ?? this.brief.title;
    try {
      const p = suggestionsPrompt(reply, title);
      const raw = await this.call('suggestions', p.system, p.user);
      // Dedupe while preserving order; drop anything that's just the milestone echoed back.
      const seen = new Set<string>();
      const opts = parseStringList(raw)
        .filter((t) => {
          const k = t.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 4);
      if (opts.length >= 2) {
        this.suggestSource = 'dynamic';
        // Show the full suggestion — the chips are full-width and wrap; don't truncate.
        return { quick: opts.map((t) => ({ label: t, text: t })) };
      }
    } catch {
      /* fall back to static chips */
    }
    this.suggestSource = 'fallback';
    return { quick: QUICK_REPLIES };
  }

  private debug(): EngineDebug {
    const q = this.queue;
    const fields = [
      { label: 'engine', value: 'milestone (model-driven, no verify net)' },
      { label: 'plan', value: this.planNote || '—' },
      { label: 'milestone', value: q ? `${q.position()}/${q.size()}` : '—' },
      { label: 'current', value: q?.current()?.title ?? '—' },
      { label: 'suggestions', value: this.suggestSource },
    ];
    if (this.lastEvidence) fields.push({ label: 'last assessment', value: this.lastEvidence });
    // The recursive decomposition, as an ordered plan for the dev panel.
    const steps: PlanStep[] | undefined = q
      ?.all()
      .map((m) => ({
        label: m.title,
        state: m.status === 'achieved' ? 'done' : m.status === 'active' ? 'active' : 'pending',
      }));
    return { engine: this.name, fields, steps, calls: this.turnCalls };
  }

  private requireModel(): void {
    if (!this.llm.onDevice) throw new Error('Maestro Open requires an on-device model (WebGPU).');
  }
}

export function createMilestoneEngine(brief: LessonBrief, llm: LLMEngine): TutorEngine {
  return new MilestoneEngine(brief, llm);
}
