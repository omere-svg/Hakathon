// Token-overlap similarity — the shared deterministic text comparison behind four rails:
// parent-rephrase rejection and the coverage backstop (decompose.ts), the final near-dupe
// merge (decompose.ts), and the transition on-topic check (engine.ts).
//
// Deliberately crude: lowercase content words with a light plural strip, compared by
// containment (|A ∩ B| / |smaller set|). No stemming library, no embeddings — this runs
// on-device next to a 1-2B model and only has to catch near-verbatim restatements, not
// paraphrases. Thresholds are chosen so false MERGES/REJECTS stay rare; a missed near-dupe
// costs a redundant step, a wrong merge silently deletes curriculum.
//
// NOTE: "while" and "for" are NOT stopwords — in this codebase they are usually loop
// keywords (the course content), and dropping them would blind every comparison in a
// loops lesson.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'is', 'are', 'be', 'was',
  'it', 'its', 'this', 'that', 'these', 'those', 'with', 'as', 'by', 'from', 'into',
  'what', 'when', 'how', 'why', 'which', 'who', 'do', 'does', 'not', 'no', 'can', 'will',
  'you', 'your', 'they', 'them', 'their', 'we', 'our', 'i', 'my', 'me', 'he', 'she',
]);

const stripPlural = (w: string): string =>
  w.length > 3 && /^[a-z']+$/.test(w) && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;

/** Lowercased content words of a text: punctuation stripped (backticks included — `while`
 *  and while are the same token), stopwords dropped, and a light plural strip so
 *  "loops" ≡ "loop".
 *  BACKTICKED spans are CODE and bypass the stopword filter entirely: `and`, `or`, `not`,
 *  `is` are operators there — and sometimes the ONLY token distinguishing two sub-goals
 *  ("…using `and`" vs "…using `or`" differ by nothing else; dropping them made a correct
 *  3-way split look like one duplicated goal). Symbol tokens (`==`, `!=`) count too.
 *  PURE-DIGIT tokens are never content: the length filter already dropped single digits by
 *  accident, and the inconsistency shipped garbage — a per-number 6-way split ("a range
 *  that includes 0/2/…/10") collapsed for 0-8 but "includes 10" survived as a milestone.
 *  Two steps differing only by a number are the same skill; when a numeric difference IS
 *  real (range(0,stop) vs range(start,stop)), digitTokens() carries it instead. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    for (const tok of m[1].toLowerCase().split(/\s+/)) {
      if (tok) out.add(stripPlural(tok));
    }
  }
  for (const raw of text.toLowerCase().split(/[^a-z0-9_']+/)) {
    const w = raw.replace(/^'+|'+$/g, '');
    if (w.length < 2 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    out.add(stripPlural(w));
  }
  return out;
}

/** Every run of digits in the raw text ("stop-1" → "1", "range(0, 3)" → "0","3").
 *  Used as a MERGE BLOCKER: numbers are parameters, and two steps whose numbers differ
 *  describe different cases even when every word matches. */
export function digitTokens(text: string): Set<string> {
  return new Set(text.match(/\d+/g) ?? []);
}

/** Containment similarity in [0, 1]: how much of the SMALLER word set appears in the other.
 *  1 = one text is (wordwise) contained in the other; 0 = nothing shared or no content. */
export function overlapRatio(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (!wa.size || !wb.size) return 0;
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  let hits = 0;
  for (const w of small) if (large.has(w)) hits++;
  return hits / small.size;
}

/** Symmetric (Jaccard) similarity in [0, 1]: |A ∩ B| / |A ∪ B|. Use this for REPHRASE
 *  detection: a short child whose words are a subset of a long parent is a narrower
 *  sub-goal (fine), not a rephrase — containment would wrongly flag it, Jaccard doesn't. */
export function jaccard(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (!wa.size || !wb.size) return 0;
  let hits = 0;
  for (const w of wa) if (wb.has(w)) hits++;
  return hits / (wa.size + wb.size - hits);
}

/** Above this, two goal/step descriptions are the same idea restated.
 *  Applied to jaccard() for parent-rephrase rejection and to overlapRatio() for the
 *  coverage-audit guards (there, containment is right: a missing-part already wordwise
 *  inside a step IS covered). */
export const NEAR_DUPLICATE = 0.8;

/** Essentially the SAME content-word set — the strictest tier, for sub-goal dedupe.
 *  Word-swapped duplicates ("assignment and equality" / "equality and assignment") score
 *  jaccard 1.0; PROGRESSIVE variants that differ by one real word — range(stop) vs
 *  range(start, stop) descriptions scored 0.80/0.83 live — must survive, and NEAR_DUPLICATE
 *  would (and did) kill them. */
export const WORD_SET_MATCH = 0.9;

/** True when the texts share at least one content word — the transition on-topic check.
 *  Zero shared content between a teach reply and its milestone means total drift. */
export function sharesContent(a: string, b: string): boolean {
  const wa = contentWords(a);
  if (!wa.size) return false;
  for (const w of contentWords(b)) if (wa.has(w)) return true;
  return false;
}

// ── verb-masked tier (setup-verb-swapped duplicates) ─────────────────────────────
// The model's bogus "define vs declare" splits produce two steps that are the SAME step
// with the setup verb swapped ("create a variable named counter and assign it a initial
// value" / "assign an initial value to the counter variable" — jaccard 0.71, under every
// plain tier). Masking the interchangeable setup verbs and comparing what remains (the
// nouns) catches exactly that shape.

/** Setup verbs small models swap interchangeably when restating one step as "two". */
const SETUP_VERBS = new Set([
  'create', 'define', 'declare', 'make', 'assign', 'set', 'initialize', 'initialise', 'give',
]);

/** Backticked code tokens only — two steps whose code tokens differ are NEVER duplicates
 *  (`and` vs `or` is sometimes the only distinguishing token). Also used by the transition
 *  on-topic rail: a `break` milestone's intro must actually mention break. */
export function codeTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    for (const tok of m[1].toLowerCase().split(/\s+/)) {
      if (tok) out.add(stripPlural(tok));
    }
  }
  return out;
}

function setJaccard(wa: Set<string>, wb: Set<string>): number {
  if (!wa.size || !wb.size) return 0;
  let hits = 0;
  for (const w of wa) if (wb.has(w)) hits++;
  return hits / (wa.size + wb.size - hits);
}

/** Jaccard over content words with SETUP_VERBS masked out — but ONLY when the comparison
 *  is really about verb choice: both texts must contain a setup verb (otherwise a
 *  difference of one real noun — the progressive range() variants — would score 0.8 and
 *  merge), their backticked code tokens must be identical (the and/or/not guard), and
 *  their DIGIT tokens must be identical (the for-loops trace regression: "range from 0 to
 *  stop-1" vs "range from start to stop-1" both start with "create", so the verb tier
 *  activated and merged them — digits {0,1} vs {1} are parameters, a real distinction).
 *  Returns 0 whenever those preconditions fail, so it can only ever ADD a match the
 *  plain tiers missed, never veto one. */
export function verbMaskedJaccard(a: string, b: string): number {
  const ca = codeTokens(a);
  const cb = codeTokens(b);
  if (ca.size !== cb.size) return 0;
  for (const t of ca) if (!cb.has(t)) return 0;
  const da = digitTokens(a);
  const db = digitTokens(b);
  if (da.size !== db.size) return 0;
  for (const t of da) if (!db.has(t)) return 0;
  const wa = contentWords(a);
  const wb = contentWords(b);
  const va = new Set([...wa].filter((w) => !SETUP_VERBS.has(w)));
  const vb = new Set([...wb].filter((w) => !SETUP_VERBS.has(w)));
  if (va.size === wa.size || vb.size === wb.size) return 0; // a side with no setup verb
  return setJaccard(va, vb);
}

// ── stemmed tier (inflection-tolerant, for low-stakes decisions only) ────────────
// A crude 5-char prefix stem: "initialize" ≡ "initial", "started" ≡ "start". Too blunt
// for the merge/dedupe tiers (a wrong merge silently deletes curriculum) — used only
// where the cost of a false match is small: skipping a coverage append that would have
// been redundant anyway, or regenerating one teach reply.

const stem = (w: string): string => (w.length > 5 ? w.slice(0, 5) : w);

function stemmedWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of contentWords(text)) out.add(stem(w));
  return out;
}

/** Containment over stemmed content words — the coverage-audit "is this requirement
 *  already taught by a step?" check ("initialize the counter" must match a step that
 *  says "assign an initial value to the counter variable"). */
export function stemmedOverlapRatio(a: string, b: string): number {
  const wa = stemmedWords(a);
  const wb = stemmedWords(b);
  if (!wa.size || !wb.size) return 0;
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  let hits = 0;
  for (const w of small) if (large.has(w)) hits++;
  return hits / small.size;
}

/** Symmetric similarity over stemmed content words — the teach-output repetition check
 *  ("started" in the draft must match "start" in the previous tutor message). */
export function stemmedJaccard(a: string, b: string): number {
  return setJaccard(stemmedWords(a), stemmedWords(b));
}

/** Above this (stemmedJaccard), a teach reply is a rehash of the previous tutor message.
 *  0.6, not 0.8: a re-teach naturally reuses the milestone's vocabulary (fresh examples
 *  score ~0.1–0.4 on live traces) while a mirrored turn — the observed circular "hint"
 *  that restated the student's own sequence and re-asked an already-answered question —
 *  scored ~0.67. The rail regenerates once then accepts, so a false positive costs one
 *  extra call, never a lost reply. */
export const STALE_REPLY = 0.6;
