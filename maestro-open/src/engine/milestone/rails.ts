// Deterministic detection rails for the TutorBench failure modes a small model won't
// reliably handle on its own. Each function is a pure text classifier: the ENGINE decides
// what to do with a hit (inject a prompt instruction, regenerate, skip an attempt count).
// None of these touch model output except scrubPraise, the last-resort fallback.
//
// Failure modes covered (see 03-scenarios-and-evals):
//   SWE/BIZ-01 validated wrong work  → containsUnqualifiedPraise + scrubPraise
//   SWE/BIZ-09 emotional attunement  → detectDistress (→ empathy-first prompt note)
//   SWE/BIZ-10 preference/name miss  → detectPreferredName (→ cross-milestone store)
// (An answer-withhold rail existed briefly and was removed by product decision: when a
// student asks for the answer, the tutor should give it.)

// ── SWE/BIZ-01: unqualified praise of wrong work ─────────────────────────────────

/** Correctness-AFFIRMING praise only — "good try" acknowledges effort, not correctness,
 *  and is fine on a wrong answer. These are the tokens the scenario graders flag. */
const PRAISE = /\b(correct|exactly|perfect(?:ly)?|well done|great job|good job|nicely done|excellent|spot on|you got it|that'?s it|nailed it)\b|\b(that'?s|you'?re|you are)\s+right\b/i;

/** A negation or qualifier in the same sentence defuses the praise ("that's not correct",
 *  "close, but not quite right"). */
const QUALIFIER = /\b(not|no|never|almost|isn'?t|wasn'?t|aren'?t|but|however|except)\b|n't\b/i;

const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/);

/** Does the reply affirm correctness with no qualifier — on a turn we KNOW was wrong? */
export function containsUnqualifiedPraise(text: string): boolean {
  return sentences(text).some((s) => PRAISE.test(s) && !QUALIFIER.test(s));
}

/** Last-resort deterministic fix when a regeneration still praises: drop the praising
 *  sentences. If nothing survives, an honest generic re-engage replaces the reply. */
export function scrubPraise(text: string): string {
  const kept = sentences(text)
    .filter((s) => !(PRAISE.test(s) && !QUALIFIER.test(s)))
    .join(' ')
    .trim();
  return kept || "Not quite — let's look at this again from a different angle. Can you walk me through what you tried?";
}

// ── Trust-the-student acknowledgments ────────────────────────────────────────────
// Product ruling (2026-07-04): when the student says they understood, we TRUST them —
// the milestone is achieved without asking the grader. Deterministic on purpose: the
// grader was observed judging the same evidence differently on consecutive turns, with
// a bare "understood" as the tiebreaker. Now the rule is consistent by construction.
// Conservative scope: the WHOLE message must be acknowledgment words — "ok but why does
// it stop?" is a question, not an acknowledgment, and still goes through the grader.

const ACK_WORD =
  'ok(?:ay)?|understood|got\\s+it|i\\s+(?:get|got)\\s+it|makes\\s+sense|i\\s+understand(?:\\s+(?:it|now|this))?|understand|clear|i\\s+see|sure|yes\\s+i\\s+understand|alright|all\\s+right|thanks?|thank\\s+you|cool|great|perfect|nice';

const ACK = new RegExp(`^\\s*(?:(?:${ACK_WORD})[\\s,.!:)]*)+$`, 'i');

/** Is this message nothing but an acknowledgment of understanding ("understood", "ok got
 *  it", "makes sense, thanks")? A single trailing "?" defeats it — "understood?" is the
 *  student asking, not confirming. */
export function isAcknowledgment(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes('?')) return false;
  return ACK.test(t);
}

// ── Teach-output shape classifiers (booleans-trace rails) ────────────────────────
// The live loop: the tutor asked the same question 3× (whole-message similarity stayed
// under the rail's threshold because filler diluted it, while the QUESTION sentence was
// near-verbatim), and its attempts-3 "worked example" turn was a single question with no
// example. These classify the SHAPE of a reply; the engine decides what to do.

/** The question sentences of a reply ("…?" chunks) — the unit repetition should compare.
 *  A repeated question is a dead turn even when the surrounding prose is new. */
export function questionSentences(text: string): string[] {
  return (text.match(/[^.!?]+\?/g) ?? []).map((s) => s.trim()).filter((s) => s.length > 1);
}

/** True when EVERY sentence of the reply is a question — it explains nothing, which on a
 *  re-teach turn (the student just missed) is by construction a wasted turn. */
export function isAllQuestions(text: string): boolean {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.length > 0 && sentences.every((s) => s.endsWith('?'));
}

/** Question-shaped FILLER with no checkable answer ("What's your answer?", "What's your
 *  take on that?", "What's your first thought?"). The live pattern behind it: the model
 *  answers its own quiz question ("…if stop was 5? The numbers would be 0, 1, 2, 3, 4.")
 *  and then — forced to end with a question — appends one of these stubs. The student has
 *  nothing left to say. Deliberately tight: "What do you think the result would be?" has
 *  an object and a correct answer, so only the BARE "what do you think?" matches. */
const VACUOUS_QUESTION =
  /\bwhat(?:'s|\s+is|\s+are)\s+your\s+(?:first\s+|final\s+|initial\s+)?(?:thought|take|answer|opinion|guess|view|reaction)s?\b|\bwhat\s+do\s+you\s+think\s*\?|\bdoes\s+(?:that|this)\s+make\s+sense\b|^\s*(?:any\s+)?thoughts\s*\?\s*$/i;

export function isVacuousQuestion(question: string): boolean {
  return VACUOUS_QUESTION.test(question);
}

/** Code that is not Python, in a lesson pinned to Python (observed live:
 *  `var result = True;` — JS keyword + semicolon + Python boolean, valid in NO language).
 *  Case-sensitive keyword match on purpose: "Let me explain" must not trigger `let`.
 *  Also covers PROSE-STYLE code outside backticks (the elif trace shipped
 *  "print(...); else if num <= 10, print(...)" unbackticked and the span-only checks
 *  missed it): `else if` does not exist in Python, and `);` is a statement semicolon. */
export function looksLikeNonPythonCode(text: string): boolean {
  if (/\b(?:var|let|const)\s+[A-Za-z_$]/.test(text)) return true;
  if (/===|!==|\bconsole\.log\b/.test(text)) return true;
  if (/\belse\s+if\b/i.test(text)) return true; // Python spells it elif
  if (/\)\s*;/.test(text)) return true; // statement semicolon after a call
  if (/`[^`]*;[^`]*`/.test(text)) return true; // statement semicolons inside a code span
  // Teaching ANOTHER language by name (harness iter1: "JavaScript uses the equals sign
  // for equality" — in a Python lesson) is drift the code checks can't see.
  if (/\b(?:javascript|typescript|java\b|c\+\+|c#)/i.test(text)) return true;
  return false;
}

// ── False "infinite loop" claims (three traces) ──────────────────────────────────
// The model repeatedly calls provably terminating counter loops "infinite"/"runs
// forever". math.ts simulates the canonical shape; this detects the CLAIM.

export function claimsInfiniteLoop(text: string): boolean {
  return /\b(?:runs?\s+forever|never\s+(?:ends?|stops?|terminates?)|infinite\s+loop|loops?\s+forever|same\s+loop\s+forever|never\s+exits?)\b/i.test(text);
}

/** Last-resort deterministic fix when the regeneration STILL calls a terminating loop
 *  infinite (observed live — the model is stubbornly attached to the phrase): drop the
 *  claiming sentences, keep the rest. Mirrors scrubPraise. */
export function scrubInfiniteClaims(text: string): string {
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !claimsInfiniteLoop(s))
    .join(' ')
    .trim();
  return kept || "Let's trace your loop together — what does it print on each pass?";
}

// ── Grader self-contradiction (fine-tune trace) ──────────────────────────────────
// The fine-tuned grader once returned achieved:false with evidence arguing the opposite
// ("a valid if/elif/else chain, so the ordering is correct") — and the no-praise rail then
// forced the tutor to tell a correct student "Not quite" with invented reasoning.

/** Evidence that AFFIRMS correctness with no negation — paired with a false verdict, the
 *  grader contradicted itself and the verdict cannot be trusted to arm the wrong-answer
 *  machinery. Negators include hedges ("partially", "but") so mixed evidence is NOT
 *  flagged: only a cleanly affirmative justification counts as a contradiction. */
const EVIDENCE_AFFIRMS = /\b(correct|valid|right|accurate)\b/i;
const EVIDENCE_NEGATES =
  /\b(not|no|isn'?t|wasn'?t|wrong|incorrect|never|missing|lacks?|without|unable|didn'?t|doesn'?t|fail(?:ed|s)?|but|however|incomplete|partial(?:ly)?)\b/i;

export function contradictsVerdict(evidence: string): boolean {
  return EVIDENCE_AFFIRMS.test(evidence) && !EVIDENCE_NEGATES.test(evidence);
}

// ── Confusion statements (fine-tune trace) ───────────────────────────────────────
// "I didnt understand your question" has no question mark, so the trailing-'?' rule
// missed it: it burned an attempt and armed the wrong-answer praise guard, and the tutor
// opened with "Not quite —" at a student asking for help.

/** A confusion/clarification statement — treated exactly like a trailing-'?' question:
 *  not a wrong answer, not an attempt. */
const CONFUSION =
  /\b(?:i\s+)?(?:didn['’]?t|don['’]?t|do\s+not|did\s+not)\s+(?:understand|get|follow)\b|\bnot\s+sure\b|\bno\s+idea\b|\bi['’]?m\s+(?:so\s+|totally\s+)?confused\b|\bwhat\s+do\s+(?:you|u)\s+mean\b|\bmakes?\s+no\s+sense\b/i;

export function isConfusion(text: string): boolean {
  return CONFUSION.test(text);
}

// ── Foreign-language drift (harness iter2) ───────────────────────────────────────
// The DECOMPOSER emitted the milestone "Explain what `is` does in JavaScript" for a
// Python lesson — language drift happens at planning time, not just in teach replies.

/** Does this text name a different programming language than the lesson's? Only Python
 *  has a curated foreign list so far; other lesson languages pass everything. */
export function mentionsOtherLanguage(text: string, lessonLanguage: string): boolean {
  if (!/^python/i.test(lessonLanguage)) return false;
  return /\b(?:javascript|typescript|java|ruby|php|kotlin|swift)\b|c\+\+|c#/i.test(text);
}

// ── Assessor-voice leak (harness iter1) ──────────────────────────────────────────
// Twice in six harness conversations the tutor addressed the learner in the THIRD person
// ("the student hasn't rewritten it", "the student is just echoing it again") — the model
// copies the assessor-note register into student-facing replies.

export function talksAboutStudent(text: string): boolean {
  return /\bthe (?:student|learner)(?:'s)?\b/i.test(text);
}

// ── Clarifying vs GUESS questions (harness iter1) ────────────────────────────────
// "what do you mean?" asks for help; "is it 7?" PROPOSES an answer. Shielding every
// trailing-'?' message from the attempt counter let a flailing student take ~10 turns to
// reach the impasse cap instead of ~4 — every wrong guess ended in a question mark.

/** A question that asks for clarification/help (protected: no attempt burned) — as opposed
 *  to a guess phrased as a question (an attempt). */
export function isClarifyingQuestion(text: string): boolean {
  const t = text.trim();
  if (!/\?\s*$/.test(t)) return false;
  if (/^\s*(?:what|why|how|when|which|where|who)\b/i.test(t)) return true;
  if (/\b(?:what|why|how|which|mean|explain|again|understand|understood|repeat|clarify|help|confused)\b/i.test(t)) return true;
  return isConfusion(t);
}

// ── Code-production floor (decision-tables trace) ────────────────────────────────
// The grader marked "Translate a decision table into `if/elif/else` code" ACHIEVED on the
// student's words "stay home". A milestone that demands PRODUCING code needs a floor the
// grader cannot talk its way past: some student message must actually contain code.

/** A milestone that demands producing code: a production verb + a code noun. Deliberately
 *  narrow — "Compute the result of `True and False`" or "Identify all conditions" are
 *  conceptual and stay ungated; a wrongly-gated concept milestone would trap students.
 *  refactor/rewrite + chain/branch added after the elif trace: "Refactor a nested
 *  `if/else` into an equivalent `if/elif/else` chain." matched NEITHER list, so the
 *  show-the-source-material rule and the code floor never armed — the tutor asked an
 *  evaluate-the-output question and the student's correct answer could never satisfy
 *  the milestone. Verbless noun mentions stay ungated ("Order conditions to avoid
 *  overlaps and unreachable branches" has `branch` but no production verb). */
const PRODUCTION_VERB =
  /\b(?:writ(?:e|ing)|translat(?:e|ing)|implement(?:ing)?|creat(?:e|ing)|build(?:ing)?|convert(?:ing)?|refactor(?:ing)?|rewrit(?:e|ing)|rework(?:ing)?)\b/i;
const CODE_NOUN = /\b(?:code|program|function|loop|statement|script|snippet|chain|branch)(?:es|s)?\b/i;

export function requiresCodeProduction(milestone: string): boolean {
  return PRODUCTION_VERB.test(milestone) && CODE_NOUN.test(milestone);
}

/** Does a student message contain actual code rather than prose? Symbols that prose never
 *  has (=, :, parens, backticks), or naming at least TWO distinct code constructs. */
const CODE_KEYWORDS = /\b(?:if|elif|else|for|while|def|print|return|range)\b/g;

export function containsCodeSignal(text: string): boolean {
  if (/[=:()`]/.test(text)) return true;
  const keywords = new Set((text.match(CODE_KEYWORDS) ?? []).map((k) => k.toLowerCase()));
  return keywords.size >= 2;
}

// ── SWE/BIZ-09: emotional distress cues ──────────────────────────────────────────

const DISTRESS =
  /\b(stuck|frustrat(?:ed|ing)|give up|giving up|hopeless|overwhelmed|stressed|anxious|too hard|can'?t do (?:this|it)|feel(?:ing)? (?:\w+ )?(?:dumb|stupid|lost|behind)|i'?m behind|falling behind|so far behind|hate this|want to quit|crying)\b/i;

export function detectDistress(text: string): boolean {
  return DISTRESS.test(text);
}

// ── SWE/BIZ-10: preferred-name statements ────────────────────────────────────────

// Words that follow "call me" without being names ("call me back", "call me when…").
const NAME_STOPWORDS = new Set([
  'back', 'later', 'when', 'if', 'please', 'anything', 'whatever', 'again', 'now', 'that',
  'what', 'it', 'the', 'a', 'an', 'by', 'out', 'up', 'on', 'in', 'asap', 'tomorrow', 'today',
]);

const NAME_PATTERNS = [
  /\bcall me ([a-z][a-z'-]{1,20})\b/i,
  /\bmy name(?:'s| is) ([a-z][a-z'-]{1,20})\b/i,
  /\bi go by ([a-z][a-z'-]{1,20})\b/i,
  /\bplease use ([a-z][a-z'-]{1,20})\b/i,
  /\bi prefer (?:to be called )?([a-z][a-z'-]{1,20})\b/i,
  /\bit'?s ([a-z][a-z'-]{1,20}), (?:actually|not)\b/i,
];

/** Extract a stated name preference ("call me Liz, not Elizabeth" → "Liz"), or null.
 *  Cross-milestone memory matters here: strict context isolation would otherwise throw
 *  the preference away as soon as the milestone advances. */
export function detectPreferredName(text: string): string | null {
  for (const re of NAME_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const word = m[1];
    if (NAME_STOPWORDS.has(word.toLowerCase())) continue;
    return word[0].toUpperCase() + word.slice(1);
  }
  return null;
}
