import type { Check, KnowledgeComponent, Lesson } from '../domain/schema';
import { getCheck, getKc, nextKcId } from '../domain/schema';
import type { LessonMemory, ChatMessage } from '../memory/types';
import { isMastered, kcState, type StudentModel } from '../student/model';
import type { Cues } from './cues';
import type { Grading } from './grade';
import type { Fact } from '../tools/calculator';

// The Situation is the deterministic read of "what's going on" this turn. It drives
// the prompt (the brief the LLM must follow) and the verifier. The LLM never decides
// the situation — it only renders a reply that fits it.

export interface Situation {
  lesson: Lesson;
  mem: LessonMemory;
  student: StudentModel;
  kc?: KnowledgeComponent;
  check?: Check;
  explained: boolean;
  challenge: boolean;
  mastered: boolean;
  nextLabel?: string;
  cues: Cues;
  grading: Grading | null;
  facts: Fact[];
}

export function buildSituation(
  lesson: Lesson,
  mem: LessonMemory,
  student: StudentModel,
  cues: Cues,
  grading: Grading | null,
  facts: Fact[],
): Situation {
  const kc = getKc(lesson, mem.currentKcId);
  const check = kc && mem.activeCheckId ? getCheck(kc, mem.activeCheckId) : undefined;
  const explained = kc ? kcState(student, kc.id).explained : false;
  const mastered = kc ? isMastered(student, kc.id, kc.masteryCriteria) : false;
  const next = kc ? nextKcId(lesson, kc.id) : undefined;
  return {
    lesson, mem, student, kc, check, explained,
    challenge: mem.inChallenge,
    mastered,
    nextLabel: next ? getKc(lesson, next)?.label : undefined,
    cues, grading, facts,
  };
}

const PERSONA =
  'You are Maestro, a warm, encouraging university tutor — a smart friend, not a lecturer. ' +
  'Reply in 1–4 short sentences, plain conversational text (no headings, no markdown headers). ' +
  'When teaching, end with one question. Never be condescending.';

function reference(s: Situation): string {
  if (!s.kc) return '';
  const c = s.kc.content;
  const lines = [`Concept: ${s.kc.label}`];
  // Presentation guideline (authored offline) — the small model's teaching instructions.
  const p = s.kc.presentation;
  if (p) {
    lines.push(`Core idea to land: ${p.coreIdea}`);
    if (p.analogy) lines.push(`Use this analogy: ${p.analogy}`);
    if (p.arc?.length) lines.push(`Teach in this order: ${p.arc.join(' → ')}`);
    if (p.emphasize?.length) lines.push(`Emphasize: ${p.emphasize.join('; ')}`);
    if (p.avoid?.length) lines.push(`Avoid: ${p.avoid.join('; ')}`);
  }
  lines.push(`Explanation you may draw on: ${c.explanation}`);
  if (c.analogy && !p?.analogy) lines.push(`Analogy: ${c.analogy}`);
  if (c.workedExample) lines.push(`Worked example: ${c.workedExample}`);
  if (c.runnableArtifact) lines.push(`Runnable snippet: ${c.runnableArtifact}`);
  if (s.check) lines.push(`The question to pose: ${s.check.prompt}`);
  if (s.grading?.correct && s.nextLabel) {
    const next = getKc(s.lesson, nextKcId(s.lesson, s.kc.id)!);
    if (next) lines.push(`Next concept to introduce: ${next.label} — ${next.content.explanation}`);
  }
  return lines.join('\n');
}

/** The situation brief: the instructions the tutor MUST follow this turn. */
export function brief(s: Situation): string {
  const lines: string[] = [];
  const name = s.student.preferences.preferredName;
  if (name) {
    const rej = s.student.preferences.rejectedNames;
    lines.push(`Address the student as "${name}".${rej.length ? ` Never call them ${rej.map((r) => `"${r}"`).join(' or ')}.` : ''}`);
  }

  if (s.cues.distress) {
    lines.push(
      "The student sounds distressed or about to give up. FIRST acknowledge their feelings warmly and normalize them (this is common; it is not a sign they can't do this). THEN offer one small next step. Do not jump into content.",
    );
    return lines.join('\n');
  }

  if (s.challenge) {
    lines.push('CHALLENGE MODE: do NOT reveal, state, or spell out the answer. Give only a guiding hint that makes them think.');
  }

  if (s.grading) {
    if (s.grading.correct) {
      let l = "The student's answer is CORRECT (verified by tools). Affirm it warmly and briefly.";
      if (s.mastered && s.nextLabel) l += ` They have now mastered "${s.kc?.label}". Signpost the switch and introduce "${s.nextLabel}" in one sentence.`;
      lines.push(l);
    } else if (s.grading.gradeable) {
      const misc = s.kc?.misconceptions.find((m) => m.id === s.grading?.matchedMisconception);
      lines.push(
        `The student's answer is INCORRECT (verified: ${s.grading.detail}). Do NOT say it is correct. ` +
          (misc ? `They seem to believe: "${misc.description}". Gently correct that by asking a question — ${misc.remediation}` : 'Ask a question that reveals the gap. Do not hand them the answer.'),
      );
    } else {
      lines.push(`Acknowledge their answer and keep them on "${s.kc?.label}". Probe their reasoning with a question; do not switch topics.`);
    }
  }

  if (s.facts.length) {
    lines.push(`Use these verified results EXACTLY (do not compute yourself): ${s.facts.map((f) => `${f.expr} = ${f.value}`).join('; ')}.`);
  }

  if (s.cues.requestType === 'runnable') {
    lines.push(`Give a COMPLETE runnable snippet with NO placeholders (no <...>, no "your_..."). Then ask them to run it and report what it prints.`);
  }

  if (!s.grading && !s.facts.length && s.cues.requestType !== 'runnable') {
    if (!s.explained) {
      lines.push(`This concept has not been explained yet. Briefly EXPLAIN "${s.kc?.label}" using the reference, then ask one short question. Do NOT quiz before explaining.`);
    } else if (s.cues.requestType === 'explanation' || s.cues.requestType === 'example') {
      lines.push(`Re-explain "${s.kc?.label}" simply${s.kc?.content.workedExample ? ' (use the worked example)' : ''}, then check understanding with a question.`);
    } else if (s.cues.requestType === 'hint') {
      lines.push(`Give ONE graduated hint toward "${s.kc?.label}" — never the full answer. End with a question.`);
    } else {
      lines.push(`Continue teaching "${s.kc?.label}". Keep it short and end with a question.`);
    }
  }

  return lines.join('\n');
}

export interface PromptOpts {
  /** include authored few-shot exemplar for the current act */
  exemplars?: boolean;
  /** append JSON-mode instruction (used with completeStructured) */
  structured?: boolean;
}

// JSON-mode schema described to the model. Pairs with renderStructured() below.
export const STRUCTURED_INSTRUCTION =
  'Respond ONLY as a JSON object with exactly these keys: ' +
  '{"acknowledgement": string, "body": string, "question": string}. ' +
  '"acknowledgement" may be empty. Put your explanation/hint in "body". ' +
  '"question" must be a single guiding question — and must NOT reveal any answer in challenge/hint situations.';

/** Render a structured turn object back to natural text (question last). */
export function renderStructured(obj: Record<string, unknown>): string {
  const str = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string).trim() : '');
  const head = [str('acknowledgement'), str('body')].filter(Boolean).join(' ');
  const q = str('question');
  return [head, q].filter(Boolean).join('\n\n').trim();
}

export function buildEnginePrompt(
  s: Situation,
  message: string,
  transcript: ChatMessage[],
  opts: PromptOpts = {},
): { system: string; user: string } {
  // Layout: constant prefix first (persona → reference → exemplar → structured), then
  // the per-turn brief — so a runtime KV/prefix cache can reuse the stable head.
  const parts = [PERSONA, '', 'REFERENCE (for your eyes; share only what helps):', reference(s)];
  if (opts.exemplars) {
    const ex = s.kc?.exemplars?.[label(s)];
    if (ex) parts.push('', 'EXAMPLE of a good reply of this kind (imitate the style, not the words):', ex);
  }
  if (opts.structured) parts.push('', STRUCTURED_INSTRUCTION);
  parts.push('', 'YOUR INSTRUCTIONS THIS TURN:', brief(s));
  return { system: parts.join('\n'), user: renderUser(message, transcript) };
}

// The "raw model" baseline: a plain helpful assistant with the answer key in context
// and NO guardrails — what an unguided on-device model does. Used by /evals as control.
export function buildRawPrompt(s: Situation, message: string, transcript: ChatMessage[]): { system: string; user: string } {
  const lines = ['You are a helpful tutor. Help the student with their lesson.'];
  if (s.kc) lines.push(`Concept: ${s.kc.label}. ${s.kc.content.explanation}`);
  if (s.check) lines.push(`Current question: ${s.check.prompt}`);
  if (s.check?.answerKey.canonicalAnswer) lines.push(`(The correct answer is: ${s.check.answerKey.canonicalAnswer}.)`);
  const system = lines.join('\n');
  return { system, user: renderUser(message, transcript) };
}

export function buildCorrectionPrompt(base: { system: string; user: string }, corrections: string[]): { system: string; user: string } {
  const system = `${base.system}\n\nYour previous reply broke these rules — rewrite it so it follows them:\n${corrections.map((c) => `- ${c}`).join('\n')}`;
  return { system, user: base.user };
}

function renderUser(message: string, transcript: ChatMessage[]): string {
  const recent = transcript.slice(-6).map((m) => `${m.role === 'tutor' ? 'Tutor' : 'Student'}: ${m.text}`).join('\n');
  if (!message.trim()) return `${recent ? recent + '\n' : ''}(The lesson is just starting. Greet briefly and begin.)`;
  return `${recent ? recent + '\n' : ''}Student: ${message}`;
}

/** Coarse label for the dev panel / eval badge. */
export function label(s: Situation): string {
  if (s.cues.distress) return 'COMFORT';
  if (s.challenge) return 'HINT';
  if (s.grading?.correct) return s.mastered && s.nextLabel ? 'ADVANCE' : 'ENCOURAGE';
  if (s.grading && s.grading.gradeable && !s.grading.correct) return s.grading.matchedMisconception ? 'CORRECT' : 'HINT';
  if (s.grading && !s.grading.gradeable) return 'PROBE';
  if (s.facts.length) return 'EXPLAIN';
  if (s.cues.requestType === 'runnable') return 'RUNNABLE';
  if (!s.explained) return 'EXPLAIN';
  if (s.cues.requestType === 'hint') return 'HINT';
  if (s.cues.requestType === 'explanation' || s.cues.requestType === 'example') return 'EXPLAIN';
  return 'ASK';
}
