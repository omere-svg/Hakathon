// Robust JSON extraction from a small model's free-text output. WebLLM's grammar/JSON
// mode is disabled (it hangs on 0.2.x with Qwen3 — and 0.2.84 is the latest release, so
// there is no upgrade path), so the milestone engine asks for JSON in plain completions
// and salvages it here: strip code fences, find the first balanced {...} or [...], and
// parse — repairing the classic small-model mistakes (trailing commas, single quotes,
// unquoted keys, Python literals, mid-generation truncation) before giving up.
// Never throws — returns null so callers can fall back to a safe default.

function stripFences(text: string): string {
  // Remove ```json / ``` fences if the model wrapped its answer.
  return text.replace(/```(?:json)?/gi, '').trim();
}

/** Find the first balanced JSON value (object or array) in a string. */
function firstBalanced(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Repair the JSON mistakes a 1-2B model makes most often. Only ever applied to text that
 *  already failed strict parsing, so an over-eager rewrite can't corrupt a good answer —
 *  the result either parses or the caller gets null. */
function repairCandidate(candidate: string): string {
  return (
    candidate
      // Full-width punctuation (the model drifts into CJK tokens mid-JSON)
      .replace(/，/g, ',')
      // Python literals (Qwen slips into them)
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null')
      // unquoted keys: {achieved: true}
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
      // single-quoted keys and values
      .replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3')
      .replace(/(:\s*)'([^']*)'(\s*[,}\]])/g, '$1"$2"$3')
      // trailing commas
      .replace(/,\s*([}\]])/g, '$1')
  );
}

/** A generation cut off by max_tokens leaves an unbalanced value. Close the open string
 *  and brackets so the tokens produced so far are still usable (e.g. a truncated assess
 *  verdict keeps its `achieved` field). Returns null if there's nothing to close. */
function closeTruncated(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const s = text.slice(start);
  const stack: string[] = [];
  let inStr = false;
  let escaped = false;
  for (const ch of s) {
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (!stack.length) return null; // it was balanced after all
  let out = s;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

/** Parse the first JSON value found in free text, or null if none is recoverable. */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  const cleaned = stripFences(text);
  const balanced = firstBalanced(cleaned);
  const candidates = [balanced ?? cleaned];
  if (!balanced) {
    const closed = closeTruncated(cleaned);
    if (closed) candidates.push(closed);
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try repaired */
    }
    try {
      return JSON.parse(repairCandidate(candidate)) as T;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/** Longest line we accept from a list — a refine step is a full goal description, so this
 *  must comfortably exceed one; anything longer is runaway prose, not a list item. */
const MAX_LIST_LINE = 240;

/** Salvage a list of short strings from a small model's output. Tries a JSON array first,
 *  then falls back to line parsing (numbered / bulleted / quoted lines) — small models often
 *  ignore "JSON only" and emit a plain list. Returns [] if nothing usable is found. */
export function parseStringList(text: string): string[] {
  const j = extractJson<unknown>(text);
  if (Array.isArray(j)) {
    const out = j.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
    if (out.length) return out;
  }
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let l = raw.trim();
    if (!l) continue;
    // Strip leading bullets/numbering WITHOUT eating real content: only a bullet glyph, or
    // 1-2 digits followed by punctuation ("1." / "2)" / "3]"), each with trailing space.
    // "0 means the loop stops" and "3.14 is pi" are content and survive verbatim.
    for (let pass = 0; pass < 3; pass++) {
      const stripped = l.replace(/^\s*(?:[-*•]+|\d{1,2}[.)\]])\s+/, '');
      if (stripped === l) break;
      l = stripped;
    }
    l = l.replace(/,+$/, '').trim(); // strip trailing commas (JSON-ish lines)
    // Strip quotes ONLY as a matching wrapping pair — a lone trailing backtick is real
    // content (e.g. "Understand `break`"), not a wrapper, and must survive verbatim.
    const q = l[0];
    if ((q === '"' || q === "'" || q === '`') && l.length > 1 && l.endsWith(q)) l = l.slice(1, -1).trim();
    if (l.endsWith(':')) continue; // skip header/preamble lines ("Here are 4 options:")
    if (l.length > 1 && l.length < MAX_LIST_LINE && !/^[[\]{}]+$/.test(l)) lines.push(l);
  }
  return lines;
}

/** Interpret a model's yes/no-ish answer. Prefers explicit JSON `achieved`, then falls
 *  back to scanning for an affirmative token. Any negation defeats the affirmative — an
 *  assessor writing "not correct" must NEVER advance the milestone. Defaults to false. */
export function parseAchieved(text: string): { achieved: boolean; evidence: string } {
  const obj = extractJson<{ achieved?: unknown; evidence?: unknown }>(text);
  if (obj && typeof obj.achieved === 'boolean') {
    return { achieved: obj.achieved, evidence: typeof obj.evidence === 'string' ? obj.evidence : '' };
  }
  // Models sometimes emit the boolean as a string ("true"/"no").
  if (obj && typeof obj.achieved === 'string') {
    return {
      achieved: /^\s*(true|yes|achieved)\s*$/i.test(obj.achieved),
      evidence: typeof obj.evidence === 'string' ? obj.evidence : '',
    };
  }
  // Fallback heuristic on raw text.
  const t = text.toLowerCase();
  const yes = /\b(achieved|yes|true|mastered|demonstrated|correct)\b/.test(t);
  const no = /\b(not|no|isn'?t|is not|incorrect|wrong|false|hasn'?t|has not|never|unable|fail(?:ed|s)?)\b/.test(t);
  return { achieved: yes && !no, evidence: text.trim().slice(0, 200) };
}
