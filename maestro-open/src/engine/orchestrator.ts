import type { Lesson } from '../domain/schema';
import { getKc, nextKcId } from '../domain/schema';
import type { LessonMemory } from '../memory/types';
import { clamp01, kcState, type StudentModel } from '../student/model';
import { compute } from '../tools/calculator';
import type { LLMEngine } from '../llm/types';
import { readCues, type Cues } from './cues';
import { gradeActive, type Grading } from './grade';
import { buildCorrectionPrompt, buildEnginePrompt, buildRawPrompt, buildSituation, label, renderStructured, type Situation } from './situation';
import { type ConstraintCheck, evaluateChecks, guard, verify } from './verify';
import { getFlags } from '../config/features';

/** Tunable engine behavior. Defaults come from feature flags; the benchmark page
 *  passes explicit overrides to compare configurations (e.g. best-of-1 vs best-of-3). */
export interface EngineConfig {
  structuredOutput: boolean;
  bestOfN: number;
  repair: boolean;
  exemplars: boolean;
  prefixCache: boolean;
}

export function resolveConfig(override?: Partial<EngineConfig>): EngineConfig {
  const f = getFlags();
  return {
    structuredOutput: f.structuredOutput,
    bestOfN: f.bestOfN,
    repair: f.repair,
    exemplars: f.exemplars,
    prefixCache: f.prefixCache,
    ...override,
  };
}

// LLM-first tutoring engine: the model drafts EVERY reply; deterministic tools + the
// verifier keep it correct on the failure modes; the model is re-prompted when a
// critical check fails; the guard() scrub gives a structural guarantee for C1 (name)
// and C2 (no answer leak). There is NO template fallback — what you see is the model.
// An on-device model is REQUIRED; callers must ensure one is loaded (WebGPU).

export type TurnMode = 'engine' | 'raw';

export interface RunTurnArgs {
  lesson: Lesson;
  lessonMem: LessonMemory;
  student: StudentModel;
  studentMessage: string;
  mode: TurnMode;
  llm: LLMEngine;
  /** override engine behavior for this turn (benchmark uses this); defaults from flags */
  config?: Partial<EngineConfig>;
}

export interface TurnResult {
  output: string;
  act: { type: string } | null;
  checks: ConstraintCheck[];
  repairs: string[];
  student: StudentModel;
  lessonMem: LessonMemory;
}

const MAX_REPAIRS = 2;

export async function runTurn(args: RunTurnArgs): Promise<TurnResult> {
  const { lesson, studentMessage, mode, llm } = args;
  let mem: LessonMemory = { ...args.lessonMem, transcript: [...(args.lessonMem.transcript ?? [])] };
  let student = cloneStudent(args.student);

  const cues = readCues(studentMessage, !!mem.activeCheckId);
  if (cues.preferredName) student = withPreference(student, cues);

  const grading = gradeActive(lesson, mem, cues, studentMessage);
  ({ student, mem } = applyState(lesson, mem, student, cues, grading));

  const facts = compute(studentMessage);
  const s = buildSituation(lesson, mem, student, cues, grading, facts);

  const repairs: string[] = [];
  let output: string;

  if (mode === 'raw') {
    // Control: the SAME model with a bare prompt and no engine — the unguarded baseline.
    output = await plain(llm, buildRawPrompt(s, studentMessage, mem.transcript));
  } else {
    const cfg = resolveConfig(args.config);
    const opts = { exemplars: cfg.exemplars, structured: cfg.structuredOutput && !!llm.completeStructured };
    const base = buildEnginePrompt(s, studentMessage, mem.transcript, opts);

    // Best-of-N: sample candidates, let the deterministic verifier pick the first clean one.
    output = await bestOf(llm, base, s, cfg);
    let violations = verify(output, s);

    // Repair: re-prompt the model with a precise correction. Honest: no template swap.
    let tries = 0;
    while (violations.length && cfg.repair && tries < MAX_REPAIRS) {
      repairs.push(...violations.map((v) => v.id));
      output = await draftOnce(llm, buildCorrectionPrompt(base, violations.map((v) => v.correction)), cfg);
      violations = verify(output, s);
      tries++;
    }

    // Structural guarantee (C1/C2 only): scrub a rejected name or a leaked answer from
    // the model's OWN text. This redacts tokens — it never writes a canned reply.
    const g = guard(output, s);
    output = g.output;
    repairs.push(...g.repairs);

    ({ student, mem } = commit(lesson, mem, student, s, grading));
  }

  if (studentMessage.trim()) mem.transcript.push({ id: `t${mem.transcript.length}`, role: 'student', text: studentMessage });
  mem.transcript.push({ id: `t${mem.transcript.length}`, role: 'tutor', text: output });
  mem.transcript = mem.transcript.slice(-8);

  const checks = evaluateChecks(output, s);
  return { output, act: { type: label(s) }, checks, repairs, student, lessonMem: mem };
}

// ── helpers ──
type Prompt = { system: string; user: string };

/** Free-text draft (used by the raw control). */
async function plain(llm: LLMEngine, p: Prompt): Promise<string> {
  if (!llm.onDevice) throw new Error('Maestro Open requires an on-device model (WebGPU).');
  return (await llm.complete(p.system, p.user)).trim();
}

/** One engine draft — structured (JSON-mode) when enabled & supported, else free-text. */
async function draftOnce(llm: LLMEngine, p: Prompt, cfg: EngineConfig): Promise<string> {
  if (!llm.onDevice) throw new Error('Maestro Open requires an on-device model (WebGPU).');
  if (cfg.structuredOutput && llm.completeStructured) {
    const obj = await llm.completeStructured(p.system, p.user);
    const text = obj ? renderStructured(obj) : '';
    if (text) return text;
    // fall through to free-text if JSON was empty/unparseable
  }
  return (await llm.complete(p.system, p.user)).trim();
}

/** Best-of-N: generate N candidates, return the first that passes verification. */
async function bestOf(llm: LLMEngine, p: Prompt, s: Situation, cfg: EngineConfig): Promise<string> {
  const n = Math.max(1, Math.floor(cfg.bestOfN));
  if (n === 1) return draftOnce(llm, p, cfg);
  const cands = await Promise.all(Array.from({ length: n }, () => draftOnce(llm, p, cfg).catch(() => '')));
  const clean = cands.find((c) => c && verify(c, s).length === 0);
  return clean ?? cands.find(Boolean) ?? draftOnce(llm, p, cfg);
}

function cloneStudent(s: StudentModel): StudentModel {
  return {
    preferences: { ...s.preferences, rejectedNames: [...s.preferences.rejectedNames] },
    knowledge: { ...s.knowledge },
    misconceptions: { ...s.misconceptions },
    affect: { ...s.affect },
  };
}

function withPreference(s: StudentModel, cues: Cues): StudentModel {
  const out = cloneStudent(s);
  if (cues.preferredName) out.preferences.preferredName = cues.preferredName;
  if (cues.rejectedName && !out.preferences.rejectedNames.includes(cues.rejectedName)) {
    out.preferences.rejectedNames.push(cues.rejectedName);
  }
  return out;
}

function applyState(lesson: Lesson, mem0: LessonMemory, student0: StudentModel, cues: Cues, grading: Grading | null): { student: StudentModel; mem: LessonMemory } {
  const student = cloneStudent(student0);
  const mem: LessonMemory = { ...mem0 };

  if (cues.distress) student.affect.frustration = Math.max(student.affect.frustration, 0.8);

  if (grading) {
    const kc = getKc(lesson, mem.currentKcId);
    if (kc) {
      const prev = kcState(student, kc.id);
      const attempts = prev.attempts + 1;
      const correct = prev.correct + (grading.correct ? 1 : 0);
      if (grading.correct) {
        student.affect.confidence = clamp01(student.affect.confidence + 0.15);
        student.affect.frustration = clamp01(student.affect.frustration - 0.2);
        for (const [id, m] of Object.entries(student.misconceptions)) {
          if (m.kcId === kc.id && m.active) student.misconceptions[id] = { ...m, active: false };
        }
      } else if (grading.gradeable) {
        student.affect.confidence = clamp01(student.affect.confidence - 0.1);
        student.affect.frustration = clamp01(student.affect.frustration + 0.2);
        if (grading.matchedMisconception) {
          const cur = student.misconceptions[grading.matchedMisconception];
          student.misconceptions[grading.matchedMisconception] = { kcId: kc.id, count: (cur?.count ?? 0) + 1, active: true };
        }
      }
      student.knowledge[kc.id] = {
        ...prev,
        attempts,
        correct,
        mastery: clamp01(correct / Math.max(1, kc.masteryCriteria.minCorrect)),
        lastSeen: attempts,
        status: correct >= kc.masteryCriteria.minCorrect ? 'mastered' : 'learning',
      };
      mem.lastGrading = { gradeable: grading.gradeable, correct: grading.correct, matchedMisconception: grading.matchedMisconception };
    }
  } else {
    mem.lastGrading = undefined;
  }
  return { student, mem };
}

function commit(lesson: Lesson, mem0: LessonMemory, student0: StudentModel, s: Situation, grading: Grading | null): { student: StudentModel; mem: LessonMemory } {
  const student = cloneStudent(student0);
  const mem: LessonMemory = { ...mem0 };
  const kc = s.kc;
  if (!kc) return { student, mem };

  if (!s.explained && !s.cues.distress) {
    student.knowledge[kc.id] = { ...kcState(student, kc.id), explained: true };
    if (!mem.activeCheckId) mem.activeCheckId = kc.checks[0]?.id;
    mem.phase = 'check';
  }
  if (label(s) === 'HINT') {
    student.knowledge[kc.id] = { ...kcState(student, kc.id), hintsUsed: kcState(student, kc.id).hintsUsed + 1 };
  }
  if (grading?.correct && s.mastered) {
    const next = nextKcId(lesson, kc.id);
    if (next) {
      mem.currentKcId = next;
      student.knowledge[next] = { ...kcState(student, next), explained: true };
      mem.activeCheckId = getKc(lesson, next)?.checks[0]?.id;
      mem.phase = 'teach';
    } else {
      mem.phase = 'complete';
    }
  }
  return { student, mem };
}
