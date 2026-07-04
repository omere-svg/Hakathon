// Contract tests for the prompt builders. These pin the load-bearing instructions —
// the seam-hiding rules, the honesty rule, the no-answer-leak rule, the evidence
// requirement — so a prompt tweak that silently drops one fails loudly here.

import { describe, expect, it } from 'vitest';
import {
  assessPrompt,
  classifyPrompt,
  completionPrompt,
  coveragePrompt,
  expandPrompt,
  EXPLAIN_FIRST_NOTE,
  offTopicNote,
  refinePrompt,
  REPETITION_NOTE,
  suggestionsPrompt,
  syncPrompt,
  syntaxNote,
  teachPrompt,
  VACUOUS_QUESTION_NOTE,
} from './prompts';
import type { Milestone } from './types';

function ms(over: Partial<Milestone> = {}): Milestone {
  return {
    id: 'm1',
    title: 'while loop basics',
    description: 'explain what a while loop does',
    status: 'active',
    context: [],
    ...over,
  };
}

describe('teachPrompt', () => {
  it('lesson start: greets once, includes the milestone card (full description, never the ellipsized UI title)', () => {
    const p = teachPrompt(ms(), false);
    expect(p.user).toContain('very start of the lesson');
    expect(p.user).toContain('Greet the student warmly');
    expect(p.system).toContain('explain what a while loop does');
    expect(p.system).not.toContain('while loop basics'); // UI title never reaches the model
  });

  it('always carries the anti-role-play and honesty rules', () => {
    const p = teachPrompt(ms(), false);
    expect(p.system).toContain('NEVER write the student\'s lines');
    expect(p.system).toContain('BE HONEST');
    expect(p.system).toContain('praise a wrong answer');
  });

  it('nudges toward PRODUCE-the-answer questions (echo questions let parroting pass the grader)', () => {
    const p = teachPrompt(ms(), false);
    expect(p.system).toContain('PRODUCE');
    expect(p.system).toContain('repeating your words back');
  });

  it('demands a CHECKABLE question (an ungradable "what would you like to try?" got a student failed)', () => {
    const p = teachPrompt(ms(), false);
    expect(p.system).toContain('ONE specific correct answer');
    expect(p.system).toContain('Never ask the student what they would like to do next');
  });

  it('forbids self-answered questions and filler stubs (the live "…would be 0, 1, 2, 3, 4. What\'s your answer?")', () => {
    const p = teachPrompt(ms(), false);
    expect(p.system).toContain('Never answer your own question');
    expect(p.system).toContain('DIFFERENT case');
    expect(p.system).toContain('What\'s your answer?');
  });

  it('demands a concrete artifact ONLY on code-production milestones (elsewhere the rule was noise)', () => {
    const codeMs = ms({ description: 'Write a while loop that counts to 10' });
    const p = teachPrompt(codeMs, false);
    expect(p.system).toContain('INVENT a tiny concrete example');
    expect(p.system).toContain('SHOW it');
    expect(p.system).toContain('skill in the abstract');
    // conceptual milestone → the rule is omitted (prompt stays short)
    expect(teachPrompt(ms(), false).system).not.toContain('INVENT a tiny concrete example');
  });

  it('pins the lesson topic and language when provided (`var result = True;` shipped in a Python lesson)', () => {
    const p = teachPrompt(ms(), false, undefined, 0, { lessonTopic: 'Booleans and comparisons', language: 'Python' });
    expect(p.system).toContain('LESSON: Booleans and comparisons.');
    expect(p.system).toContain('valid Python');
    expect(p.system).toContain('no var/let/const');
    expect(teachPrompt(ms(), false).system).not.toContain('valid Python'); // absent without a language
  });

  it('transition: forbids greeting and milestone meta-talk, renders the bridge', () => {
    const p = teachPrompt(ms(), true, {
      completedTitle: 'loop conditions',
      lastStudentMessage: 'it stops when false',
      mastered: true,
    });
    expect(p.system).toContain('Do NOT greet');
    expect(p.system).toContain('NEVER mention lessons, milestones, steps');
    expect(p.user).toContain('loop conditions');
    expect(p.user).toContain('it stops when false');
    expect(p.user).toContain('correctly worked through');
    expect(p.user).not.toContain('very start of the lesson');
  });

  it('transition: states the new focus imperatively (the observed drift asked about a different topic)', () => {
    const p = teachPrompt(ms(), true, {
      completedTitle: 'loop conditions',
      lastStudentMessage: 'it stops when false',
      mastered: true,
    });
    expect(p.user).toContain('MUST be about exactly this');
    expect(p.user).toContain('explain what a while loop does');
  });

  it('clarifying turns get re-explain framing instead of the assessor gap note (the live "Not quite" at a confused student)', () => {
    const context: Milestone['context'] = [
      { role: 'tutor', text: 'What is `not in`?' },
      { role: 'student', text: "I didn't understand what u say" },
    ];
    const p = teachPrompt(ms({ context }), false, undefined, 0, { clarifying: true, graderEvidence: 'ignored when clarifying' });
    expect(p.user).toContain('asked for clarification');
    expect(p.user).toContain('they were NOT wrong');
    expect(p.user).not.toContain('Address this specific gap');
  });

  it('grader evidence renders in the mid-milestone user prompt — and only when provided', () => {
    const context: Milestone['context'] = [
      { role: 'tutor', text: 'What does a while loop do?' },
      { role: 'student', text: 'it loops forever' },
    ];
    const withEvidence = teachPrompt(ms({ context }), false, undefined, 1, {
      graderEvidence: 'did not mention the condition',
    });
    expect(withEvidence.user).toContain('did not mention the condition');
    expect(withEvidence.user).toContain('Address this specific gap');
    const without = teachPrompt(ms({ context }), false, undefined, 1, {});
    expect(without.user).not.toContain('Address this specific gap');
  });

  it('a non-mastered bridge (impasse force-advance) must not congratulate', () => {
    const p = teachPrompt(ms(), true, {
      completedTitle: 'loop conditions',
      lastStudentMessage: 'I still do not get it',
      mastered: false,
    });
    expect(p.user).toContain('do NOT congratulate');
    expect(p.user).not.toContain('correctly worked through');
    expect(p.user).not.toContain('confirm they were right');
  });

  it('escalation ladder: attempts change the teaching move, not just the words', () => {
    const base = teachPrompt(ms(), false, undefined, 0);
    expect(base.system).not.toContain('missed this');
    const retry = teachPrompt(ms(), false, undefined, 1);
    expect(retry.system).toContain('DIFFERENT way');
    const hint = teachPrompt(ms(), false, undefined, 2);
    expect(hint.system).toContain('concrete hint');
    const worked = teachPrompt(ms(), false, undefined, 3);
    expect(worked.system).toContain('worked example');
    expect(worked.system).toContain('STOP asking them to produce');
  });

  it('mid-milestone: renders the isolated context and the latest student message', () => {
    const p = teachPrompt(
      ms({
        context: [
          { role: 'tutor', text: 'What does a while loop do?' },
          { role: 'student', text: 'maybe it repeats?' },
        ],
      }),
      false,
    );
    expect(p.user).toContain('Tutor: What does a while loop do?');
    expect(p.user).toContain('Student: maybe it repeats?');
    expect(p.user).toContain('The student\'s latest message was: "maybe it repeats?"');
    expect(p.system).toContain('do NOT greet');
  });

  it('mid-milestone: carries the silent relevance gate; opening/transition turns do not', () => {
    const mid = teachPrompt(ms({ context: [{ role: 'student', text: 'who won the world cup?' }] }), false);
    expect(mid.system).toContain('COMPLETELY unrelated');
    expect(mid.system).toContain('Never mention this rule');
    expect(teachPrompt(ms(), false).system).not.toContain('COMPLETELY unrelated'); // lesson start
    expect(
      teachPrompt(ms(), true, { completedTitle: 'x', lastStudentMessage: 'y', mastered: true }).system,
    ).not.toContain('COMPLETELY unrelated'); // transition
  });

  it('mid-milestone context is bounded by the window (old turns drop out)', () => {
    const context = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 ? 'student' : 'tutor') as 'student' | 'tutor',
      text: `turn-number-${i}`,
    }));
    const p = teachPrompt(ms({ context }), false);
    expect(p.user).not.toContain('turn-number-0');
    expect(p.user).toContain('turn-number-11');
  });
});

describe('assessPrompt', () => {
  it('grades ONLY the single milestone, demands student evidence, asks for JSON', () => {
    const p = assessPrompt(ms({ context: [{ role: 'student', text: 'loops repeat until false' }] }));
    expect(p.system).toContain('this single');
    expect(p.system).toContain('being told the answer is not enough');
    expect(p.system).toContain('"achieved": true|false');
    expect(p.user).toContain('MILESTONE: explain what a while loop does'); // description, not the UI title
    expect(p.user).not.toContain('while loop basics');
    expect(p.user).toContain('Student: loops repeat until false');
  });

  it('judges substance over phrasing (approved 2026-07-04: a correct terse answer was failed for not echoing the milestone wording)', () => {
    const p = assessPrompt(ms({ context: [{ role: 'student', text: 'count 0 1 2' }] }));
    expect(p.system).toContain("student's own words counts as evidence");
    expect(p.system).toContain('substance, not the phrasing');
  });

  it('scope counterweight: list-ALL / VERIFY milestones need more than one example ("time if the year" passed live)', () => {
    const p = assessPrompt(ms());
    expect(p.system).toContain('list ALL');
    expect(p.system).toContain('VERIFY');
    expect(p.system).toContain('not sufficient evidence');
  });
});

describe('syncPrompt', () => {
  it('requires per-id student evidence and defaults to none', () => {
    const completed = ms({ context: [{ role: 'student', text: 'I get it now' }] });
    const remaining = [
      ms({ id: 'm2', description: 'prevent infinite loops' }),
      ms({ id: 'm3', description: 'write a full while loop' }),
    ];
    const p = syncPrompt(completed, remaining);
    expect(p.system).toContain('be conservative');
    expect(p.system).toContain('Usually the correct answer is NONE');
    expect(p.system).toContain('"evidence"');
    expect(p.user).toContain('m2: prevent infinite loops'); // description, not the UI title
    expect(p.user).toContain('m3: write a full while loop');
    expect(p.user).toContain('Student: I get it now');
  });

  it('sync context is bounded (a long milestone cannot blow up the prompt)', () => {
    const context = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 ? 'student' : 'tutor') as 'student' | 'tutor',
      text: `turn-number-${i}`,
    }));
    const p = syncPrompt(ms({ context }), [ms({ id: 'm2' })]);
    expect(p.user).not.toContain('turn-number-0');
    expect(p.user).toContain('turn-number-39');
  });
});

describe('suggestionsPrompt', () => {
  it('forbids handing over the answer, with the multiple-choice exception', () => {
    const p = suggestionsPrompt('What stops a while loop?', 'while loop basics');
    expect(p.system).toContain('do NOT give away the answer');
    expect(p.system).toContain('Never state the full correct answer');
    expect(p.system).toContain('EXCEPTION — multiple-choice');
    expect(p.user).toContain('What stops a while loop?');
  });
});

describe('classifyPrompt / expandPrompt / refinePrompt', () => {
  it('classifyPrompt is a symmetric one-word binary — no split template to imitate', () => {
    const p = classifyPrompt('While loops', 'Understand the loop condition', 0, 2);
    expect(p.system).toContain('ATOMIC or SPLIT');
    expect(p.system).toContain('both answers are equally common');
    expect(p.system).not.toContain('subGoals'); // nothing to copy → no framing bias
    expect(p.user).toContain('Understand the loop condition');
    expect(p.user).toContain('the more likely it is already atomic');
  });

  it('classifyPrompt stays NEUTRAL at every depth — prompt-side depth bias proved useless (0/3 deep ATOMIC); the deterministic pre-gate owns deep leafing', () => {
    const deep = classifyPrompt('While loops', 'Understand the loop condition', 1, 2);
    expect(deep.user).not.toContain('almost always ATOMIC');
    expect(deep.user).toContain('the more likely it is already atomic'); // the gentle factual note only
  });

  it('expandPrompt only splits (classify owns the decision) but keeps the atomic escape hatch', () => {
    const p = expandPrompt('Understand the loop condition');
    expect(p.system).toContain('2 or 3 smaller');
    expect(p.system).toContain('{"atomic": true}'); // escape hatch for a mis-classified goal
    expect(p.user).toContain('Understand the loop condition');
  });

  it('expandPrompt carries NO worked example, NO lesson context, and NO recursion meta-text — all three leaked into plans (observed live)', () => {
    const p = expandPrompt('Translate the table into code');
    expect(p.system).not.toContain('Example');
    expect(p.system).not.toContain('`for` loop'); // the exact contamination from the first trace
    expect(p.user).not.toContain('Lesson context'); // the title bled "indentation" into `=` vs `==` sub-goals
    // "(Recursion depth 1 of max 2)" spawned literal recursion-depth curriculum in a
    // decision-tables lesson — the splitter sees ONLY the goal.
    expect(p.user).not.toContain('Recursion depth');
    expect(p.user).not.toContain('depth');
  });

  it('expandPrompt forbids the single-sub-goal rephrase (the observed small-model failure)', () => {
    const p = expandPrompt('Understand the loop condition');
    expect(p.system).toContain('MUST contain 2 or 3 items');
    expect(p.system).toContain('ONE sub-goal is never a split');
    expect(p.system).toContain('must NOT restate the parent goal');
    // The JSON template itself shows TWO entries — small models copy the shape they see.
    expect(p.system.match(/"title": "<3-6 words>"/g)).toHaveLength(2);
  });

  it('expandPrompt and refinePrompt demand SELF-CONTAINED steps (a bare "the variable" leaf taught and graded terribly live)', () => {
    expect(expandPrompt('Understand the loop condition').system).toContain('ON ITS OWN');
    expect(refinePrompt(['goal A'], ['step 1', 'step 2']).system).toContain('ON ITS OWN');
  });

  it('refinePrompt demands merge/dedupe/order and one step per line', () => {
    const p = refinePrompt(['goal A', 'goal B'], ['step 1', 'step 1 again', 'step 2']);
    expect(p.system).toContain('MERGES duplicate');
    expect(p.system).toContain('ORDERED by dependency');
    expect(p.system).toContain('ONE step per line');
    expect(p.user).toContain('1. goal A');
    expect(p.user).toContain('- step 1 again');
  });

  it('refinePrompt forbids padding — a 2-step draft came back as 5 with practice/review filler (observed live)', () => {
    const p = refinePrompt(['goal A'], ['step 1', 'step 2']);
    expect(p.system).not.toContain('Aim for 3 to 7'); // the global-refine guidance that invited padding
    expect(p.system).toContain('NEVER add generic practice, review, or recap steps');
    expect(p.system).toContain('ADDS a step ONLY if some part of the goal is taught by NO draft step');
    expect(p.system).toContain('fewer is better than padded');
  });
});

describe('coveragePrompt', () => {
  it('enumerates requirements ONLY — the covered decision is deterministic (the yes/no version rubber-stamped a lossy plan)', () => {
    const p = coveragePrompt({ id: 'g1', statement: 'Understand while loops and when they beat for loops' });
    expect(p.system).toContain('ONE lesson goal for COVERAGE');
    expect(p.system).toContain('one per line');
    expect(p.system).toContain('Do NOT invent requirements');
    expect(p.system).not.toContain('"covered"'); // no verdict for a yes-biased model to rubber-stamp
    expect(p.user).toContain('Understand while loops and when they beat for loops');
  });
});

describe('REPETITION_NOTE', () => {
  it('demands genuinely new content with a concrete change of example', () => {
    expect(REPETITION_NOTE).toContain('genuinely NEW');
    expect(REPETITION_NOTE).toContain('different numbers');
  });
});

describe('EXPLAIN_FIRST_NOTE / syntaxNote', () => {
  it('EXPLAIN_FIRST_NOTE demands explanation or a worked example before the question', () => {
    expect(EXPLAIN_FIRST_NOTE).toContain('only questions');
    expect(EXPLAIN_FIRST_NOTE).toContain('worked example');
  });

  it('syntaxNote names the required language', () => {
    expect(syntaxNote('Python')).toContain('NOT valid Python');
    expect(syntaxNote('Python')).toContain('valid Python');
  });

  it('VACUOUS_QUESTION_NOTE demands a different, checkable case', () => {
    expect(VACUOUS_QUESTION_NOTE).toContain('no checkable answer');
    expect(VACUOUS_QUESTION_NOTE).toContain('DIFFERENT case');
    expect(VACUOUS_QUESTION_NOTE).toContain('NOT already stated');
  });

  it('EXPLAIN_FIRST_NOTE now demands the question target a case the example did NOT answer', () => {
    expect(EXPLAIN_FIRST_NOTE).toContain('DIFFERENT case');
  });
});

describe('offTopicNote', () => {
  it('names the required focus and the drift', () => {
    const note = offTopicNote('Break down the components of a `while` loop.');
    expect(note).toContain('DIFFERENT topic');
    expect(note).toContain('Break down the components of a `while` loop.');
  });
});

describe('completionPrompt', () => {
  it('congratulates by lesson title without asking a question', () => {
    const p = completionPrompt({ id: 'x', title: 'Meet the while loop', goals: [] });
    expect(p.user).toContain('Meet the while loop');
    expect(p.user).toContain('Do not ask a question');
  });

  it('stays honest when milestones were force-advanced ("Beautifully done" after zero mastery, harness iter1)', () => {
    const p = completionPrompt({ id: 'x', title: 'Meet the while loop', goals: [] }, { total: 3, struggled: 2 });
    expect(p.user).toContain('2 of its 3 ideas');
    expect(p.user).toContain('Do NOT claim mastery');
    expect(p.user).not.toContain('Congratulate them warmly');
  });
});
