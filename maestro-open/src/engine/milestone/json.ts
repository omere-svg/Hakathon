// Robust JSON extraction from a small model's free-text output. WebLLM's grammar/JSON
// mode is disabled by default (it hangs on 0.2.x — see config/features.ts), so the
// milestone engine asks for JSON in plain completions and salvages it here: strip code
// fences, find the first balanced {...} or [...], and parse. Never throws — returns null
// so callers can fall back to a safe default.

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

/** Parse the first JSON value found in free text, or null if none is recoverable. */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  const cleaned = stripFences(text);
  const candidate = firstBalanced(cleaned) ?? cleaned;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

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
    l = l.replace(/^[-*•\d.)\]\s]+/, ''); // strip leading bullets / numbering
    l = l.replace(/^["'`]+|["'`,]+$/g, '').trim(); // strip wrapping quotes / trailing commas
    if (l.endsWith(':')) continue; // skip header/preamble lines ("Here are 4 options:")
    if (l.length > 1 && l.length < 100 && !/^[[\]{}]+$/.test(l)) lines.push(l);
  }
  return lines;
}

/** Interpret a model's yes/no-ish answer. Prefers explicit JSON `achieved`, then falls
 *  back to scanning for an affirmative token. Defaults to false (don't advance on doubt). */
export function parseAchieved(text: string): { achieved: boolean; evidence: string } {
  const obj = extractJson<{ achieved?: unknown; evidence?: unknown }>(text);
  if (obj && typeof obj.achieved === 'boolean') {
    return { achieved: obj.achieved, evidence: typeof obj.evidence === 'string' ? obj.evidence : '' };
  }
  // Fallback heuristic on raw text.
  const t = text.toLowerCase();
  const yes = /\b(achieved|yes|true|mastered|demonstrated|correct)\b/.test(t);
  const no = /\b(not achieved|no|false|not yet|incorrect|hasn't|has not)\b/.test(t);
  return { achieved: yes && !no, evidence: text.trim().slice(0, 200) };
}
