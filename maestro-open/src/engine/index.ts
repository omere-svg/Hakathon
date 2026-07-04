// Engine registry — the single place LessonPage (or anything) picks a tutoring engine.
// Both engines implement the same TutorEngine contract and are fully interchangeable:
// same input (a LessonBrief of Mastery Goals), same two calls (start / respond), no
// shared state. Switch with the `engine` feature flag.

import type { EngineFactory, EngineId, LessonBrief, TutorEngine } from './api';
import type { LLMEngine } from '../llm/types';
import { createMilestoneEngine } from './milestone';

export * from './api';

export interface EngineInfo {
  id: EngineId;
  name: string;
  blurb: string;
  create: EngineFactory;
}

// The milestone engine is the sole tutoring engine. The registry/factory shape is kept so a
// second engine could be re-introduced behind the same TutorEngine contract without churn.
export const ENGINES: Record<EngineId, EngineInfo> = {
  milestone: {
    id: 'milestone',
    name: 'Milestone Flow',
    blurb: 'The model decomposes the goal into ordered milestones, teaches each in isolation, and self-assesses.',
    create: createMilestoneEngine,
  },
};

/** Create the selected engine for a lesson brief. `snapshot` (from engine.serialize())
 *  resumes a persisted session instead of starting fresh. */
export function createEngine(id: EngineId, brief: LessonBrief, llm: LLMEngine, snapshot?: unknown): TutorEngine {
  return (ENGINES[id] ?? ENGINES.milestone).create(brief, llm, snapshot);
}
