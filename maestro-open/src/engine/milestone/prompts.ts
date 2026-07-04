// Prompt builders for the milestone engine. Each returns { system, user } for LLMEngine.
// CONTEXT ISOLATION is enforced here: the teach/assess prompts receive ONLY the current
// milestone's own transcript — never another milestone's messages. The sync prompt is the
// one deliberate exception (it compares the just-finished milestone against what remains).

import type { LessonBrief } from '../api';
import type { Milestone, MilestoneTurn } from './types';
import { CONTEXT_WINDOW } from './types';
import { requiresCodeProduction } from './rails';

type Prompt = { system: string; user: string };

const PERSONA =
  'You are Maestro, a warm, encouraging tutor — a smart friend, not a lecturer. ' +
  'Reply in 1–4 short sentences of plain conversational text (no headings, no markdown). ' +
  'When teaching, end with exactly one question. Never be condescending.';

function renderContext(context: MilestoneTurn[]): string {
  const recent = context.slice(-CONTEXT_WINDOW);
  if (!recent.length) return '(no messages yet)';
  return recent.map((m) => `${m.role === 'tutor' ? 'Tutor' : 'Student'}: ${m.text}`).join('\n');
}

// ── 1. Decomposition (init) — RECURSIVE, in TWO separate calls per node ──────────
// The judgment ("is this goal one idea or several?") and the action ("split it") are
// DELIBERATELY separate calls. When they shared one prompt, the task framing biased the
// model into always splitting — 0/15 atomic across two full live traces — and the worked
// atomic example we tried leaked its content into the lesson plan (a for-loop milestone
// appeared in an if/elif/else lesson). A one-word binary with symmetric framing sidesteps
// both failure modes: nothing to imitate, no "decompose" job description to comply with.

/** Step 1 of a node: judge the goal's size. One word out — ATOMIC or SPLIT.
 *  NOTE: prompt-side depth bias does NOT work on this model — a gentle hint, a worked
 *  example, and a hard "almost always ATOMIC" hint all left deep verdicts split-biased
 *  (0/3 ATOMIC in the counters trace). The deterministic pre-gate in decompose.ts
 *  (isSelfEvidentLeaf) is what actually curbs deep over-splitting; this prompt stays
 *  neutral so depth-0 judgments — which ARE honest — remain unbiased. */
export function classifyPrompt(lessonTitle: string, goal: string, depth: number, maxDepth: number): Prompt {
  const system = [
    'You are a curriculum planner reviewing ONE learning goal for a tutoring lesson.',
    'Judge its size honestly — both answers are equally common:',
    '  • ATOMIC — one focused idea a student can be taught and checked on in a single',
    '    short tutoring exchange (about 3-5 minutes).',
    '  • SPLIT — it clearly bundles several distinct ideas or skills that must be',
    '    taught one at a time.',
    '',
    'Reply with exactly ONE WORD: ATOMIC or SPLIT. No other text.',
  ].join('\n');
  const user = [
    `Lesson context: ${lessonTitle}`,
    `Goal to judge: ${goal}`,
    `(Recursion depth ${depth} of max ${maxDepth} — the deeper the goal, the more likely it is already atomic.)`,
    '',
    'One word — ATOMIC or SPLIT:',
  ].join('\n');
  return { system, user };
}

/** Step 2 of a node, ONLY for goals judged SPLIT: produce the sub-goals. Keeps the
 *  {"atomic": true} escape hatch so a mis-classified goal can still bail out, but shows
 *  NO worked example, NO lesson context, and NO recursion meta-text — every one of those
 *  has been observed leaking into plans (a for-loop example became a milestone; the lesson
 *  title bled "indentation" into `=` vs `==` sub-goals; and the "(Recursion depth 1 of
 *  max 2)" note spawned literal recursion-depth curriculum in a decision-tables lesson).
 *  The splitter sees ONLY the goal it is splitting. */
export function expandPrompt(goal: string): Prompt {
  const system = [
    'You are a curriculum planner doing RECURSIVE decomposition. You are given ONE learning goal',
    'that is too big for a single tutoring turn. Split it into 2 or 3 smaller, strictly ORDERED',
    'sub-goals, each a prerequisite step toward the parent and each clearly smaller than it. Return',
    '    {"atomic": false, "subGoals": [',
    '      {"title": "<3-6 words>", "description": "<what to demonstrate>"},',
    '      {"title": "<3-6 words>", "description": "<what to demonstrate>"}',
    '    ]}',
    '',
    'RULES:',
    '- "subGoals" MUST contain 2 or 3 items. An array with fewer than 2 items is INVALID.',
    '- ONE sub-goal is never a split — that is just rephrasing the goal.',
    '- A sub-goal must NOT restate the parent goal in other words — each must be a strictly',
    '  smaller piece of it.',
    '- Each "description" must be understandable ON ITS OWN: always NAME the specific thing',
    '  it concerns instead of writing "the variable", "the value", or "it".',
    '- Use ONLY the keys shown above. Respond with ONLY the JSON object, no prose.',
    '- Only if the goal truly CANNOT be split into 2 genuinely smaller steps, return',
    '  {"atomic": true} instead.',
  ].join('\n');
  const user = [`Goal to split: ${goal}`, '', 'Split this goal now. Return the JSON.'].join('\n');
  return { system, user };
}

// ── 1b. Consolidation (finalize the plan) — runs PER GOAL ────────────────────────
// Recursive decomposition tends to emit redundant, out-of-order steps. This pass merges
// duplicates, drops redundancy, and reorders by dependency — before the student sees
// anything. NOTE: the old "Aim for 3 to 7 steps" guidance was written for the GLOBAL
// refine and, per goal, invited padding — a 2-step draft came back as 5 with generic
// "practice"/"review" filler (observed live). Adding a step stays legal ONLY for missing
// goal content (that behavior has rescued coverage twice); decompose.ts additionally caps
// the answer at draft+1 steps deterministically.

export function refinePrompt(goals: string[], draftSteps: string[]): Prompt {
  const system = [
    'You are finalizing a lesson plan for a tutor — ONE goal at a time. You are given the GOAL',
    'and a rough, auto-generated list of teaching STEPS for it, often redundant or out of order.',
    'Produce the FINAL ordered list of steps that:',
    '- MERGES duplicate or near-duplicate steps into ONE (never repeat the same idea),',
    '- REMOVES steps not needed to reach the goal,',
    '- is ORDERED by dependency (teach prerequisites first),',
    '- keeps each step a single, teachable, checkable idea,',
    '- makes each step understandable ON ITS OWN — every step must NAME what it operates on,',
    '  never a bare "the variable", "the value", or "it",',
    '- ADDS a step ONLY if some part of the goal is taught by NO draft step.',
    'NEVER add generic practice, review, or recap steps — practice happens inside each step.',
    'A single goal usually needs 1-4 steps; fewer is better than padded.',
    'Output ONE step per line — no numbering, no bullets, no quotes, no extra text.',
  ].join('\n');
  const user = [
    'Lesson goals:',
    goals.map((g, i) => `${i + 1}. ${g}`).join('\n'),
    '',
    'Rough draft steps (clean these up — merge, drop, reorder):',
    draftSteps.map((s) => `- ${s}`).join('\n'),
    '',
    'Write the final ordered steps now, one per line.',
  ].join('\n');
  return { system, user };
}

// ── 1c. Coverage audit (verify the plan) — ENUMERATE-then-MATCH, one goal per call ─
// The refine pass has been observed to silently DROP part of a mastery goal (a whole
// "while vs for" comparison vanished from a real plan). Two audit designs failed before
// this one: the list-all version was trigger-happy (flagged plainly-covered goals), and
// the per-goal yes/no version rubber-stamped — a 1-2B grader biased toward "covered: true"
// approved a plan that had deterministically lost "update the counter inside the loop"
// (live counters trace). So the model now does the one thing it is reliably good at:
// ENUMERATE what the goal requires, one line each. Whether each requirement is covered is
// decided DETERMINISTICALLY in decompose.ts (stemmed overlap against the steps).

export function coveragePrompt(goal: { id: string; statement: string }): Prompt {
  const system = [
    'You are auditing ONE lesson goal for COVERAGE. Your ONLY job is to enumerate what the',
    'goal requires — deciding what is already covered happens elsewhere.',
    'List every distinct thing this goal explicitly requires the student to be able to DO.',
    'Each requirement: ONE line, 3-12 words, self-contained, reusing the goal\'s own words.',
    'Do NOT invent requirements the goal does not state. Do NOT give teaching advice.',
    'Output ONLY the requirement lines, one per line — no numbering, no bullets, no other text.',
  ].join('\n');
  const user = [`Goal: ${goal.statement}`, '', 'List the requirements now, one per line.'].join('\n');
  return { system, user };
}

// ── 2a. Teaching (execution) ────────────────────────────────────────────────────
// Continue teaching the CURRENT milestone only. Isolated context.

/** A minimal handoff from the just-completed milestone, used ONLY to make the transition turn
 *  feel continuous. Kept tiny on purpose (topic + the student's last message) so the new
 *  milestone's context stays micro-sized and assessment isn't polluted by prior content.
 *  `mastered` is false when the engine force-advanced past a stuck milestone — the tutor
 *  must not congratulate the student on something they never demonstrated. */
export interface MilestoneBridge {
  completedTitle: string;
  lastStudentMessage: string;
  mastered: boolean;
}

/** Escalating scaffold (weak-spot #1: the infinite impasse loop). `attempts` = failed
 *  assessments on this milestone. Each level changes the teaching MOVE, not just the words:
 *  re-explain differently → concrete hint / partial example → full worked example. The
 *  engine force-advances after MAX_ATTEMPTS so a student is never trapped. */
export function escalationNote(attempts: number): string {
  if (attempts >= 3)
    return (
      'The student has tried this idea several times without getting it. STOP asking them to produce ' +
      'the answer. Walk through ONE complete worked example step by step — show the answer and why it ' +
      'works — then ask a much simpler check question (change one small detail of your example).'
    );
  if (attempts >= 2)
    return (
      'The student has now missed this idea more than once. Do NOT repeat the same explanation. Give a ' +
      'concrete hint that removes one step of the difficulty, or a partially-worked example they only ' +
      'have to finish.'
    );
  if (attempts >= 1)
    return (
      'The student missed this on their first try. Re-explain it a DIFFERENT way than before — a new ' +
      'angle or a small concrete example — do not repeat your previous wording.'
    );
  return '';
}

/** Deterministic-rail context for one teach turn — set by the engine from rails.ts
 *  detections; each truthy field injects one targeted instruction into the system prompt. */
export interface TeachRails {
  /** cross-milestone preferred name ("call me Liz") — survives context isolation. */
  studentName?: string;
  /** the student's latest message carried distress cues → empathy must lead. */
  distressed?: boolean;
  /** the assessor's evidence line for a just-failed answer — so the re-teach targets the
   *  actual gap instead of blindly rephrasing the previous explanation. */
  graderEvidence?: string;
  /** the student asked for clarification (question/confusion) — they were NOT wrong, and
   *  feeding the "assessor judged not demonstrated" block made the tutor open with
   *  "Not quite —" at someone asking for help (observed live). */
  clarifying?: boolean;
  /** lesson topic, for grounding (the teach prompt otherwise has zero lesson context). */
  lessonTopic?: string;
  /** the lesson's programming language — without it the model wrote `var result = True;`
   *  (JS keyword + semicolon + Python boolean: valid in no language). */
  language?: string;
}

/** Appended to the teach USER prompt when a reply praised an answer the assessor had
 *  just judged wrong — one regeneration with this note, then a deterministic scrub. */
export const NO_PRAISE_NOTE =
  '\n\nIMPORTANT: The student\'s latest answer was NOT correct. Do NOT call it correct, right, or ' +
  'praise it in any way. Kindly and clearly point out that it is not right, explain briefly why, ' +
  'and guide them toward the correct idea.';

/** Appended to the teach USER prompt when the drafted reply largely repeats the previous
 *  tutor message (observed live: the attempts-2 "hint" restated the student's own correct
 *  sequence and re-asked a question the tutor had already answered) — one regeneration,
 *  then accept. */
export const REPETITION_NOTE =
  '\n\nIMPORTANT: Your previous draft repeated what you already told the student — do NOT re-ask ' +
  'a question you already asked and do NOT reuse your earlier example or wording. Say something ' +
  'genuinely NEW: a different concrete example with different numbers, or a different angle on the same idea.';

/** Appended to the teach USER prompt when a re-teach draft consisted ONLY of questions —
 *  it explained nothing (observed live: the attempts-3 "worked example" turn was a single
 *  question with no example and no answer). One regeneration, then accept. */
export const EXPLAIN_FIRST_NOTE =
  '\n\nIMPORTANT: Your previous draft was only questions — it explained nothing. First EXPLAIN ' +
  'the idea in a sentence or two, or SHOW one small worked example including its answer. ' +
  'Only THEN end with one question — about a DIFFERENT case than the example you just answered ' +
  '(change one number), never a filler like "What\'s your answer?".';

/** Appended to the teach USER prompt when the drafted reply ended with a FILLER question
 *  ("What's your answer?" after the reply already stated the answer) — one regeneration,
 *  then accept. */
export const VACUOUS_QUESTION_NOTE =
  '\n\nIMPORTANT: Your previous draft ended with a filler question that has no checkable answer ' +
  '(like "What\'s your answer?" or "What are your thoughts?") — and everything before it was ' +
  'already answered, so the student has nothing to say. Rewrite it: keep the explanation, then ' +
  'end with ONE specific question about a DIFFERENT case (change one number) whose answer is a ' +
  'value, a sequence of numbers, or a line of code you have NOT already stated.';

/** Appended to the teach USER prompt when a reply's code is not in the lesson's language
 *  (observed live: `var result = True;` in a Python lesson). One regeneration, then accept. */
export function syntaxNote(language: string): string {
  return (
    `\n\nIMPORTANT: Your previous draft contained code that is NOT valid ${language}. Rewrite ` +
    `your reply so every piece of code is valid ${language} — do not use keywords or punctuation ` +
    'from any other programming language.'
  );
}

/** Appended to the transition USER prompt when the drafted reply shared zero content words
 *  with the new milestone (total topic drift) — one regeneration, then accept. */
export function offTopicNote(description: string): string {
  return (
    '\n\nIMPORTANT: Your previous draft asked about a DIFFERENT topic. Your reply — and your ' +
    `question — MUST be about exactly this: ${description}. Do not bring up any other topic.`
  );
}

export function teachPrompt(
  milestone: Milestone,
  justAdvanced: boolean,
  bridge?: MilestoneBridge,
  attempts = 0,
  rails?: TeachRails,
): Prompt {
  const isOpening = milestone.context.length === 0;
  const lessonStart = isOpening && !justAdvanced; // very first turn of the whole lesson
  const transition = isOpening && justAdvanced; // moving on to the next idea, mid-lesson

  // COMPACT ON PURPOSE (2026-07-04): this prompt had grown to ~30 imperative lines across
  // fix rounds and the 1.7B model visibly ignored most of them — the very first turn after
  // the checkable-question rule shipped violated it. The deterministic rails in engine.ts
  // are the real enforcement; the prompt states each rule ONCE, tersely, and includes a
  // rule only on turns where it applies (the artifact rule only on code-production
  // milestones, the relevance gate only mid-milestone).
  const production = requiresCodeProduction(milestone.description);
  const system = [
    PERSONA,
    '',
    'You are teaching ONE focused idea — stay strictly on it, no drifting to other topics.',
    "Write ONLY your own next message, in plain prose — no \"Tutor:\" label, and NEVER write the student's lines.",
    'BE HONEST: a wrong answer is called wrong, kindly, with a brief why — never say "correct" or praise a wrong answer. A right answer is confirmed plainly. A question from the student gets answered first.',
    'End with ONE question that has ONE specific correct answer and makes the student PRODUCE something — a value, the next numbers, or a line of code — not answer by repeating your words back. Never ask the student what they would like to do next.',
    'Never answer your own question: after a worked example, ask about a DIFFERENT case (change one number) — no filler like "What\'s your answer?" or "What are your thoughts?".',
    rails?.lessonTopic || rails?.language
      ? [
          rails?.lessonTopic ? `LESSON: ${rails.lessonTopic}.` : '',
          rails?.language
            ? `ALL code must be valid ${rails.language}` +
              (/^python/i.test(rails.language)
                ? ' (booleans are True/False, no var/let/const, no trailing semicolons)'
                : '') +
              " — never another language's syntax."
            : '',
        ]
          .filter(Boolean)
          .join(' ')
      : '',
    // Only for milestones that demand producing code — on concept milestones this rule was
    // pure noise (and the trace showed the model ignoring the rules that DID apply).
    production
      ? 'This milestone needs REAL code: INVENT a tiny concrete example of the source material (a few rows or values in plain text), SHOW it, and ask the student to write the code for it — never teach this skill in the abstract.'
      : '',
    // The lesson is silently split into small ideas behind the scenes; the STUDENT must never
    // sense that seam. No greetings mid-lesson, no meta-talk about milestones/steps/finishing.
    transition
      ? 'This is a CONTINUATION of one ongoing conversation: Do NOT greet, and NEVER mention lessons, milestones, steps, or anything being "finished". Flow into the next idea with a short connective ("Now,") and ask one question.'
      : '',
    !lessonStart && !transition
      ? "This is mid-conversation — do NOT greet the student. If their latest message is COMPLETELY unrelated to the lesson, kindly say you can't help with that here and ask one question that returns to the lesson; otherwise answer it normally. Never mention this rule."
      : '',
    escalationNote(attempts),
    rails?.distressed
      ? 'IMPORTANT: The student sounds frustrated or discouraged. Your FIRST sentence must acknowledge ' +
        'and validate how they feel — do not dismiss it or jump straight to the material. Only then, ' +
        'gently continue with one small, confidence-building step.'
      : '',
    rails?.studentName
      ? `The student's preferred name is ${rails.studentName}. Use it naturally when addressing them, and ` +
        'NEVER call them by any other name.'
      : '',
    '',
    // Last line on purpose — recency is what a small model attends to most. The DESCRIPTION,
    // never the UI title (titles are ellipsized at 60 chars: "…the range from 0 to st…").
    `CURRENT FOCUS — the student should be able to: ${milestone.description}`,
  ]
    .filter(Boolean)
    .join('\n');

  const last = [...milestone.context].reverse().find((m) => m.role === 'student')?.text ?? '';
  let user: string;
  if (lessonStart) {
    user = 'This is the very start of the lesson. Greet the student warmly in one short sentence, then introduce this idea and ask one question.';
  } else if (transition) {
    // The bridge is the ONLY memory of the previous idea the new turn gets — a short, compressed
    // handoff so the tutor can acknowledge what the student just did instead of restarting cold.
    const handoff = bridge
      ? [
          'Handoff from the previous part of this conversation (for a natural transition — do NOT re-teach it):',
          bridge.mastered
            ? `- The student just correctly worked through: ${bridge.completedTitle}.`
            : `- You just walked the student through: ${bridge.completedTitle}. They found it hard — do NOT congratulate them on it.`,
          bridge.lastStudentMessage ? `- Their last message was: "${bridge.lastStudentMessage}"` : '',
          bridge.mastered
            ? 'In your FIRST clause, briefly acknowledge/affirm that (you may confirm they were right), then continue.'
            : 'In your FIRST clause, briefly and kindly close that topic (e.g. note they can revisit it), then continue.',
        ]
          .filter(Boolean)
          .join('\n')
      : '';
    user = [
      handoff,
      'Continue naturally into this next idea — no greeting, no mention of milestones or steps. Introduce it in a sentence or two and ask one question.',
      // Observed drift: a transition turn asked about a different topic entirely, so the next
      // assessment graded the student against the wrong idea. State the focus imperatively.
      `Your introduction and your question MUST be about exactly this, and nothing else: ${milestone.description}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  } else {
    user = [
      'Conversation so far on this idea (for your reference only):',
      '"""',
      renderContext(milestone.context),
      '"""',
      last ? `The student's latest message was: "${last}"` : '',
      rails?.clarifying
        ? 'The student asked for clarification — they were NOT wrong about anything. Do not say "Not quite" or correct them. Re-explain the idea more simply, with one tiny concrete example, then ask one easy question.'
        : rails?.graderEvidence
          ? `An assessor judged that the student has not yet demonstrated the idea. Assessor's note: "${rails.graderEvidence}". Address this specific gap in your reply.`
          : '',
      'Now write your next tutor reply — your message only, ending with one question.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return { system, user };
}

// After the tutor's reply, generate fresh quick-reply options the STUDENT might tap — so the
// suggestions track the actual conversation instead of being a static list.
export function suggestionsPrompt(tutorReply: string, milestoneTitle: string): Prompt {
  // Plain one-per-line format — small models comply with this far more reliably than JSON.
  const system = [
    'You write 4 short quick-reply buttons a STUDENT could tap to respond to their tutor.',
    'Output EXACTLY 4 options, ONE PER LINE, first-person, natural and casual, under 10 words.',
    'No numbering, no bullets, no quotes, no extra text — just the 4 lines.',
    '',
    "IMPORTANT: do NOT give away the answer to the tutor's question — the student is still learning,",
    'and buttons that hand over the answer defeat the point. Instead make the options sound like a',
    'real learner: ask what a term means, ask to re-explain a concept, offer a tentative/partial',
    'guess, admit confusion, or ask to move on. Never state the full correct answer.',
    '',
    'EXCEPTION — multiple-choice: if the tutor asked a multiple-choice question (it lists options',
    'like "A) … B) … C) …" or "is it X or Y?"), then output those answer choices as the 4 lines',
    '(one may be the correct one) — here the student is meant to pick one.',
    '',
    'Example — open question ("What do you think a loop does?"):',
    'What exactly do you mean by "loop"?',
    'Can you explain that again?',
    'Maybe it repeats something?',
    "I'm not sure, honestly",
  ].join('\n');
  const user = [
    `(You are helping the student learn: ${milestoneTitle}.)`,
    `The tutor just said: "${tutorReply}"`,
    '',
    'Write the 4 student replies now, one per line.',
  ].join('\n');
  return { system, user };
}

// ── 2b. Focused assessment ───────────────────────────────────────────────────────
// The ONLY question: is THIS specific milestone achieved? Isolated context.

export function assessPrompt(milestone: Milestone): Prompt {
  const system = [
    'You are a strict grader. Judge ONLY whether the student has demonstrated this single',
    'milestone in the conversation below. Do not consider anything outside it. Require real',
    'evidence from the student (their own words/answer) — being told the answer is not enough.',
    // False-NEGATIVE guard (approved 2026-07-04 after it recurred): a correct terse answer
    // ("count 0 1 2" to a range(0,3) question) was failed for not echoing the milestone's
    // wording, and the tutor then revealed the answer — judge substance, not phrasing.
    'A correct answer in the student\'s own words counts as evidence — even a short one, and',
    'even if it does not use the milestone\'s wording. Judge the substance, not the phrasing.',
    // Counterweight (approved after "time if the year" passed a list-ALL milestone): the
    // leniency above is about PHRASING, not about SCOPE.
    'But scope still matters: if the milestone asks to list ALL of something, or to VERIFY',
    'something, a single example or a vague mention is not sufficient evidence.',
    '',
    'Respond with ONLY this JSON, no prose:',
    '{ "achieved": true|false, "evidence": "<short reason citing the student\'s words>" }',
  ].join('\n');
  const user = [
    `MILESTONE: ${milestone.description}`,
    `Achieved means the student can: ${milestone.description}`,
    '',
    'Conversation (this milestone only):',
    renderContext(milestone.context),
    '',
    'Is this milestone achieved? Return the JSON now.',
  ].join('\n');
  return { system, user };
}

/** Appended to the assess USER prompt when the verdict said NOT achieved but the evidence
 *  argued the answer was correct (fine-tune trace: achieved:false + "a valid if/elif/else
 *  chain, so the ordering is correct") — one re-ask demanding internal consistency. */
export const CONTRADICTION_NUDGE =
  '\n\nIMPORTANT: Your previous verdict said the milestone was NOT achieved, but your evidence ' +
  "argued the student's answer was correct — they must agree. Re-judge the conversation " +
  'carefully and return JSON where the verdict and the evidence agree.';

// ── 3. Milestone Sync (cleanup / cross-check) ─────────────────────────────────────
// The completed milestone's full transcript + the remaining list → which remaining ones
// were IMPLICITLY achieved along the way. Returns the ids that are now also achieved.

export function syncPrompt(completed: Milestone, remaining: Milestone[]): Prompt {
  const system = [
    'You are auditing a learning plan, STRICTLY. One learning goal was just completed. For EACH',
    'remaining goal, decide whether the STUDENT has ALREADY personally demonstrated it — in their',
    'OWN words or answers — within the conversation below.',
    '',
    'Rules (false positives are harmful — be conservative):',
    '- Count a goal ONLY if a specific STUDENT message clearly shows the student themselves did',
    '  exactly what that goal describes.',
    '- The tutor explaining something, or a topic merely being mentioned, does NOT count.',
    '- A different or loosely-related topic does NOT count. If unsure, EXCLUDE it.',
    '- Usually the correct answer is NONE. Only include a goal with undeniable student evidence.',
    '',
    'Respond with ONLY this JSON, no prose:',
    '{ "alsoAchieved": [ { "id": "<remaining goal id>", "evidence": "<quote/paraphrase of the exact STUDENT message that proves it>" } ] }',
    'Use { "alsoAchieved": [] } if none. If you cannot quote a student message that proves a goal, EXCLUDE it. Never invent evidence.',
  ].join('\n');
  // Bounded like every other prompt (weak-spot: a long milestone must not blow up the sync
  // prompt). Wider than the teach/assess window because sync audits the WHOLE milestone,
  // but still hard-capped so tokens can't grow without bound.
  const recent = completed.context.slice(-CONTEXT_WINDOW * 2);
  // Descriptions only — the ellipsized UI titles are near-duplicates of the description
  // and the truncated "…" form was leaking into the model's view of the plan.
  const user = [
    `Just-completed goal: ${completed.description}`,
    '',
    "Conversation (ONLY the student's own messages count as evidence):",
    recent.map((m) => `${m.role === 'tutor' ? 'Tutor' : 'Student'}: ${m.text}`).join('\n') ||
      '(none)',
    '',
    'Remaining goals to audit:',
    remaining.map((m) => `- ${m.id}: ${m.description}`).join('\n'),
    '',
    'For each remaining goal, include it ONLY if a specific student message already proves it. Return the JSON now.',
  ].join('\n');
  return { system, user };
}

// ── 4. Completion ─────────────────────────────────────────────────────────────────

/** `struggled` = milestones force-advanced past an impasse (never demonstrated). A lesson
 *  where everything was force-advanced used to close with "Beautifully done — you can now
 *  refactor…" (harness iter1): warm is fine, claiming mastery of undemonstrated skills is not. */
export function completionPrompt(brief: LessonBrief, progress?: { total: number; struggled: number }): Prompt {
  const system = PERSONA;
  const user =
    progress && progress.struggled > 0
      ? `The student finished "${brief.title}" but found ${progress.struggled} of its ${progress.total} ideas genuinely difficult and has not yet mastered them. In 1–2 sentences: warmly credit the effort, say plainly that some ideas need another pass, and encourage revisiting. Do NOT claim mastery. No question.`
      : `The student has achieved every milestone of "${brief.title}". Congratulate them warmly in 1–2 sentences and name what they can now do. Do not ask a question.`;
  return { system, user };
}

/** Appended to the teach USER prompt when a drafted reply called the student's provably
 *  terminating loop "infinite" (a recurring hallucination across three traces) — one
 *  regeneration, then accept. */
export const FALSE_INFINITE_NOTE =
  "\n\nIMPORTANT: The student's loop DOES terminate — its variable changes every pass until the " +
  'condition fails. Do NOT call it infinite or say it runs forever. Judge the code they actually ' +
  'wrote, and ask one specific question about what it prints.';

/** Appended to the teach USER prompt when a drafted reply talked ABOUT the learner in the
 *  third person ("the student hasn't rewritten it") — one regeneration, then accept. */
export const SECOND_PERSON_NOTE =
  '\n\nIMPORTANT: You are talking TO the student. Address them directly as "you" — never refer to "the student" in the third person.';
