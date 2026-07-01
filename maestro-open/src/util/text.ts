// Shared text utilities. No DOM deps (also runs in Node for eval:check).

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive presence test. */
export function containsWord(text: string, word: string): boolean {
  if (!word) return false;
  return new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(text);
}

/** Replace every whole-word occurrence (case-insensitive). */
export function replaceWord(text: string, word: string, replacement: string): string {
  if (!word) return text;
  return text.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi'), replacement);
}

export function containsAnyWord(text: string, words: string[]): boolean {
  return words.some((w) => containsWord(text, w));
}

/** Case-insensitive substring test (for phrases). */
export function includesPhrase(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

export function includesAnyPhrase(text: string, phrases: string[]): boolean {
  return phrases.some((p) => includesPhrase(text, p));
}
