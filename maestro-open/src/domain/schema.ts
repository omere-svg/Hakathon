// Domain model — the lesson representation (ITS "domain model").
// Authored OFFLINE and shipped as static JSON. Read-only at runtime.
// Modeled on Maestro/LMS structure: Program -> Course -> Lesson -> KCs/outcomes.

export type KcId = string;
export type MisconceptionId = string;

export type CheckType = 'mcq' | 'numeric' | 'code' | 'keyword' | 'free';

export interface AnswerKey {
  mcqCorrectIndex?: number;
  /** wrong MCQ option index -> the misconception it reveals */
  mcqMisconceptionByIndex?: Record<number, MisconceptionId>;
  numericValue?: number;
  numericTolerance?: number;
  /** concepts that must be mentioned (for 'keyword' grading) */
  keywords?: string[];
  /** JS code tests: call `functionName` with args, compare JSON of result */
  functionName?: string;
  codeTests?: { args: unknown[]; expected: unknown }[];
  /** human-readable canonical answer — used ONLY by the "raw LLM" control, never by the engine's NLG */
  canonicalAnswer?: string;
}

export interface Check {
  id: string;
  prompt: string;
  type: CheckType;
  isChallenge: boolean;
  answerKey: AnswerKey;
}

export interface Misconception {
  id: MisconceptionId;
  kcId: KcId;
  description: string; // the wrong belief
  remediation: string; // CORRECT payload — a gap-revealing nudge, NOT the answer
}

/**
 * Presentation Guideline — the v2.5 "smart offline" artifact. Authored once by a big
 * model: HOW to teach this concept well. The on-device small model RENDERS this in
 * conversation instead of inventing pedagogy. See
 * 05-research/offline-to-ondevice-pipeline.md §1(b).
 */
export interface PresentationGuideline {
  /** the one sentence the student must walk away with */
  coreIdea: string;
  /** the best intuition pump */
  analogy?: string;
  /** ordered talking points: how to build the idea up (enables show-before-tell) */
  arc?: string[];
  /** the 1–2 things to stress */
  emphasize?: string[];
  /** pitfalls — what NOT to say/do (e.g. "don't mention break yet") */
  avoid?: string[];
}

export interface KnowledgeComponent {
  id: KcId;
  label: string;
  prerequisites: KcId[];
  /** authored "how to teach this" guidance the small model delivers */
  presentation?: PresentationGuideline;
  /**
   * Authored few-shot exemplars, keyed by dialogue-act label (EXPLAIN/HINT/CORRECT/…).
   * Small models imitate gold examples far better than they follow rule lists; these are
   * authored offline and injected into the prompt for the matching act. (Playbook §1.)
   */
  exemplars?: Record<string, string>;
  content: {
    explanation: string;
    analogy?: string;
    workedExample?: string;
    /** a concrete, runnable snippet (no placeholders) for "paste-and-run" requests (C10) */
    runnableArtifact?: string;
  };
  checks: Check[];
  misconceptions: Misconception[];
  hints: string[]; // ordered ladder, gentle -> specific, NONE reveal the answer
  masteryCriteria: {
    minCorrect: number;
    requireNoActiveMisconception: boolean;
  };
}

export interface ReviewQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  points: number;
}

export interface Lesson {
  id: string;
  program: string;
  course: string;
  title: string;
  topic: string;
  knowledgeComponents: KnowledgeComponent[]; // order = default curriculum sequence
  reviewQuestions: ReviewQuestion[];
}

export function getKc(lesson: Lesson, kcId: KcId): KnowledgeComponent | undefined {
  return lesson.knowledgeComponents.find((k) => k.id === kcId);
}

export function getCheck(kc: KnowledgeComponent, checkId: string): Check | undefined {
  return kc.checks.find((c) => c.id === checkId);
}

export function nextKcId(lesson: Lesson, kcId: KcId): KcId | undefined {
  const i = lesson.knowledgeComponents.findIndex((k) => k.id === kcId);
  return i >= 0 ? lesson.knowledgeComponents[i + 1]?.id : undefined;
}
