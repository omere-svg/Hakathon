// Tests for the recursive decomposer: bounded recursion (an erratic model can never run
// away), goal fallback, the per-goal refine pass, the parent-rephrase rail, the near-dupe
// merge, the coverage layers, and the LLM-call audit log.

import { describe, expect, it } from 'vitest';
import {
  contextualizeLeaf,
  decomposeRecursive,
  DEFAULT_LIMITS,
  goalClauses,
  inheritBackticks,
  isSelfEvidentLeaf,
  isSplitVerdict,
  stripSpecVoice,
} from './decompose';
import type { LessonBrief } from '../api';
import type { LLMEngine } from '../../llm/types';

const brief: LessonBrief = {
  id: 'l1',
  title: 'Loop control: break and continue',
  goals: [
    { id: 'g1', statement: 'Understand when to exit a loop early with `break`.' },
    { id: 'g2', statement: 'Insert `continue` to skip an iteration.' },
  ],
};

/** Stub LLM routed by prompt markers: classify vs expand vs refine vs coverage.
 *  classify defaults to SPLIT so split-fixture tests flow into the expand handler;
 *  tests about the classify verdict itself override it. */
function stub(handlers: {
  classify?: (system: string, user: string) => string;
  expand?: (system: string, user: string) => string;
  refine?: (system: string, user: string) => string;
  coverage?: (system: string, user: string) => string;
}): LLMEngine {
  return {
    name: 'stub',
    onDevice: true,
    async complete(system: string, user: string): Promise<string> {
      if (system.includes('ATOMIC or SPLIT')) return handlers.classify?.(system, user) ?? 'SPLIT';
      if (system.includes('RECURSIVE decomposition')) return handlers.expand?.(system, user) ?? '{"atomic": true}';
      if (system.includes('finalizing a lesson plan')) return handlers.refine?.(system, user) ?? '';
      if (system.includes('lesson goal for COVERAGE')) return handlers.coverage?.(system, user) ?? '';
      throw new Error(`unexpected prompt: ${system.slice(0, 60)}`);
    },
  };
}

describe('decomposeRecursive', () => {
  it('atomic goals map 1:1 to milestones (single-leaf goals skip the refine pass)', async () => {
    const r = await decomposeRecursive(brief, stub({ expand: () => '{"atomic": true}', refine: () => 'nope' }));
    expect(r.milestones).toHaveLength(2);
    expect(r.stats.refined).toBe(false);
    expect(r.stats.rawLeaves).toBe(2);
    expect(r.stats.appended).toBe(0);
    expect(r.milestones[0].description).toContain('break');
    expect(r.milestones[1].description).toContain('continue');
    expect(r.milestones.every((m) => m.status === 'pending' && m.context.length === 0)).toBe(true);
  });

  it('a pathological always-split model is bounded by the depth/leaf caps and terminates', async () => {
    let n = 0;
    const r = await decomposeRecursive(
      brief,
      stub({
        expand: () => {
          n++;
          return JSON.stringify({
            atomic: false,
            subGoals: [
              { title: `sub-${n}-a`, description: `piece n${n} alpha` },
              { title: `sub-${n}-b`, description: `piece n${n} beta` },
              { title: `sub-${n}-c`, description: `piece n${n} gamma` },
            ],
          });
        },
        refine: () => '',
      }),
    );
    expect(r.stats.maxDepthReached).toBeLessThanOrEqual(DEFAULT_LIMITS.maxDepth);
    expect(r.milestones.length).toBeGreaterThan(0);
    // No call metering anymore (product ruling: decomposition may be call-heavy) — the leaf
    // budget is what stops the runaway.
    expect(r.stats.rawLeaves).toBeLessThanOrEqual(DEFAULT_LIMITS.maxLeaves + DEFAULT_LIMITS.maxSubGoals * 2);
  });

  it('an under-split answer (atomic:false, ONE sub-goal) gets one corrective retry and uses its split', async () => {
    // First expand per node: a single sub-goal (a rephrase — the observed Qwen failure).
    // The :fix retry returns a proper 2-way split; deeper nodes are atomic.
    const r = await decomposeRecursive(
      brief,
      stub({
        expand: (_s, user) => {
          if (user.includes('only ONE sub-goal')) {
            return '{"atomic": false, "subGoals": [{"title": "part alpha", "description": "do part alpha"}, {"title": "part beta", "description": "do part beta"}]}';
          }
          if (user.includes('Goal to split: Understand when') || user.includes('Goal to split: Insert')) {
            return '{"atomic": false, "subGoals": [{"title": "rephrase", "description": "the same goal again"}]}';
          }
          return '{"atomic": true}';
        },
        refine: () => '',
      }),
    );
    // Both goals split via the corrective retry into the SAME two steps — the cross-goal
    // near-dupe merge collapses them (provenance keeps both goals covered, so no backstop).
    expect(r.milestones.map((m) => m.description)).toEqual(['do part alpha', 'do part beta']);
    expect(r.stats.appended).toBe(0);
    expect(r.calls.filter((c) => c.label === 'decompose:expand@d0:fix')).toHaveLength(2);
  });

  it('still under-split after the corrective retry → the goal stays a leaf, never the rephrase', async () => {
    const r = await decomposeRecursive(
      brief,
      stub({
        expand: () => '{"atomic": false, "subGoals": [{"title": "rephrase", "description": "the same goal again"}]}',
        refine: () => '',
      }),
    );
    expect(r.milestones).toHaveLength(2);
    expect(r.milestones[0].description).toContain('break'); // the original goal, not "the same goal again"
    expect(r.milestones[1].description).toContain('continue');
  });

  // Field-observed Qwen3-1.7B failure shapes: the split itself is usually right, but the
  // JSON wrapper is broken. These fixtures mirror real dev-panel traces.
  const oneGoal: LessonBrief = {
    id: 'l2',
    title: 'Loop control',
    goals: [{ id: 'g1', statement: 'Understand `break`.' }],
  };

  it('salvages a split from DUPLICATE "subGoals" keys (JSON.parse keeps only the last)', async () => {
    const dupKeys =
      '{"atomic": false, "subGoals": [{"title": "A", "description": "use break to exit"}], ' +
      '"subGoals": [{"title": "B", "description": "use continue to skip"}], ' +
      '"subGoals": [{"title": "C", "description": "let the loop finish"}]}';
    const r = await decomposeRecursive(
      oneGoal,
      stub({ expand: (_s, user) => (user.includes('Goal to split: Understand') ? dupKeys : '{"atomic": true}'), refine: () => '' }),
    );
    expect(r.milestones.map((m) => m.description)).toEqual([
      'use break to exit',
      'use continue to skip',
      'let the loop finish',
    ]);
    // The salvage recovered the split directly — no retry or fix call was needed.
    expect(r.calls.every((c) => !c.label.includes(':retry') && !c.label.includes(':fix'))).toBe(true);
  });

  it('salvages a split from naked arrays between items (invalid JSON) and placeholder titles', async () => {
    const nakedArrays =
      '{"atomic": false, "subGoals": [{"title": "3-6 words", "description": "Identify the condition to exit early"}], ' +
      '[{"title": "<3-6 words>", "description": "Insert `break` into the code"}], ' +
      '[{"title": "3-6 words", "description": "Test the loop exit"}]}';
    const r = await decomposeRecursive(
      oneGoal,
      stub({ expand: (_s, user) => (user.includes('Goal to split: Understand') ? nakedArrays : '{"atomic": true}'), refine: () => '' }),
    );
    expect(r.milestones.map((m) => m.description)).toEqual([
      'Identify the condition to exit early',
      'Insert `break` into the code',
      'Test the loop exit',
    ]);
    // Template placeholders must never become milestone titles.
    for (const m of r.milestones) expect(m.title).not.toMatch(/3-6 words/);
  });

  it('dedupes repeated sub-goals from a looping model (same description = same goal)', async () => {
    const repeats =
      '{"atomic": false, "subGoals": [{"title": "A", "description": "same thing"}, ' +
      '{"title": "B", "description": "Same Thing"}, {"title": "C", "description": "different thing"}]}';
    const r = await decomposeRecursive(
      oneGoal,
      stub({ expand: (_s, user) => (user.includes('Goal to split: Understand') ? repeats : '{"atomic": true}'), refine: () => '' }),
    );
    expect(r.milestones.map((m) => m.description)).toEqual(['same thing', 'different thing']);
  });

  it('PROGRESSIVE variants survive dedupe (trace fixture): the range() 3-way split must not collapse', async () => {
    // Live call 2, for-loops trace: the model's best-ever split — valid JSON, three variants
    // whose descriptions are wordwise supersets of each other. Containment dedupe (round 5)
    // wrongly collapsed them to one and the goal degraded to a leaf.
    const rangeSplit =
      '{"atomic": false, "subGoals": [' +
      '{"title": "range(stop)", "description": "Demonstrate range with stop parameter"}, ' +
      '{"title": "range(start, stop)", "description": "Demonstrate range with start and stop parameters"}, ' +
      '{"title": "range(start, stop, step)", "description": "Demonstrate range with start, stop and step parameters"}]}';
    const r = await decomposeRecursive(
      oneGoal,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Understand') ? rangeSplit : '{"atomic": true}'),
        refine: () => '',
      }),
    );
    expect(r.milestones.map((m) => m.description)).toEqual([
      'Demonstrate range with stop parameter',
      'Demonstrate range with start and stop parameters',
      'Demonstrate range with start, stop and step parameters',
    ]);
    // The valid first answer must be accepted as-is — no corrective fix call.
    expect(r.calls.some((c) => c.label.includes(':fix'))).toBe(false);
  });

  it('dedupes WORD-SWAPPED sub-goals (trace fixture): the same goal reversed must not spawn two subtrees', async () => {
    // Live call 6, if/else trace: two "children" that are one goal with the order flipped.
    const swapped =
      '{"atomic": false, "subGoals": [' +
      '{"title": "Define assignment `=`", "description": "Explain the difference between assignment and equality in programming"}, ' +
      '{"title": "Define equality `==`", "description": "Explain the difference between equality and assignment in programming"}]}';
    let deepExpands = 0;
    const r = await decomposeRecursive(
      oneGoal,
      stub({
        expand: (_s, user) => {
          if (user.includes('Goal to split: Understand')) return swapped;
          deepExpands++;
          return '{"atomic": true}';
        },
        refine: () => '',
      }),
    );
    // The pair collapses to ONE sub-goal → under-split → corrective retry also returns the
    // swapped pair → still 1 → the goal stays a single leaf. No parallel duplicate subtrees.
    expect(deepExpands).toBe(0);
    expect(r.milestones).toHaveLength(1);
    expect(r.milestones[0].description).toContain('break'); // the original goal
  });

  it('PARENT-REPHRASE rail (trace fixture): a sub-goal titled as the parent verbatim is rejected, forcing the corrective retry', async () => {
    // Literal shape of dev-panel call 3 (2026-07-02): "split" of "Define what a `while` loop
    // is." whose FIRST sub-goal is the parent itself — recursing on it re-decomposed the
    // same goal a level deeper.
    const defineGoal: LessonBrief = {
      id: 'l3',
      title: 'Meet the `while` loop',
      goals: [{ id: 'g1', statement: 'Define what a `while` loop is.' }],
    };
    const traceSplit =
      '{"atomic": false, "subGoals": [{"title": "Define what a `while` loop is", "description": "Define what a `while` loop is."}, ' +
      '{"title": "Identify the loop control structure", "description": "Clarify the role of the `while` condition in the loop."}]}';
    const r = await decomposeRecursive(
      defineGoal,
      stub({
        expand: (_s, user) => {
          if (user.includes('only ONE sub-goal')) return '{"atomic": true}'; // model concedes on the retry
          if (user.includes('Goal to split: Define what')) return traceSplit;
          return '{"atomic": true}';
        },
        refine: () => '',
      }),
    );
    // The parent-copy was rejected, the retry said atomic → the goal stays ONE leaf.
    expect(r.calls.some((c) => c.label === 'decompose:expand@d0:fix')).toBe(true);
    expect(r.milestones).toHaveLength(1);
    expect(r.milestones[0].description).toBe('Define what a `while` loop is.');
  });

  it('TITLE-TIER (trace fixture): a legitimate split whose title merely RESEMBLES the parent is accepted', async () => {
    // Live decision-tables trace: "Verify mutual exclusivity of conditions" under "Verify
    // mutual exclusivity and completeness of the conditions" — title jaccard exactly 0.80.
    // The old 0.8 title check vetoed this valid split; only a verbatim-ish title rejects.
    const verifyGoal: LessonBrief = {
      id: 'l5',
      title: 'Decision tables to branching logic',
      goals: [{ id: 'g1', statement: 'Verify mutual exclusivity and completeness of the conditions.' }],
    };
    const goodSplit =
      '{"atomic": false, "subGoals": [' +
      '{"title": "Verify mutual exclusivity of conditions", "description": "Check that only one condition can be true at a time"}, ' +
      '{"title": "Verify completeness of conditions", "description": "Ensure all possible conditions are accounted for"}]}';
    const r = await decomposeRecursive(
      verifyGoal,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Verify') ? goodSplit : '{"atomic": true}'),
        refine: () => '',
      }),
    );
    // Both split steps accepted as-is. (The clause fallback net then appends a redundant
    // "Verify mutual exclusivity" step — the split covers it semantically but not
    // lexically; known synonym-gap redundancy, chosen over silent loss.)
    expect(r.milestones.map((m) => m.description).slice(0, 2)).toEqual([
      'Check that only one condition can be true at a time',
      'Ensure all possible conditions are accounted for',
    ]);
    expect(r.calls.some((c) => c.label.includes(':fix'))).toBe(false); // accepted first try
  });

  it('`"]]` REPAIR (trace fixture): the thrice-lost and/or/not split is finally recovered', async () => {
    // Live logical-operators trace: the model produced this correct 3-way split THREE times,
    // and every answer closed its sub-goals with `"]]` instead of `"}` — unrecoverable by
    // the old salvage, so both goals degraded to statement leaves.
    const brokenClosers =
      '{"atomic": false, "subGoals": [{"title": "Form compound conditions with `and`", "description": "Create logical statements that use `and` to combine conditions"]], ' +
      '"subGoals": [{"title": "Form compound conditions with `or`", "description": "Create logical statements that use `or` to combine conditions"]], ' +
      '"subGoals": [{"title": "Form compound conditions with `not`", "description": "Create logical statements that use `not` to negate conditions"}]}';
    const logicGoal: LessonBrief = {
      id: 'l6',
      title: 'Logical operators',
      goals: [{ id: 'g1', statement: 'Combine comparisons with `and`, `or`, and `not` to form compound conditions.' }],
    };
    const r = await decomposeRecursive(
      logicGoal,
      stub({
        classify: (_s, user) => (user.includes('Combine comparisons') ? 'SPLIT' : 'ATOMIC'),
        expand: (_s, user) => (user.includes('Goal to split: Combine') ? brokenClosers : '{"atomic": true}'),
        refine: () => '',
      }),
    );
    // All three sub-goals recovered — and NOT deduped, because backticked `and`/`or`/`not`
    // now count as content words (they are the only distinguishing token).
    expect(r.milestones.map((m) => m.description)).toEqual([
      'Create logical statements that use `and` to combine conditions',
      'Create logical statements that use `or` to combine conditions',
      'Create logical statements that use `not` to negate conditions',
    ]);
    expect(r.calls.some((c) => c.label.includes(':retry') || c.label.includes(':fix'))).toBe(false);
  });

  it('OVER-SPLIT (counters trace fixture): a 6-way split is kept WHOLE as leaves — never sliced to 3', async () => {
    // Live counters trace: the model returned six perfectly good micro-goals (in broken
    // JSON, salvaged by harvest); the old slice(0, 3) kept only the setup half and silently
    // deleted both "update … inside the loop" sub-goals — the core of the lesson.
    const sixWay =
      '{"atomic": false, "subGoals": [{"title": "identify the counter variable", "description": "define and declare a counter variable in the code"}], ' +
      '[{"title": "identify the running total variable", "description": "define and declare a running total variable in the code"}], ' +
      '[{"title": "initialize counter variable", "description": "assign an initial value to the counter variable"}], ' +
      '[{"title": "initialize running total variable", "description": "assign an initial value to the running total variable"}], ' +
      '[{"title": "update counter variable", "description": "modify the counter variable within the loop"}], ' +
      '[{"title": "update running total variable", "description": "modify the running total variable within the loop"}]}';
    const counters: LessonBrief = {
      id: 'l7',
      title: 'Counters and totals',
      goals: [{ id: 'g1', statement: 'Initialize and update a counter and running total correctly inside a loop.' }],
    };
    let deepClassifies = 0;
    const r = await decomposeRecursive(
      counters,
      stub({
        classify: (_s, user) => {
          if (user.includes('depth 1')) deepClassifies++;
          return 'SPLIT';
        },
        expand: (_s, user) => (user.includes('Goal to split: Initialize') ? sixWay : '{"atomic": true}'),
        refine: () => '',
      }),
    );
    expect(r.milestones.map((m) => m.description)).toEqual([
      'define and declare a counter variable in the code',
      'define and declare a running total variable in the code',
      'assign an initial value to the counter variable',
      'assign an initial value to the running total variable',
      'modify the counter variable within the loop',
      'modify the running total variable within the loop',
    ]);
    // Over-split children are already micro-steps: leaves, no recursion on them.
    expect(deepClassifies).toBe(0);
    expect(r.stats.appended).toBe(0);
  });

  it('dedupes SETUP-VERB-SWAPPED sub-goals (counters trace): a define/declare "split" is one step', async () => {
    // Live d1 failure: "define and declare a counter variable" was "split" into a define
    // half and a declare half — the same step with the setup verb swapped. The pair must
    // collapse to one, making the answer an under-split (→ corrective retry → leaf).
    const verbSwap =
      '{"atomic": false, "subGoals": [{"title": "define a variable", "description": "create a variable named counter and assign it a initial value"}, ' +
      '{"title": "declare a variable", "description": "assign the counter variable a initial value"}]}';
    let deepExpands = 0;
    const r = await decomposeRecursive(
      oneGoal,
      stub({
        expand: (_s, user) => {
          if (user.includes('Goal to split: Understand')) return verbSwap;
          deepExpands++;
          return '{"atomic": true}';
        },
        refine: () => '',
      }),
    );
    expect(deepExpands).toBe(0); // no subtree was spawned for the duplicate pair
    expect(r.milestones).toHaveLength(1);
    expect(r.milestones[0].description).toContain('break'); // the original goal, not either half
  });

  describe('contextualizeLeaf (bare-referent backstop)', () => {
    it('anchors the live unanchored leaf: "assign a value to the variable" — WHICH variable?', () => {
      expect(
        contextualizeLeaf('assign a value to the variable', 'define and declare a running total variable in the code'),
      ).toBe('assign a value to the variable (for: define and declare a running total variable in the code)');
    });

    it('leaves a leaf alone when it already shares enough content with its parent', () => {
      expect(
        contextualizeLeaf(
          'modify the counter variable within the loop',
          'Initialize and update a counter and running total correctly inside a loop.',
        ),
      ).toBe('modify the counter variable within the loop');
    });

    it('leaves a self-contained leaf alone (no bare referent)', () => {
      expect(contextualizeLeaf('create a variable to hold a running total', 'anything else entirely')).toBe(
        'create a variable to hold a running total',
      );
    });

    it('root leaves (no parent) are never rewritten', () => {
      expect(contextualizeLeaf('assign a value to the variable', '')).toBe('assign a value to the variable');
    });
  });

  describe('inheritBackticks (booleans-trace backstop)', () => {
    it('re-wraps uppercase/symbol tokens the author backticked', () => {
      const goal = 'Use `True` and `False` with `==` in expressions.';
      expect(inheritBackticks('Compute the result of True and False using ==', goal)).toBe(
        'Compute the result of `True` and `False` using `==`',
      );
    });

    it('never wraps lowercase code words — bare "is"/"and" are prose everywhere', () => {
      const goal = 'Differentiate between `==` value equality and `is` identity equality.';
      expect(inheritBackticks('explain when it is more suitable', goal)).toBe('explain when it is more suitable');
    });

    it('does not double-wrap tokens that are already backticked', () => {
      expect(inheritBackticks('evaluate `True` and False', 'Use `True` and `False`.')).toBe(
        'evaluate `True` and `False`',
      );
    });
  });

  it('BACKTICK INHERITANCE (booleans trace): milestones get the author\'s code formatting back', async () => {
    // The live failure: the goal says "Use `True` and `False` in expressions…" but the
    // split came out bare — the tutor then read "True and False" as prose (two values)
    // instead of code (one expression) and asked about an expression it never showed.
    const bool: LessonBrief = {
      id: 'l9',
      title: 'Booleans and comparisons',
      goals: [{ id: 'g1', statement: 'Use `True` and `False` in expressions and store boolean results in variables.' }],
    };
    const split =
      '{"atomic": false, "subGoals": [{"title": "compute", "description": "Compute the result of True and False in a boolean expression"}, ' +
      '{"title": "assign", "description": "Assign the result of True and False to a variable"}]}';
    const r = await decomposeRecursive(
      bool,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Use') ? split : '{"atomic": true}'),
        refine: () => '',
      }),
    );
    expect(r.milestones.map((m) => m.description)).toEqual([
      'Compute the result of `True` and `False` in a boolean expression',
      'Assign the result of `True` and `False` to a variable',
    ]);
  });

  describe('stripSpecVoice (decision-tables trace)', () => {
    it('strips planner spec-language from step text', () => {
      expect(stripSpecVoice('The student must identify and explain the conditions.')).toBe(
        'identify and explain the conditions.',
      );
      expect(stripSpecVoice('The student should be able to name each branch')).toBe('name each branch');
    });

    it('leaves normal step text alone', () => {
      expect(stripSpecVoice('Identify and list all possible conditions')).toBe(
        'Identify and list all possible conditions',
      );
    });
  });

  describe('goalClauses', () => {
    it('splits multi-part goals on connectives, protecting backticked spans', () => {
      expect(goalClauses('Verify mutual exclusivity and completeness of the conditions.')).toEqual([
        'Verify mutual exclusivity',
        'completeness of the conditions',
      ]);
    });

    it('a single-idea goal is one clause (backticked `and` is an operator, not a connective)', () => {
      expect(goalClauses('Translate a 3-5 row decision table into clear `if/elif/else` code.')).toHaveLength(1);
      expect(goalClauses('Create logical statements that use `and` to combine conditions')).toHaveLength(1);
    });
  });

  it('SPEC-VOICE integration: planner language never reaches milestone text', async () => {
    const split =
      '{"atomic": false, "subGoals": [{"title": "identify", "description": "Identify and list all possible conditions"}, ' +
      '{"title": "explain", "description": "The student must explain why conditions never overlap"}]}';
    const r = await decomposeRecursive(
      oneGoal,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Understand') ? split : '{"atomic": true}'),
        refine: () => '',
      }),
    );
    expect(r.milestones.map((m) => m.description)).toEqual([
      'Identify and list all possible conditions',
      'explain why conditions never overlap',
    ]);
  });

  it('CLAUSE NET (decision-tables trace): a lost goal half is re-appended when the enumerator returns nothing', async () => {
    // Live: "Verify mutual exclusivity AND completeness" decomposed into two condition-listing
    // steps; mutual exclusivity vanished and the model-side audit appended nothing.
    const dt: LessonBrief = {
      id: 'l10',
      title: 'Decision tables',
      goals: [{ id: 'g1', statement: 'Verify mutual exclusivity and completeness of the conditions.' }],
    };
    const split =
      '{"atomic": false, "subGoals": [{"title": "identify", "description": "Identify and list all possible conditions"}, ' +
      '{"title": "explain", "description": "The student must identify and explain the conditions."}]}';
    const r = await decomposeRecursive(
      dt,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Verify') ? split : '{"atomic": true}'),
        refine: () => '',
        coverage: () => '', // the enumerator yields nothing — the deterministic net must catch it
      }),
    );
    expect(r.stats.appended).toBe(1);
    expect(r.milestones.map((m) => m.description)).toContain('Verify mutual exclusivity');
  });

  it('FOREIGN-LANGUAGE sub-goals are rejected (iter2: "Explain what `is` does in JavaScript" in a Python lesson)', async () => {
    const pyGoal: LessonBrief = {
      id: 'l11',
      title: 'Equality vs identity',
      language: 'Python',
      goals: [{ id: 'g1', statement: 'Differentiate between `==` value equality and `is` identity equality.' }],
    };
    const jsSplit =
      '{"atomic": false, "subGoals": [{"title": "js is", "description": "Explain what `is` does in JavaScript"}, ' +
      '{"title": "eq", "description": "Explain what `==` compares in a condition"}]}';
    const r = await decomposeRecursive(
      pyGoal,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Differentiate') ? jsSplit : '{"atomic": true}'),
        refine: () => '',
      }),
    );
    // The JS sub-goal is rejected → under-split → corrective retry returns it again →
    // still under-split → the goal stays ONE whole leaf. No JavaScript milestone.
    expect(r.milestones).toHaveLength(1);
    expect(r.milestones[0].description).toBe('Differentiate between `==` value equality and `is` identity equality.');
    expect(r.milestones.some((m) => /javascript/i.test(m.description))).toBe(false);
  });

  it('garbage model output degrades to leaves (goal per milestone), never throws', async () => {
    const r = await decomposeRecursive(brief, stub({ expand: () => 'I like teaching loops!', refine: () => '' }));
    expect(r.milestones).toHaveLength(2);
  });

  it('a throwing model degrades to leaves, never throws outward', async () => {
    const llm: LLMEngine = {
      name: 'boom',
      onDevice: true,
      complete: async () => {
        throw new Error('gpu died');
      },
    };
    const r = await decomposeRecursive(brief, llm);
    expect(r.milestones).toHaveLength(2);
  });

  it('per-goal refine consolidates each goal; identical cross-goal steps merge deterministically', async () => {
    const threeWay = JSON.stringify({
      atomic: false,
      // Distinct word sets — a subset pair would (correctly) collapse in the
      // overlap dedupe and never reach the refine pass this test exercises.
      subGoals: [
        { title: 'understand break behavior', description: 'understand break behavior' },
        { title: 'practice continue statements', description: 'practice continue statements' },
        { title: 'trace loop exit flow', description: 'trace loop exit flow' },
      ],
    });
    const r = await decomposeRecursive(
      brief,
      stub({
        expand: (_s, user) =>
          user.includes('Goal to split: Understand') || user.includes('Goal to split: Insert')
            ? threeWay
            : '{"atomic": true}',
        refine: () => 'Understand `break`\nUse `break` on a condition\nUse `continue` to skip',
      }),
    );
    expect(r.stats.refined).toBe(true);
    // Both goals refined to the SAME 3 steps → merged back to 3, provenance covering both.
    expect(r.milestones.map((m) => m.title)).toEqual([
      'Understand `break`',
      'Use `break` on a condition',
      'Use `continue` to skip',
    ]);
    expect(r.milestones.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(r.stats.appended).toBe(0); // merge absorbed provenance — no goal lost, no backstop
  });

  it('a ≤2-step draft SKIPS the refine call entirely (a live 2-step draft came back as 1 — deletion channel closed)', async () => {
    const twoWay =
      '{"atomic": false, "subGoals": [{"title": "A", "description": "use break to exit"}, {"title": "B", "description": "use continue to skip"}]}';
    let refines = 0;
    const r = await decomposeRecursive(
      oneGoal,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Understand') ? twoWay : '{"atomic": true}'),
        refine: () => {
          refines++;
          return 'use break to exit'; // the deletion answer that cost range(step) live
        },
      }),
    );
    expect(refines).toBe(0); // never asked — nothing to consolidate at this size
    expect(r.stats.refined).toBe(false);
    expect(r.milestones.map((m) => m.description)).toEqual(['use break to exit', 'use continue to skip']);
  });

  it('a garbage ONE-LINE refine answer ("nope") is rejected — the draft is kept', async () => {
    const threeSteps =
      '{"atomic": false, "subGoals": [{"title": "A", "description": "use break to exit"}, ' +
      '{"title": "B", "description": "use continue to skip"}, {"title": "C", "description": "let the loop finish"}]}';
    const r = await decomposeRecursive(
      oneGoal,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Understand') ? threeSteps : '{"atomic": true}'),
        refine: () => 'nope',
      }),
    );
    expect(r.stats.refined).toBe(false);
    expect(r.milestones.map((m) => m.description)).toEqual([
      'use break to exit',
      'use continue to skip',
      'let the loop finish',
    ]);
  });

  it('REFINE PADDING CAP (trace fixture): a padded 3→5 refine answer is cut to draft+1', async () => {
    // Live shape from the if/else trace: real steps + the coverage-rescuing capstone + generic
    // practice/review fillers. The cap keeps consolidation + one addition.
    const threeSteps =
      '{"atomic": false, "subGoals": [' +
      '{"title": "eq", "description": "Use equality operator to check a variable value"}, ' +
      '{"title": "neq", "description": "Use inequality operator to reject a variable value"}, ' +
      '{"title": "chain", "description": "Combine comparisons in an if-elif chain"}]}';
    const padded = [
      'Use equality operator (==) to check if a variable is equal to a value',
      'Use inequality operator (!=) to check if a variable is not equal to a value',
      'Combine comparison operators in an if/elif chain',
      'Write and test a basic `if/else` statement with comparison operators',
      'Review and apply `if/else` logic to solve simple problems',
    ].join('\n');
    const r = await decomposeRecursive(
      oneGoal,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Understand') ? threeSteps : '{"atomic": true}'),
        refine: () => padded,
      }),
    );
    // draft (3) + 1 = 4: the three real steps and the capstone survive; the filler is cut.
    expect(r.milestones.map((m) => m.description)).toEqual([
      'Use equality operator (==) to check if a variable is equal to a value',
      'Use inequality operator (!=) to check if a variable is not equal to a value',
      'Combine comparison operators in an if/elif chain',
      'Write and test a basic `if/else` statement with comparison operators',
    ]);
  });

  it('per-goal refine output is capped at maxLeaves', async () => {
    const dupKeys =
      '{"atomic": false, "subGoals": [{"title": "A", "description": "use break to exit"}, ' +
      '{"title": "B", "description": "use continue to skip"}, {"title": "C", "description": "let the loop finish"}]}';
    const many = Array.from({ length: 20 }, (_, i) => `Teach concept w${i + 1}`).join('\n');
    const r = await decomposeRecursive(
      oneGoal,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Understand') ? dupKeys : '{"atomic": true}'),
        refine: () => many,
      }),
    );
    expect(r.milestones.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxLeaves);
  });

  it('COVERAGE AUDIT (enumerate-then-match): a requirement no step matches is re-appended as its own step', async () => {
    // The live failure shape: part of a goal vanished from the plan and the old yes/no audit
    // rubber-stamped it. Now the model enumerates the goal's requirements and the match is
    // deterministic — the two taught requirements match their steps, the lost one does not.
    const lost: LessonBrief = {
      id: 'l4',
      title: 'Meet the `while` loop',
      goals: [{ id: 'g1', statement: 'Understand what a `while` loop is and when it is more suitable than `for`.' }],
    };
    const r = await decomposeRecursive(
      lost,
      stub({
        expand: (_s, user) => {
          if (user.includes('more suitable than'))
            return '{"atomic": false, "subGoals": [{"title": "define", "description": "Define what a while loop is"}, {"title": "condition", "description": "Explain the loop condition"}]}';
          return '{"atomic": true}';
        },
        refine: () => '',
        coverage: () =>
          'define what a while loop is\nexplain the loop condition\nchoose when a `while` loop beats `for`',
      }),
    );
    expect(r.stats.appended).toBe(1);
    expect(r.milestones.map((m) => m.description)).toEqual([
      'Define what a while loop is',
      'Explain the loop condition',
      'choose when a `while` loop beats `for`',
    ]);
  });

  // Coverage-gate fixtures use a SPLIT goal (steps ≠ statement): statement-leaf goals now
  // skip the audit entirely (see the ATOMIC skip test below).
  const breakSplit =
    '{"atomic": false, "subGoals": [{"title": "exit", "description": "use break to exit"}, ' +
    '{"title": "finish", "description": "let the loop finish"}]}';
  const splitBreakStub = (coverage: () => string) =>
    stub({
      expand: (_s, user) => (user.includes('Goal to split: Understand') ? breakSplit : '{"atomic": true}'),
      refine: () => '',
      coverage,
    });

  it('ATOMIC statement-leaf goals SKIP the coverage call entirely (a degeneration loop appended junk rephrases live)', async () => {
    let coverageCalls = 0;
    const r = await decomposeRecursive(
      brief,
      stub({
        classify: () => 'ATOMIC',
        coverage: () => {
          coverageCalls++;
          return 'Order the conditions in the right way';
        },
      }),
    );
    expect(coverageCalls).toBe(0); // nothing was lost — nothing to audit
    expect(r.milestones).toHaveLength(2);
    expect(r.stats.appended).toBe(0);
  });

  it('INVENTED-REQUIREMENT gate: a requirement sharing nothing with the goal is ignored', async () => {
    const r = await decomposeRecursive(oneGoal, splitBreakStub(() => 'memorize recursion basics fully'));
    expect(r.milestones).toHaveLength(2);
    expect(r.stats.appended).toBe(0);
  });

  it('coverage audit does NOT append a requirement that already matches a step (STEMMED near-dup guard)', async () => {
    const r = await decomposeRecursive(oneGoal, splitBreakStub(() => 'Use `break` to exit.'));
    expect(r.milestones).toHaveLength(2);
    expect(r.stats.appended).toBe(0);
  });

  it('coverage appends are capped at 3 per goal (a chatty enumerator cannot flood the plan)', async () => {
    const r = await decomposeRecursive(
      oneGoal,
      splitBreakStub(() =>
        [
          'exit the loop early with `break`',
          'place `break` inside a conditional',
          'compare `break` with normal loop end',
          'predict output after `break` runs',
        ].join('\n'),
      ),
    );
    expect(r.stats.appended).toBe(3);
    expect(r.milestones).toHaveLength(5); // 2 split steps + 3 appends, never 6
  });

  it('GLUED-LINE requirements (for-loops trace): one long line of sentences is split and each gated separately', async () => {
    // Live coverage@g1 answered "Write … range(stop). Write … range(start, stop). Write …"
    // on ONE 24-word line; the prose gate discarded all of it and the lost variants stayed
    // lost. A long line that splits into sentences is a glued list, not prose.
    const vague: LessonBrief = {
      id: 'l8',
      title: 'For loops',
      goals: [{ id: 'g1', statement: 'Master `range` loop patterns.' }],
    };
    const rangeSplit =
      '{"atomic": false, "subGoals": [{"title": "recognize", "description": "Recognize a range call in code"}, ' +
      '{"title": "trace", "description": "Trace loop repetitions by hand"}]}';
    const r = await decomposeRecursive(
      vague,
      stub({
        expand: (_s, user) => (user.includes('Goal to split: Master') ? rangeSplit : '{"atomic": true}'),
        refine: () => '',
        coverage: () =>
          'Write a loop that counts upward from zero. Print each number the loop produces. Explain when the loop stops.',
      }),
    );
    expect(r.stats.appended).toBe(3);
    expect(r.milestones.map((m) => m.description)).toEqual([
      'Recognize a range call in code',
      'Trace loop repetitions by hand',
      'Write a loop that counts upward from zero.',
      'Print each number the loop produces.',
      'Explain when the loop stops.',
    ]);
  });

  it('a garbage coverage answer changes nothing (audit is a safety net, not a blocker)', async () => {
    const r = await decomposeRecursive(
      brief,
      stub({ classify: () => 'ATOMIC', coverage: () => 'looks fine to me!' }),
    );
    expect(r.milestones).toHaveLength(2);
    expect(r.stats.appended).toBe(0);
  });

  it('TWO-STEP: an ATOMIC classify verdict makes a leaf without ever calling the split prompt', async () => {
    let expandCalls = 0;
    const r = await decomposeRecursive(
      brief,
      stub({
        classify: () => 'ATOMIC',
        expand: () => {
          expandCalls++;
          return '{"atomic": true}';
        },
      }),
    );
    expect(expandCalls).toBe(0);
    expect(r.milestones).toHaveLength(2);
    expect(r.calls.filter((c) => c.label.startsWith('decompose:classify'))).toHaveLength(2);
  });

  it('TWO-STEP: a garbled classify answer defaults to leaf (conservative)', async () => {
    let expandCalls = 0;
    const r = await decomposeRecursive(
      brief,
      stub({
        classify: () => 'Well, it could go either way — atomic or split, hard to say!',
        expand: () => {
          expandCalls++;
          return '{"atomic": true}';
        },
      }),
    );
    expect(expandCalls).toBe(0);
    expect(r.milestones).toHaveLength(2);
  });

  it('maxDepth 0 disables splitting entirely (goals become the milestones)', async () => {
    let expandCalls = 0;
    const r = await decomposeRecursive(
      brief,
      stub({
        expand: () => {
          expandCalls++;
          return '{"atomic": false, "subGoals": []}';
        },
        refine: () => '',
      }),
      { ...DEFAULT_LIMITS, maxDepth: 0 },
    );
    expect(expandCalls).toBe(0);
    expect(r.milestones).toHaveLength(2);
  });

  it('records every model call with labels for the dev panel', async () => {
    const r = await decomposeRecursive(brief, stub({ expand: () => '{"atomic": true}' }));
    const labels = r.calls.map((c) => c.label);
    expect(labels.filter((l) => l.startsWith('decompose:classify'))).toHaveLength(2);
    expect(labels.filter((l) => l.startsWith('decompose:expand'))).toHaveLength(2); // classify defaulted to SPLIT
    expect(labels.filter((l) => l.startsWith('decompose:refine'))).toHaveLength(0); // single-leaf goals
    expect(labels.filter((l) => l.startsWith('decompose:coverage'))).toHaveLength(0); // statement-leaf goals skip the audit
    for (const c of r.calls) {
      expect(c.system.length).toBeGreaterThan(0);
      expect(c.user.length).toBeGreaterThan(0);
      expect(typeof c.response).toBe('string');
    }
  });

  describe('isSelfEvidentLeaf (depth-1+ pre-gate)', () => {
    it('gates short AND specific goals — the counters-trace goals the model kept over-splitting', () => {
      expect(isSelfEvidentLeaf('Update the counter variable inside a loop')).toBe(true);
      expect(isSelfEvidentLeaf('Initialize a counter variable inside a loop')).toBe(true);
    });

    it('specificity floor: short-but-VAGUE goals still go to the model', () => {
      expect(isSelfEvidentLeaf('Teach me Python')).toBe(false); // 2 content words
      expect(isSelfEvidentLeaf('Learn Python fundamentals')).toBe(false); // 3 content words
    });

    it('ONE-concept "and" patterns are gated (trace fixtures — each cost ~4 wasted calls live)', () => {
      expect(isSelfEvidentLeaf('Use `True` and `False` in simple expressions')).toBe(true); // literal pair
      expect(isSelfEvidentLeaf('Choose between lists and tuples for storage')).toBe(true); // between X and Y
    });

    it('digit tokens do not count toward the word cap (for-loops trace: even/odd range goals must leaf)', () => {
      // "from 0 to 10" pushed this to 10 raw words live; classify then said SPLIT and the
      // model produced per-number garbage ("a range that includes 0" shipped as a milestone).
      expect(isSelfEvidentLeaf('create a range of even numbers from 0 to 10')).toBe(true);
      expect(isSelfEvidentLeaf('create a range of odd numbers from 1 to 9')).toBe(true);
    });

    it('compound shapes are never gated', () => {
      expect(isSelfEvidentLeaf('Initialize and update a counter inside a loop')).toBe(false); // "and"
      expect(isSelfEvidentLeaf('Define the counter, then update it each iteration')).toBe(false); // comma
      expect(isSelfEvidentLeaf('Initialize the counter variable to zero before the loop body starts running')).toBe(
        false,
      ); // > 9 words
    });
  });

  it('PRE-GATE integration: specific depth-1 children become leaves with NO deep classify call', async () => {
    const classifyDepths: string[] = [];
    const r = await decomposeRecursive(
      oneGoal,
      stub({
        classify: (_s, user) => {
          classifyDepths.push(user);
          return 'SPLIT';
        },
        expand: () =>
          '{"atomic": false, "subGoals": [' +
          '{"title": "init counter", "description": "Initialize the counter variable before the loop"}, ' +
          '{"title": "update counter", "description": "Update the counter variable inside the loop"}]}',
        refine: () => '',
      }),
    );
    // Both children pass the gate (short + specific) → leaves without a model call.
    expect(r.milestones.map((m) => m.description)).toEqual([
      'Initialize the counter variable before the loop',
      'Update the counter variable inside the loop',
    ]);
    expect(classifyDepths).toHaveLength(1); // depth 0 only — authored goals always classify
    expect(r.calls.filter((c) => c.label === 'decompose:classify@d1')).toHaveLength(0);
  });

  describe('isSplitVerdict', () => {
    it('accepts only an unambiguous SPLIT', () => {
      expect(isSplitVerdict('SPLIT')).toBe(true);
      expect(isSplitVerdict('split.')).toBe(true);
      expect(isSplitVerdict('ATOMIC')).toBe(false);
      expect(isSplitVerdict('The goal is atomic')).toBe(false);
      expect(isSplitVerdict('either atomic or split')).toBe(false); // both → leaf
      expect(isSplitVerdict('hmm')).toBe(false); // neither → leaf
    });

    it('tolerates the old JSON shape', () => {
      expect(isSplitVerdict('{"atomic": false}')).toBe(true);
      expect(isSplitVerdict('{"atomic": true}')).toBe(false);
    });
  });

  it('an empty-goals brief falls back to the lesson title as the single root', async () => {
    const empty: LessonBrief = { id: 'x', title: 'Solo topic', goals: [] };
    const r = await decomposeRecursive(empty, stub({ expand: () => '{"atomic": true}' }));
    expect(r.milestones).toHaveLength(1);
    expect(r.milestones[0].description).toContain('Solo topic');
  });
});
