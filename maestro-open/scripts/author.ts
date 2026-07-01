// Offline authoring scaffold (npm run author). Prints a ready-to-use prompt for a
// FRONTIER model (Claude/GPT, at build time) to decompose a course outline into our
// lesson JSON — the "Smart Offline" half of the pipeline. This is a DEV TOOL: it costs
// money once per course (your key, not per-user), keeping runtime at $0 COGS.
// Usage: npm run author -- "paste a course outline / mastery outcomes here"
// (No API call is made here — paste the printed prompt into a frontier model.)

const outline = process.argv.slice(2).join(' ') || '<paste the Maestro/LMS course outline + mastery outcomes here>';

const SCHEMA = `Lesson = {
  id, program, course, title, topic,
  knowledgeComponents: KC[],   // smallest independently-checkable ideas, in teaching order
  reviewQuestions: []
}
KC = {
  id, label, prerequisites: KcId[],
  presentation: { coreIdea, analogy?, arc?: string[], emphasize?: string[], avoid?: string[] },
  exemplars?: { EXPLAIN?, HINT?, CORRECT?, ... },   // 1 gold example reply per act
  content: { explanation, analogy?, workedExample?, runnableArtifact? },
  checks: Check[],             // deterministically gradeable: mcq | numeric | code | keyword
  misconceptions: [{ id, kcId, description, remediation }],  // remediation = a QUESTION, not the answer
  hints: string[],             // gentle -> specific; NONE may reveal the answer
  masteryCriteria: { minCorrect, requireNoActiveMisconception }
}`;

console.log(`You are an expert curriculum designer + tutor. Decompose the course below into
Maestro Open lesson JSON for an on-device small model to TEACH (it only renders; you supply the pedagogy).

Rules:
- Break each outcome into the smallest independently-masterable Knowledge Components, in teaching order, with prerequisites.
- For each KC author a Presentation Guideline (coreIdea, best analogy, ordered teaching arc, what to emphasize, what to avoid).
- Author 1 gold exemplar reply per relevant act (EXPLAIN/HINT/CORRECT) — short, warm, ends with a question.
- Author 2–3 hint-ladder rungs (gentle→specific, NEVER revealing the answer) and the common misconceptions with gap-revealing question remediations.
- Every check must be deterministically gradeable (mcq/numeric/code/keyword) with an answer key.

Target schema:
${SCHEMA}

COURSE OUTLINE:
${outline}

Output ONLY valid JSON for the Lesson. Then it will be run through "npm run validate".`);
