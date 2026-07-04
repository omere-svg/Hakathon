// The engine contract — one small, shared API. An engine is created from a LessonBrief (a set
// of ordered Mastery Goals) + an on-device LLM, owns all of its own state internally, and
// exposes exactly two calls: start() (the opening turn) and respond() (one student turn).
//
// The milestone engine (milestone/ — model-driven Goal→Milestone flow: decompose → loop → sync)
// is the sole implementation. The contract stays engine-agnostic so another engine could be
// added behind it (via createEngine in engine/index.ts) without touching callers.

import type { LLMEngine } from '../llm/types';

/** The atomic unit of intent: one thing the student must come to master. */
export interface MasteryGoal {
  id: string;
  /** the goal in plain language — all the milestone engine needs (it decomposes this). */
  statement: string;
  /** optional supporting material an engine may draw on when teaching. */
  reference?: string;
}

/** The complete input to any engine: metadata + an ordered list of Mastery Goals. */
export interface LessonBrief {
  id: string;
  title: string;
  program?: string;
  course?: string;
  topic?: string;
  /** the lesson's programming language (e.g. 'Python') — pins the tutor's code syntax.
   *  Without it a small model drifts into JS-flavored pseudo-code (`var result = True;`). */
  language?: string;
  /** ordered — the intended learning sequence. */
  goals: MasteryGoal[];
}

/** One entry in an engine's ordered plan (e.g. a decomposed milestone), for the dev panel. */
export interface PlanStep {
  label: string;
  state: 'pending' | 'active' | 'done';
}

/** One model call made during a turn — the exact prompt sent and the raw reply, for the
 *  dev "LLM calls" panel. Lets you see precisely what context each phase gives the model. */
export interface LlmCall {
  label: string;
  system: string;
  user: string;
  response: string;
  ms: number;
}

/** Engine-specific internals for the "Show engine" panel. Free-form key/value pairs so
 *  each engine can expose whatever state is meaningful without a shared schema. */
export interface EngineDebug {
  engine: string;
  fields: { label: string; value: string }[];
  /** an ordered plan to render prominently (milestone decomposition); dev-only. */
  steps?: PlanStep[];
  /** every model call made during this turn (prompt + response), for the dev panel. */
  calls?: LlmCall[];
}

/** Conversational quick-reply suggestions the UI renders under a tutor turn. The
 *  engine decides them so the chips always match its state; the UI just renders. */
export interface Suggestions {
  /** plain quick-reply chips (label shown, text sent). */
  quick?: { label: string; text: string }[];
}

/** Everything the UI needs to render one tutor turn. */
export interface TurnView {
  /** the tutor's reply to display. */
  reply: string;
  /** the lesson is finished — no further input expected. */
  done: boolean;
  /** short human status line for the dev bar (e.g. "Milestone 2/4 · active"). */
  status: string;
  /** quick-reply chips, resolved AFTER the reply — they cost an extra model call, and the
   *  reply must never wait on them. The UI renders the turn, then fills chips in when this
   *  settles (undefined = no chips for this turn). Never rejects. */
  suggestions?: Promise<Suggestions | undefined>;
  debug?: EngineDebug;
}

/** The interchangeable tutoring engine. Stateful instance; not safe to share across sessions. */
export interface TutorEngine {
  /** stable id, e.g. 'milestone'. */
  readonly id: string;
  /** human label for the UI. */
  readonly name: string;
  /** produce the opening turn (greet / decompose / first teaching). Call once. */
  start(): Promise<TurnView>;
  /** process one student message and return the next tutor turn. */
  respond(message: string): Promise<TurnView>;
  /** plain-data snapshot of internal state for session persistence (null = nothing yet).
   *  Pass the value back through the factory's `snapshot` param to resume. */
  serialize?(): unknown;
  /** current dev-panel view of internal state (plan steps etc.) WITHOUT running a turn —
   *  lets the UI repopulate the engine panel after restoring a saved session. Read-only. */
  debugView?(): EngineDebug;
}

export type EngineId = 'milestone';

export type EngineFactory = (brief: LessonBrief, llm: LLMEngine, snapshot?: unknown) => TutorEngine;
