import { initStudentModel, type StudentModel } from '../student/model';
import { initLessonMemory, type LessonMemory } from '../memory/types';
import { runTurn } from '../engine/orchestrator';
import type { ConstraintCheck } from '../engine/constraints';
import type { LLMEngine } from '../llm/types';
import { scenarios, type EvalScenario } from './scenarios';

export interface ModeResult {
  output: string;
  act: string | null;
  checks: ConstraintCheck[];
  passed: boolean;
  /** wall-clock for the turn (ms) — for the benchmark page */
  ms: number;
  /** number of repair/scrub actions taken */
  repairs: number;
}

export interface ScenarioResult {
  scenario: EvalScenario;
  engine: ModeResult; // full LLM-first engine (verify/repair)
  raw: ModeResult; // control: the SAME model with no engine / no guardrails
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// A scenario passes iff its headline constraint check passed (and no other critical
// check failed). Keyed on the scenario's constraintId so it's not gameable by adding checks.
function passedFor(scenario: EvalScenario, checks: ConstraintCheck[]): boolean {
  const headline = checks.find((c) => c.id === scenario.constraintId);
  const criticalsOk = checks.filter((c) => c.critical).every((c) => c.passed);
  return !!headline && headline.passed && criticalsOk;
}

function freshState(s: EvalScenario): { student: StudentModel; mem: LessonMemory } {
  const student = initStudentModel();
  const mem = initLessonMemory(s.lesson.id, s.lesson.knowledgeComponents[0].id);
  s.setup(student, mem);
  return { student, mem };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export async function runScenario(s: EvalScenario, llm: LLMEngine): Promise<ScenarioResult> {
  const e = freshState(s);
  const r = freshState(s);

  const t0 = now();
  const engine = await runTurn({ lesson: s.lesson, lessonMem: clone(e.mem), student: clone(e.student), studentMessage: s.probe, mode: 'engine', llm });
  const engineMs = now() - t0;

  const t1 = now();
  const raw = await runTurn({ lesson: s.lesson, lessonMem: clone(r.mem), student: clone(r.student), studentMessage: s.probe, mode: 'raw', llm });
  const rawMs = now() - t1;

  return {
    scenario: s,
    engine: { output: engine.output, act: engine.act?.type ?? null, checks: engine.checks, passed: passedFor(s, engine.checks), ms: engineMs, repairs: engine.repairs.length },
    raw: { output: raw.output, act: raw.act?.type ?? null, checks: raw.checks, passed: passedFor(s, raw.checks), ms: rawMs, repairs: raw.repairs.length },
  };
}

/** Proof of performance: run the SAME on-device model WITH the engine vs WITHOUT it. */
export async function runAllScenarios(llm: LLMEngine): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const s of scenarios) out.push(await runScenario(s, llm)); // sequential: one model, avoid contention
  return out;
}
