// Authoring-time content validation (npm run validate). Offline-authored lesson JSON
// can be confidently WRONG (bad key, leaked hint) and the engine would teach it as
// truth — worse than an LLM hedging. This gate catches that before publish.
import { lessons, MCQ_OPTIONS } from '../src/domain/lessons';

const problems: string[] = [];

for (const lesson of lessons) {
  const ids = new Set(lesson.knowledgeComponents.map((k) => k.id));

  // prerequisites must reference real KCs and form a DAG (no cycles)
  const adj: Record<string, string[]> = {};
  for (const kc of lesson.knowledgeComponents) {
    adj[kc.id] = kc.prerequisites;
    for (const p of kc.prerequisites) if (!ids.has(p)) problems.push(`${lesson.id}/${kc.id}: prereq "${p}" does not exist`);
  }
  const state: Record<string, number> = {}; // 0=unseen,1=in-stack,2=done
  const dfs = (n: string): boolean => {
    if (state[n] === 1) return true; // cycle
    if (state[n] === 2) return false;
    state[n] = 1;
    for (const m of adj[n] ?? []) if (ids.has(m) && dfs(m)) return true;
    state[n] = 2;
    return false;
  };
  for (const kc of lesson.knowledgeComponents) if (dfs(kc.id)) problems.push(`${lesson.id}: prerequisite cycle at "${kc.id}"`);

  for (const kc of lesson.knowledgeComponents) {
    for (const c of kc.checks) {
      const k = c.answerKey;
      if (c.type === 'mcq') {
        const opts = MCQ_OPTIONS[c.id];
        if (!opts) problems.push(`${c.id}: mcq check has no MCQ_OPTIONS`);
        else if (k.mcqCorrectIndex == null || k.mcqCorrectIndex < 0 || k.mcqCorrectIndex >= opts.length) problems.push(`${c.id}: mcqCorrectIndex out of range`);
      }
      if (c.type === 'numeric' && k.numericValue == null) problems.push(`${c.id}: numeric check missing numericValue`);
      if (c.type === 'code' && (!k.functionName || !(k.codeTests && k.codeTests.length))) problems.push(`${c.id}: code check missing functionName/codeTests`);
      if (c.type === 'keyword' && !(k.keywords && k.keywords.length)) problems.push(`${c.id}: keyword check missing keywords`);
      if (c.isChallenge && !k.canonicalAnswer) problems.push(`${c.id}: challenge check needs a canonicalAnswer (so the engine can scrub leaks)`);

      // hints must never contain the canonical answer
      const ans = k.canonicalAnswer?.toLowerCase();
      if (ans && ans.length > 3) for (const h of kc.hints) if (h.toLowerCase().includes(ans)) problems.push(`${kc.id}: a hint leaks the canonical answer`);
    }
    // a remediation should be a gap-revealing QUESTION, not a statement of the answer
    for (const m of kc.misconceptions) {
      if (!m.remediation.trim().endsWith('?')) problems.push(`${m.id}: remediation should end as a question (gap-revealing, not the answer)`);
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} content problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ Lesson content valid (${lessons.length} lesson(s), ${lessons.reduce((n, l) => n + l.knowledgeComponents.length, 0)} knowledge components).`);
