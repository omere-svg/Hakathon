// Prompt builders for the milestone engine. Each returns { system, user } for LLMEngine.
// CONTEXT ISOLATION is enforced here: the teach/assess prompts receive ONLY the current
// milestone's own transcript — never another milestone's messages. The sync prompt is the
// one deliberate exception (it compares the just-finished milestone against what remains).

import type { LessonBrief } from '../api';
import type { Milestone, MilestoneTurn } from './types';
import { CONTEXT_WINDOW } from './types';

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

// ── 1. Decomposition (init) — RECURSIVE ──────────────────────────────────────────
// One node of the recursion: given a single goal, the model decides whether it is small
// enough to teach AND check in one 3-5 minute turn (atomic), or must split into 2-3 smaller
// ORDERED sub-goals. The decomposer (decompose.ts) recurses on non-atomic nodes and flattens
// the leaves into the MilestoneQueue. This keeps every milestone's context micro-sized.

export function expandPrompt(lessonTitle: string, goal: string, depth: number, maxDepth: number): Prompt {
  const system = [
    'You are a curriculum planner doing RECURSIVE decomposition. You are given ONE learning goal.',
    'Decide: can it be TAUGHT and CHECKED in a single focused tutoring turn of about 3-5 minutes',
    '(one atomic idea a student can master in one sitting)?',
    '  • If YES → it is atomic. Return {"atomic": true}.',
    '  • If NO → split it into 2 or 3 smaller, strictly ORDERED sub-goals, each a prerequisite',
    '    step toward the parent and each clearly smaller than it. Return',
    '    {"atomic": false, "subGoals": [{"title": "<3-6 words>", "description": "<what to demonstrate>"}]}.',
    '',
    'Respond with ONLY the JSON object, no prose. Prefer atomic when the goal is already a single idea.',
  ].join('\n');
  const user = [
    `Lesson context: ${lessonTitle}`,
    `Goal to evaluate: ${goal}`,
    `(Recursion depth ${depth} of max ${maxDepth}. Deeper = smaller; split only if it clearly needs it.)`,
    '',
    'Is this goal atomic, or should it be split? Return the JSON now.',
  ].join('\n');
  return { system, user };
}

// ── 1b. Consolidation (finalize the plan) ────────────────────────────────────────
// Recursive decomposition tends to emit redundant, out-of-order steps. This one pass merges
// duplicates, drops redundancy, and reorders by dependency — before the student sees anything.

export function refinePrompt(goals: string[], draftSteps: string[]): Prompt {
  const system = [
    'You are finalizing a lesson plan for a tutor. You are given the lesson GOALS and a rough,',
    'auto-generated list of teaching STEPS that is usually redundant and out of order.',
    'Produce the FINAL ordered list of steps that:',
    '- MERGES duplicate or near-duplicate steps into ONE (never repeat the same idea),',
    '- REMOVES steps not needed to reach the goals,',
    '- COVERS all of the goals,',
    '- is ORDERED by dependency (teach prerequisites first),',
    '- keeps each step a single, teachable, checkable idea.',
    'Aim for 3 to 7 steps. Output ONE step per line — no numbering, no bullets, no quotes, no extra text.',
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

// ── 2a. Teaching (execution) ────────────────────────────────────────────────────
// Continue teaching the CURRENT milestone only. Isolated context.

/** A minimal handoff from the just-completed milestone, used ONLY to make the transition turn
 *  feel continuous. Kept tiny on purpose (topic + the student's last message) so the new
 *  milestone's context stays micro-sized and assessment isn't polluted by prior content. */
export interface MilestoneBridge {
  completedTitle: string;
  lastStudentMessage: string;
}

export function teachPrompt(milestone: Milestone, justAdvanced: boolean, bridge?: MilestoneBridge): Prompt {
  const isOpening = milestone.context.length === 0;
  const lessonStart = isOpening && !justAdvanced; // very first turn of the whole lesson
  const transition = isOpening && justAdvanced; // moving on to the next idea, mid-lesson

  const system = [
    PERSONA,
    '',
    'You are teaching ONE focused idea. Stay strictly on it — do not preview or drift to other',
    'topics. Explain simply, then ask one question that moves the student toward it.',
    '',
    'CRITICAL: Output ONLY your own next message, as the tutor, in plain prose. Do NOT prefix it',
    'with "Tutor:" or any label. NEVER write the student\'s lines, and never invent or continue',
    'their side of the conversation. Write one short reply and stop.',
    '',
    // Honesty over politeness — otherwise a small model defaults to praising everything.
    "BE HONEST, not just nice. Judge the student's latest answer on its merits. If it is wrong or",
    'shows a misconception, tell them clearly but kindly that it is not right (and briefly why) — do',
    'NOT say "correct" or praise a wrong answer. If it is right, confirm it plainly. If they only',
    'asked a question or seem unsure, answer and guide them. Accurate feedback helps more than empty praise.',
    // The lesson is silently split into small ideas behind the scenes; the STUDENT must never
    // sense that seam. No greetings mid-lesson, no meta-talk about milestones/steps/finishing.
    transition
      ? 'This is a CONTINUATION of the same ongoing conversation. Do NOT greet, do NOT say "hello" or ' +
        '"welcome", and NEVER mention lessons, milestones, steps, or that anything was "finished" or ' +
        '"completed". Just flow naturally into the next idea (a short connective like "Now," or "Next," ' +
        'is fine) and ask one question.'
      : '',
    !lessonStart && !transition ? 'This is mid-conversation — do NOT greet the student.' : '',
    '',
    `CURRENT FOCUS: ${milestone.title}`,
    `The student should be able to: ${milestone.description}`,
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
          `- The student just correctly worked through: ${bridge.completedTitle}.`,
          bridge.lastStudentMessage ? `- Their last message was: "${bridge.lastStudentMessage}"` : '',
          'In your FIRST clause, briefly acknowledge/affirm that (you may confirm they were right), then continue.',
        ]
          .filter(Boolean)
          .join('\n')
      : '';
    user = [
      handoff,
      'Continue naturally into this next idea — no greeting, no mention of milestones or steps. Introduce it in a sentence or two and ask one question.',
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
    '',
    'Respond with ONLY this JSON, no prose:',
    '{ "achieved": true|false, "evidence": "<short reason citing the student\'s words>" }',
  ].join('\n');
  const user = [
    `MILESTONE: ${milestone.title}`,
    `Achieved means the student can: ${milestone.description}`,
    '',
    'Conversation (this milestone only):',
    renderContext(milestone.context),
    '',
    'Is this milestone achieved? Return the JSON now.',
  ].join('\n');
  return { system, user };
}

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
  const user = [
    `Just-completed goal: ${completed.title} — ${completed.description}`,
    '',
    "Conversation (ONLY the student's own messages count as evidence):",
    completed.context.map((m) => `${m.role === 'tutor' ? 'Tutor' : 'Student'}: ${m.text}`).join('\n') ||
      '(none)',
    '',
    'Remaining goals to audit:',
    remaining.map((m) => `- ${m.id}: ${m.title} — ${m.description}`).join('\n'),
    '',
    'For each remaining goal, include it ONLY if a specific student message already proves it. Return the JSON now.',
  ].join('\n');
  return { system, user };
}

// ── 4. Completion ─────────────────────────────────────────────────────────────────

export function completionPrompt(brief: LessonBrief): Prompt {
  const system = PERSONA;
  const user = `The student has achieved every milestone of "${brief.title}". Congratulate them warmly in 1–2 sentences and name what they can now do. Do not ask a question.`;
  return { system, user };
}
