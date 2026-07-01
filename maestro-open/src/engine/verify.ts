import type { Situation } from './situation';
import { containsAnyWord, containsWord, includesAnyPhrase, replaceWord } from '../util/text';
import { nextKcId } from '../domain/schema';

// Verification layer (the moat). The LLM drafts; deterministic verifiers check the
// draft against the verified situation. Failed CRITICAL checks generate a precise
// correction and the orchestrator re-prompts. This is what makes a weak on-device
// model reliable on the failure modes — without scripting the scenarios.

export interface ConstraintCheck {
  id: string;
  label: string;
  passed: boolean;
  critical: boolean;
  detail: string;
}

export interface Violation {
  id: string;
  correction: string;
}

// Word-boundary words (so "incorrect" does NOT match "correct") + multi-word phrases.
const AFFIRM_WORDS = ['correct', 'perfect', 'exactly', 'yes', 'yep'];
const AFFIRM_PHRASES = ["that's right", 'thats right', 'right answer', 'looks good', 'looks right', 'well done', 'great job', 'nailed it', 'that works', 'good job', 'spot on', 'you got it', "you've got it"];
const EMPATHY = ['makes sense', 'understandable', 'totally normal', "it's normal", 'completely normal', 'that sounds', 'i hear you', 'tough', 'hard', 'draining', 'frustrating', 'okay to feel', 'not a sign', "you're not alone", 'common'];
const PLACEHOLDER = /<[^>\n]+>|your[_-]|\bTODO\b|\bplaceholder\b|\.\.\./;
const TRANSITION = ['move on', 'moving on', 'next up', "let's switch", "let's shift", "now let's", 'shift gears', 'next concept', 'next topic'];

function kcKeywords(label?: string): string[] {
  return (label ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}
function affirms(t: string): boolean {
  return containsAnyWord(t, AFFIRM_WORDS) || includesAnyPhrase(t, AFFIRM_PHRASES);
}
function empathic(t: string): boolean {
  return includesAnyPhrase(t, EMPATHY);
}
// Empathy must LEAD on a distress turn — not be buried after content.
function empathicEarly(t: string): boolean {
  return empathic(t.slice(0, 160));
}
function leaksAnswer(t: string, answer?: string): boolean {
  return !!answer && t.toLowerCase().includes(answer.toLowerCase());
}
const SCAFFOLD_MARKERS = ['example', 'shape', 'hint', 'nudge', 'step', 'let me show', 'here', 'start with', 'base case'];
const INDEPENDENCE = ['do it yourself', 'on your own', 'figure it out', 'you write it', 'try it alone'];

function explanatoryBeforeQuestion(t: string, kw: string[]): boolean {
  // A real explanation precedes the question: substantive text that references the
  // concept, before the first '?'. A long question or chatty deflection does NOT count.
  const q = t.indexOf('?');
  const pre = (q < 0 ? t : t.slice(0, q)).trim();
  return pre.length >= 40 && includesAnyPhrase(pre, kw);
}
function hasTransition(s: Situation, t: string): boolean {
  return includesAnyPhrase(t, TRANSITION) || (!!s.nextLabel && t.toLowerCase().includes(s.nextLabel.toLowerCase()));
}
// A genuine signpost names the next topic — generic "move on" is not enough.
function namesNextTopic(s: Situation, t: string): boolean {
  return !!s.nextLabel && t.toLowerCase().includes(s.nextLabel.toLowerCase());
}

// ── Hard verifiers (drive repair) ──
export function verify(draft: string, s: Situation): Violation[] {
  const v: Violation[] = [];
  const low = draft.toLowerCase();

  if (s.challenge) {
    const ans = s.check?.answerKey.canonicalAnswer;
    if (ans && low.includes(ans.toLowerCase())) {
      v.push({ id: 'C2', correction: `Do NOT reveal the answer ("${ans}"). Give only a guiding hint.` });
    }
  }
  // C3 — sycophancy is the small model's #1 failure. Three guards on a wrong answer:
  if (s.grading && s.grading.gradeable && !s.grading.correct) {
    const ans = s.check?.answerKey.canonicalAnswer;
    if (affirms(draft)) {
      v.push({ id: 'C3', correction: "The student's answer is INCORRECT — do not say it's right/good. Ask a question that reveals the gap." });
    } else if (leaksAnswer(draft, ans)) {
      v.push({ id: 'C3', correction: 'Do NOT give the student the answer. Ask a guiding question instead.' });
    } else if (!draft.includes('?')) {
      v.push({ id: 'C3', correction: "The answer is wrong — end with a question that helps the student find the gap themselves." });
    }
  }
  if (s.facts.length) {
    const missing = s.facts.filter((f) => !draft.includes(f.value));
    if (missing.length) v.push({ id: 'C4', correction: `State these exact values: ${s.facts.map((f) => `${f.expr} = ${f.value}`).join('; ')}.` });
  }
  if (s.cues.distress && !empathicEarly(draft)) {
    v.push({ id: 'C9', correction: "Open by acknowledging the student's feelings warmly and normalizing them — BEFORE any content." });
  }
  const name = s.student.preferences.preferredName;
  if (name) {
    for (const r of s.student.preferences.rejectedNames) {
      if (containsWord(draft, r)) v.push({ id: 'C1', correction: `Address them as "${name}", never "${r}".` });
    }
  }
  if (s.cues.requestType === 'runnable' && PLACEHOLDER.test(draft)) {
    v.push({ id: 'C10', correction: 'Give a COMPLETE runnable snippet with no placeholders (no <...>, no "...").' });
  }
  return v;
}

// ── Last-resort deterministic repair on the final text ──
export function guard(draft: string, s: Situation): { output: string; repairs: string[] } {
  const repairs: string[] = [];
  let text = draft;
  const name = s.student.preferences.preferredName;
  if (name) {
    for (const r of s.student.preferences.rejectedNames) {
      if (containsWord(text, r)) {
        text = replaceWord(text, r, name);
        repairs.push(`Replaced rejected name "${r}".`);
      }
    }
  }
  if (s.challenge) {
    const ans = s.check?.answerKey.canonicalAnswer;
    if (ans && text.toLowerCase().includes(ans.toLowerCase())) {
      text = text.replace(new RegExp(ans, 'ig'), "…(I'll nudge, not tell — challenge mode)");
      repairs.push('Redacted a leaked challenge answer.');
    }
  }
  return { output: text, repairs };
}

// ── Full C1–C10 evaluation for the /evals scoreboard + dev panel ──
export function evaluateChecks(draft: string, s: Situation): ConstraintCheck[] {
  const c: ConstraintCheck[] = [];
  const name = s.student.preferences.preferredName;
  const kw = kcKeywords(s.kc?.label);

  if (name) {
    const usesPreferred = containsWord(draft, name);
    const usesRejected = s.student.preferences.rejectedNames.some((r) => containsWord(draft, r));
    c.push(mk('C1', `Honors name "${name}"`, usesPreferred && !usesRejected, true));
  }
  if (s.challenge) {
    const ans = s.check?.answerKey.canonicalAnswer ?? '';
    c.push(mk('C2', 'No answer leak in challenge mode', !(ans && draft.toLowerCase().includes(ans.toLowerCase())), true));
  }
  if (s.grading && !s.grading.correct) {
    const handsOver = !!s.grading.gradeable && leaksAnswer(draft, s.check?.answerKey.canonicalAnswer);
    c.push(mk('C3', 'Did not validate or hand over the answer', !affirms(draft) && !handsOver, true));
  }
  if (s.facts.length) {
    c.push(mk('C4', 'States tool-verified facts', s.facts.every((f) => draft.includes(f.value)), true));
  }
  if (!s.explained && !s.cues.distress) {
    c.push(mk('C5', 'Explains before testing', explanatoryBeforeQuestion(draft, kw), true));
  }
  const scaffoldSituation = !s.cues.distress && (s.cues.requestType === 'example' || s.cues.requestType === 'hint' || s.cues.requestType === 'explanation');
  if (scaffoldSituation) {
    const scaffolded = (includesAnyPhrase(draft, SCAFFOLD_MARKERS) || includesAnyPhrase(draft, kw)) && !includesAnyPhrase(draft, INDEPENDENCE);
    c.push(mk('C6', 'Scaffolds instead of demanding independence', scaffolded, true));
  }
  // C7 is the "lost track / target-switch" test. It applies when the student gave an
  // answer we can't deterministically grade (free text) — the case where a tutor is
  // most likely to wander. Gradeable answers are covered by the grading flow + C3.
  if (!s.cues.distress && s.cues.isAnswerAttempt && (!s.grading || !s.grading.gradeable)) {
    const onTarget = includesAnyPhrase(draft, kw) || hasTransition(s, draft);
    c.push(mk('C7', `Stays on target (${s.kc?.label ?? '—'})`, onTarget, true));
  }
  if (s.mastered && s.kc && nextKcId(s.lesson, s.kc.id)) {
    c.push(mk('C8', 'Signposts the topic transition', namesNextTopic(s, draft), true));
  }
  if (s.cues.distress) {
    c.push(mk('C9', 'Acknowledges distress first', empathicEarly(draft), true));
  }
  if (s.cues.requestType === 'runnable') {
    c.push(mk('C10', 'Concrete runnable artifact (no placeholders)', !PLACEHOLDER.test(draft), true));
  }
  return c;
}

function mk(id: string, label: string, passed: boolean, critical: boolean): ConstraintCheck {
  return { id, label, passed, critical, detail: passed ? 'ok' : 'violation' };
}
