// End-to-end tests of the MilestoneEngine loop against scripted stub LLMs:
// decompose → teach → assess → sync → advance → complete, plus the engine's
// core invariants — strict context isolation, the minimal bridge, the sync
// evidence gate, role-play scrubbing, and suggestion fallbacks.

import { describe, expect, it } from 'vitest';
import { cleanReply, createMilestoneEngine, MilestoneEngine } from './engine';
import type { LessonBrief } from '../api';
import type { LLMEngine } from '../../llm/types';

// ── prompt routing markers (from prompts.ts) ─────────────────────────────────────
const IS = {
  classify: (s: string) => s.includes('ATOMIC or SPLIT'),
  expand: (s: string) => s.includes('RECURSIVE decomposition'),
  refine: (s: string) => s.includes('finalizing a lesson plan'),
  coverage: (s: string) => s.includes('lesson goal for COVERAGE'),
  teach: (s: string) => s.includes('teaching ONE focused idea'),
  assess: (s: string) => s.includes('You are a strict grader'),
  sync: (s: string) => s.includes('auditing a learning plan'),
  suggestions: (s: string) => s.includes('quick-reply buttons'),
  completion: (_s: string, u: string) => u.includes('Congratulate them warmly') || u.includes('Do NOT claim mastery'),
};

interface Recorded {
  kind: string;
  system: string;
  user: string;
}

/** Default teach replies rotate through DISTINCT-vocabulary lines: a constant reply would
 *  trip the repetition rail on every same-milestone re-teach (correctly — identical replies
 *  ARE what it catches) and pollute unrelated tests with regen calls. */
const TEACH_LINES = [
  'Let me explain this idea. What do you think it means?',
  'Picture a scoreboard counter ticking upward. Which number comes next?',
  'Imagine filling a bucket with cups of water. When does pouring stop?',
  'Consider a playlist that repeats songs. Which track follows the last one?',
  'Think of stamps collected in an album. Where does each new stamp go?',
];

/** Scriptable stub: per-kind handlers + a full recording of every call. */
function makeStub(overrides: Partial<Record<keyof typeof IS, (system: string, user: string) => string>> = {}) {
  const calls: Recorded[] = [];
  let teachSeq = 0;
  const defaults: Record<keyof typeof IS, (system: string, user: string) => string> = {
    classify: () => 'ATOMIC', // goals become milestones 1:1 without a split call
    expand: () => '{"atomic": true}',
    refine: () => '', // garbage → keep draft (goals become milestones 1:1)
    coverage: () => '', // no requirement lines → the audit appends nothing
    teach: () => TEACH_LINES[teachSeq++ % TEACH_LINES.length],
    assess: () => '{"achieved": false, "evidence": "no demonstration yet"}',
    sync: () => '{"alsoAchieved": []}',
    suggestions: () => 'Maybe it repeats?\nCan you explain again?\nWhat does that term mean?\nNot sure yet',
    completion: () => 'Congratulations — you did it!',
  };
  const llm: LLMEngine = {
    name: 'stub',
    onDevice: true,
    async complete(system: string, user: string): Promise<string> {
      for (const kind of Object.keys(IS) as (keyof typeof IS)[]) {
        if (IS[kind](system, user)) {
          calls.push({ kind, system, user });
          return (overrides[kind] ?? defaults[kind])(system, user);
        }
      }
      throw new Error(`unroutable prompt: ${system.slice(0, 80)}`);
    },
  };
  return { llm, calls };
}

// g3 is deliberately CONCEPTUAL ("Explain…", not "Write…"): these generic-flow tests send
// prose student messages, and a production goal would (correctly) hit the code floor.
// The code floor has its own dedicated tests below.
const brief: LessonBrief = {
  id: 'w3-l8',
  title: 'Meet the while loop',
  goals: [
    { id: 'g1', statement: 'Understand what a while loop is.' },
    { id: 'g2', statement: 'Prevent infinite loops.' },
    { id: 'g3', statement: 'Explain when a while loop ends.' },
  ],
};

describe('cleanReply', () => {
  it('strips a leading self-label', () => {
    expect(cleanReply('Tutor: Great question! What repeats?')).toBe('Great question! What repeats?');
  });

  it('cuts at the first fabricated speaker turn', () => {
    const bleed = 'Loops repeat. What does that mean? Student: it repeats. Teacher (continuing): Exactly!';
    expect(cleanReply(bleed)).toBe('Loops repeat. What does that mean?');
  });

  it('leaves a normal reply untouched', () => {
    const ok = "A loop repeats an action. What do you think 'repeat' means here?";
    expect(cleanReply(ok)).toBe(ok);
  });

  it('handles labels with parentheticals', () => {
    expect(cleanReply('Teacher (warmly): Hello. Student (unsure): hm')).toBe('Hello.');
  });

  it('strips an UNMATCHED trailing quote (observed live: `…how it works?"`)', () => {
    expect(cleanReply("Hello! What's your understanding of how it works?\"")).toBe(
      "Hello! What's your understanding of how it works?",
    );
    expect(cleanReply('"Loops repeat. What repeats here?')).toBe('Loops repeat. What repeats here?');
  });

  it('leaves BALANCED quotes untouched — quoted content is content', () => {
    const ok = 'The word "loop" means repetition. What does "while" add?';
    expect(cleanReply(ok)).toBe(ok);
  });

  it('drops a sentence repeated back-to-back (the live salsa stutter)', () => {
    const stutter =
      'Not quite — so `salsa` does not contain `al`, and `salsa` does contain `s`. So `salsa` does not contain `al`, and `salsa` does contain `s`. What does `salsa` contain?';
    expect(cleanReply(stutter)).toBe(
      'Not quite — so `salsa` does not contain `al`, and `salsa` does contain `s`. What does `salsa` contain?',
    );
  });

  it('keeps distinct consecutive sentences', () => {
    const ok = 'A loop repeats. A loop also ends. What ends it?';
    expect(cleanReply(ok)).toBe(ok);
  });
});

describe('MilestoneEngine.start', () => {
  it('decomposes, activates milestone 1, teaches, and returns suggestions', async () => {
    const { llm, calls } = makeStub();
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();

    expect(view.done).toBe(false);
    expect(view.reply).toContain('What do you think');
    expect(view.status).toContain('Milestone 1/3');
    expect((await view.suggestions)?.quick).toHaveLength(4);
    // call order: expands (3 goals) → refine → teach → suggestions; no assess/sync at start
    expect(calls.filter((c) => c.kind === 'assess')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'teach')).toHaveLength(1);
    // dev debug carries the plan and the full call log
    expect(view.debug?.steps?.map((s) => s.state)).toEqual(['active', 'pending', 'pending']);
    expect(view.debug?.calls?.length).toBeGreaterThanOrEqual(5);
  });

  it('refuses to run without an on-device model', async () => {
    const { llm } = makeStub();
    const offline = { ...llm, onDevice: false };
    const engine = createMilestoneEngine(brief, offline);
    await expect(engine.start()).rejects.toThrow(/on-device/);
  });
});

describe('MilestoneEngine.respond — teaching loop', () => {
  it('stays on the milestone while assessment says not achieved', async () => {
    const { llm, calls } = makeStub();
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('I am not sure');

    expect(view.status).toContain('Milestone 1/3');
    expect(calls.filter((c) => c.kind === 'assess')).toHaveLength(1);
    expect(view.debug?.steps?.[0].state).toBe('active');
  });

  it('skips the assess call entirely when there is no student turn yet', async () => {
    const { llm, calls } = makeStub();
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond('   '); // whitespace only — not pushed as a student turn
    expect(calls.filter((c) => c.kind === 'assess')).toHaveLength(0);
  });

  it('applies cleanReply to the teach output (role-play bleed never reaches the student)', async () => {
    const { llm } = makeStub({
      teach: () => 'Tutor: Loops repeat. What repeats here? Student: everything!',
    });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect(view.reply).toBe('Loops repeat. What repeats here?');
  });
});

describe('MilestoneEngine.respond — advancing', () => {
  it('achieve → sync → advance, with the bridge carrying only the minimal handoff', async () => {
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": true, "evidence": "student explained the condition"}',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('a while loop repeats while its condition is true');

    // advanced to milestone 2
    expect(view.status).toContain('Milestone 2/3');
    expect(view.debug?.steps?.map((s) => s.state)).toEqual(['done', 'active', 'pending']);
    // sync ran exactly once
    expect(calls.filter((c) => c.kind === 'sync')).toHaveLength(1);

    // the transition teach prompt carries the bridge…
    const teachCalls = calls.filter((c) => c.kind === 'teach');
    const transitionTeach = teachCalls[teachCalls.length - 1];
    expect(transitionTeach.user).toContain('a while loop repeats while its condition is true');
    // …and forbids greeting / milestone-talk
    expect(transitionTeach.system).toContain('Do NOT greet');
  });

  it('CONTEXT ISOLATION: milestone 2 prompts never contain milestone 1 tutor text', async () => {
    const M1_TUTOR = 'UNIQUE-M1-TUTOR-SENTINEL explanation of conditions.';
    let advanced = false;
    const { llm, calls } = makeStub({
      teach: () => (advanced ? 'Now, about infinite loops — what stops one?' : `${M1_TUTOR} What is a condition?`),
      assess: (_s, u) => (u.includes('student-answer-one') ? '{"achieved": true, "evidence": "clear demonstration"}' : '{"achieved": false, "evidence": "not yet"}'),
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    advanced = true;
    await engine.respond('student-answer-one'); // achieves m1, teaches m2 (transition)
    await engine.respond('second message on m2'); // assess + teach WITHIN m2

    const assessCalls = calls.filter((c) => c.kind === 'assess');
    const teachCalls = calls.filter((c) => c.kind === 'teach');
    const m2Assess = assessCalls[assessCalls.length - 1];
    const m2Teach = teachCalls[teachCalls.length - 1];
    // milestone 1's tutor content must not leak into milestone 2's isolated context
    expect(m2Assess.user).not.toContain('UNIQUE-M1-TUTOR-SENTINEL');
    expect(m2Teach.user).not.toContain('UNIQUE-M1-TUTOR-SENTINEL');
    // but milestone 2's own conversation IS there
    expect(m2Teach.user).toContain('second message on m2');
  });
});

describe('MilestoneEngine — sync evidence gate', () => {
  it('rejects sync ids without concrete evidence (no silent skipping)', async () => {
    const { llm } = makeStub({
      assess: () => '{"achieved": true, "evidence": "demonstrated"}',
      sync: () => '{"alsoAchieved": [{"id": "m3"}, "m3", {"id": "m3", "evidence": "ok"}]}',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('answer one');
    // bare id, string id, and too-short evidence are ALL rejected → m3 still pending
    expect(view.debug?.steps?.map((s) => s.state)).toEqual(['done', 'active', 'pending']);
  });

  it('accepts sync ids WITH evidence and advance skips them', async () => {
    const { llm } = makeStub({
      assess: () => '{"achieved": true, "evidence": "demonstrated"}',
      sync: () => '{"alsoAchieved": [{"id": "m3", "evidence": "the student already wrote a full while loop"}]}',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const v1 = await engine.respond('answer one'); // m1 done, m3 sync-achieved → now on m2
    expect(v1.status).toContain('Milestone 2/3');
    expect(v1.debug?.steps?.map((s) => s.state)).toEqual(['done', 'active', 'done']);

    const v2 = await engine.respond('answer two'); // m2 done → m3 already done → lesson complete
    expect(v2.done).toBe(true);
    expect(v2.reply).toContain('Congratulations');
    expect(v2.suggestions).toBeUndefined();
  });

  it('a sync failure marks nothing (conservative)', async () => {
    const { llm } = makeStub({
      assess: () => '{"achieved": true, "evidence": "demonstrated"}',
      sync: () => 'the remaining milestones look pretty much done to me!',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('answer');
    expect(view.debug?.steps?.map((s) => s.state)).toEqual(['done', 'active', 'pending']);
  });
});

describe('MilestoneEngine — completion & resilience', () => {
  it('replies with a done view after the lesson is complete (no model calls)', async () => {
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": true, "evidence": "demonstrated"}',
      sync: () => '{"alsoAchieved": []}',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond('one');
    await engine.respond('two');
    const done = await engine.respond('three');
    expect(done.done).toBe(true);

    const before = calls.length;
    const after = await engine.respond('hello?');
    expect(after.done).toBe(true);
    expect(calls.length).toBe(before); // complete lesson burns no more model calls
  });

  it('a throwing assess call fails safe: keep teaching, do not advance', async () => {
    let assessCount = 0;
    const { llm } = makeStub({
      assess: () => {
        assessCount++;
        throw new Error('gpu hiccup');
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('an answer');
    expect(assessCount).toBe(1);
    expect(view.done).toBe(false);
    expect(view.status).toContain('Milestone 1/3');
  });

  it('NO CHIPS when the model gives fewer than 4 usable options (no canned fallbacks)', async () => {
    const { llm } = makeStub({ suggestions: () => 'only-one-line' });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect(await view.suggestions).toBeUndefined();
  });

  it('CHIPS with 3 usable options (product ruling 2026-07-04: 3+ is enough)', async () => {
    const { llm } = makeStub({ suggestions: () => 'Same one\nsame one\nSecond\nThird' });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect((await view.suggestions)?.quick?.map((c) => c.label)).toEqual(['Same one', 'Second', 'Third']);
  });

  it('NO CHIPS when only 2 usable options remain', async () => {
    const { llm } = makeStub({ suggestions: () => 'Only one\nAnd two' });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect(await view.suggestions).toBeUndefined();
  });

  it('dynamic suggestions are deduped and capped at 4', async () => {
    const { llm } = makeStub({
      suggestions: () => 'Same answer\nsame answer\nDifferent one\nAnother one\nFifth extra\nSixth extra',
    });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    const labels = (await view.suggestions)?.quick?.map((c) => c.label) ?? [];
    expect(labels).toHaveLength(4);
    expect(labels[0]).toBe('Same answer');
    expect(new Set(labels.map((l) => l.toLowerCase())).size).toBe(4);
  });

  it('a throwing suggestions call yields NO chips and never rejects', async () => {
    const { llm } = makeStub({
      suggestions: () => {
        throw new Error('gpu hiccup');
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect(view.reply).toContain('What do you think'); // the reply never waited on chips
    expect(await view.suggestions).toBeUndefined();
  });

  it('per-turn LLM call log resets between turns', async () => {
    const { llm } = makeStub();
    const engine = new MilestoneEngine(brief, llm);
    const first = await engine.start();
    await first.suggestions;
    const startCalls = first.debug?.calls?.length ?? 0;
    expect(startCalls).toBeGreaterThanOrEqual(5); // expands + refine + teach + suggestions

    const second = await engine.respond('hmm');
    await second.suggestions; // chips resolve after the view; settle them before reading the log
    const turnLabels = (second.debug?.calls ?? []).map((c) => c.label);
    expect(turnLabels).toEqual(['assess', 'teach', 'suggestions']); // fresh log, normal turn shape
  });
});

describe('MilestoneEngine — small-model rails', () => {
  it('assess retries ONCE with a JSON nudge when the reply has no recoverable JSON', async () => {
    let assessCount = 0;
    const { llm, calls } = makeStub({
      assess: (_s, u) => {
        assessCount++;
        if (assessCount === 1) return 'The student seems to be doing quite well so far.'; // no JSON
        expect(u).toContain('ONLY the JSON object');
        return '{"achieved": false, "evidence": "no demonstration yet"}';
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('an answer');
    expect(assessCount).toBe(2);
    expect(view.status).toContain('Milestone 1/3'); // parsed verdict from the retry: not achieved
    expect(calls.filter((c) => c.kind === 'assess')).toHaveLength(2);
  });

  it('the arithmetic rail corrects a wrong numeric claim in the tutor reply', async () => {
    const { llm } = makeStub({
      teach: () => 'Good try! Remember that 17 // 5 = 4 in Python. What is 17 % 5?',
    });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect(view.reply).toContain('17 // 5 = 3');
    expect(view.reply).not.toContain('= 4');
  });

  it('the arithmetic rail leaves correct claims and code untouched', async () => {
    const reply = 'Right — 17 % 5 = 2, and in code you write count = count + 1. What next?';
    const { llm } = makeStub({ teach: () => reply });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect(view.reply).toBe(reply);
  });

  it('IMPASSE CAP: force-advances after MAX_ATTEMPTS failed assessments, without congratulating', async () => {
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": false, "evidence": "still stuck"}',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();

    let view = await engine.respond('wrong 1'); // attempts 1
    view = await engine.respond('wrong 2'); // attempts 2
    view = await engine.respond('wrong 3'); // attempts 3 — worked example by now
    const teachSoFar = calls.filter((c) => c.kind === 'teach');
    expect(teachSoFar[teachSoFar.length - 1].system).toContain('worked example');
    expect(view.status).toContain('Milestone 1/3');

    view = await engine.respond('wrong 4'); // attempts 4 = MAX_ATTEMPTS → advance
    expect(view.status).toContain('Milestone 2/3');
    // the transition bridge must NOT claim mastery
    const transition = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(transition.user).toContain('do NOT congratulate');
    // an impasse advance produced no new evidence → no sync call burned
    expect(calls.filter((c) => c.kind === 'sync')).toHaveLength(0);
  });

  it('NO-FALSE-PRAISE: a praising reply to a wrong answer is regenerated with the note', async () => {
    let teachCount = 0;
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": false, "evidence": "the sum is wrong"}',
      teach: (_s, u) => {
        teachCount++;
        if (u.includes('NOT correct')) return "Not quite — the filter is missing. What should it check?";
        return 'Correct, nicely done! What next?';
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start(); // opening teach (no praise guard — no student answer yet)
    const view = await engine.respond('my wrong answer');
    expect(view.reply).toContain('Not quite');
    expect(view.reply).not.toContain('nicely done');
    const labels = calls.filter((c) => c.kind === 'teach');
    expect(labels[labels.length - 1].user).toContain('NOT correct'); // the regen note was sent
    expect(teachCount).toBe(3); // opening + praising draft + regeneration
  });

  it('NO-FALSE-PRAISE: deterministic scrub when the regeneration still praises', async () => {
    const { llm } = makeStub({
      assess: () => '{"achieved": false, "evidence": "wrong"}',
      teach: () => 'Exactly right! Also, a while loop checks the condition first. What does it check?',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('my wrong answer');
    expect(view.reply).not.toContain('Exactly right');
    expect(view.reply).toContain('a while loop checks the condition first');
  });

  it('NAME STORE: a preference survives milestone advance AND serialization', async () => {
    const { llm, calls } = makeStub({
      assess: (_s, u) => (u.includes('call me Liz') ? '{"achieved": true, "evidence": "clear answer, and asked to be called Liz"}' : '{"achieved": false, "evidence": "not yet"}'),
    });
    const engine = new MilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond('call me Liz, not Elizabeth — and the loop repeats while true');

    // the transition teach (milestone 2) is a NEW isolated context — the name must still be there
    const teach = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(teach.system).toContain("The student's preferred name is Liz");
    expect(teach.system).toContain('NEVER call them by any other name');

    const snap = engine.serialize();
    const restored = new MilestoneEngine(brief, llm, JSON.parse(JSON.stringify(snap)));
    await restored.respond('what next?');
    const teachAfter = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(teachAfter.system).toContain("The student's preferred name is Liz");
  });

  it('DISTRESS: empathy note injected and the miss does NOT count as an attempt', async () => {
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": false, "evidence": "no demonstration"}',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond("I've been stuck on this for 2 hours and feel stupid");
    const teach = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(teach.system).toContain('acknowledge');
    expect(teach.system).toContain('validate how they feel');
    // a vent is not a failed attempt — the escalation ladder must not fire at them
    expect(teach.system).not.toContain('missed this');
    expect(view.debug?.fields.find((f) => f.label === 'attempts')?.value).toBe('0');
  });

  it('RESTART PATH: respond() without start() decomposes AND keeps the student message', async () => {
    const { llm, calls } = makeStub();
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.respond('here is my first answer');
    expect(view.done).toBe(false);
    // the message was assessed and is in the teach context — not silently dropped
    const assess = calls.find((c) => c.kind === 'assess');
    expect(assess?.user).toContain('here is my first answer');
  });
});

describe('MilestoneEngine — trust-ack rail (product ruling 2026-07-04)', () => {
  it('a bare "understood" achieves the milestone WITHOUT a grader call', async () => {
    const { llm, calls } = makeStub();
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('ok, understood!');
    expect(view.status).toContain('Milestone 2/3'); // advanced
    expect(calls.filter((c) => c.kind === 'assess')).toHaveLength(0); // the grader never ran
    expect(calls.filter((c) => c.kind === 'sync')).toHaveLength(1); // a trusted advance still syncs
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('trust-ack');
    expect(view.debug?.fields.find((f) => f.label === 'last assessment')?.value).toContain('trusted');
  });

  it('an "understood?" QUESTION still goes through the grader (asking, not confirming)', async () => {
    const { llm, calls } = makeStub();
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('understood?');
    expect(calls.filter((c) => c.kind === 'assess')).toHaveLength(1);
    expect(view.status).toContain('Milestone 1/3');
  });

  it('an acknowledgment with real content ("ok but why…") still goes through the grader', async () => {
    const { llm, calls } = makeStub();
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond('ok but I still think it never stops');
    expect(calls.filter((c) => c.kind === 'assess')).toHaveLength(1);
  });
});

describe('MilestoneEngine — repetition rail', () => {
  it('a re-teach that mirrors the previous tutor message is regenerated ONCE with the be-new note', async () => {
    const stale = 'If we start at 0 and add 2 each time, we get 0, 2, 4, 6. What would happen if we started at 5?';
    const fresh = 'Try a piggy bank instead: coins drop in and change what is saved. Where does each coin go?';
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": false, "evidence": "not demonstrated"}',
      teach: (_s, u) => (u.includes('genuinely NEW') ? fresh : stale),
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start(); // opening teach = stale
    const view = await engine.respond('itll be 5 7 9 and so on'); // draft repeats the opening → regen
    expect(view.reply).toBe(fresh);
    const teachCalls = calls.filter((c) => c.kind === 'teach');
    expect(teachCalls[teachCalls.length - 1].user).toContain('genuinely NEW');
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('repetition');
  });

  it('a genuinely new re-teach is NOT regenerated', async () => {
    let teaches = 0;
    const lines = [
      'A loop repeats steps. What does the loop check each time?',
      'Picture a turnstile counting people entering a stadium. When does counting stop?',
    ];
    const { llm } = makeStub({
      assess: () => '{"achieved": false, "evidence": "not yet"}',
      teach: () => lines[Math.min(teaches++, 1)],
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('hmm');
    expect(view.reply).toBe(lines[1]);
    expect(teaches).toBe(2); // opening + one re-teach — no regen call
  });

  it('a repetition regen that praises a just-failed answer is still scrubbed (praise guarantee survives)', async () => {
    const stale = 'If we start at 0 and add 2 each time, we get 0, 2, 4, 6. What would happen if we started at 5?';
    const praisingRegen = 'Exactly right! Also, notice each pass changes the total once. Which line does that?';
    const { llm } = makeStub({
      assess: () => '{"achieved": false, "evidence": "wrong"}',
      teach: (_s, u) => (u.includes('genuinely NEW') ? praisingRegen : stale),
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('my wrong answer');
    expect(view.reply).not.toContain('Exactly right');
    expect(view.reply).toContain('each pass changes the total once');
  });
});

describe('MilestoneEngine — booleans-trace rails', () => {
  it('CLARIFYING QUESTION (T5): a student question does not burn an attempt', async () => {
    const { llm } = makeStub(); // assess default: not achieved
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const v1 = await engine.respond('what do u mean?');
    expect(v1.debug?.fields.find((f) => f.label === 'attempts')?.value).toBe('0');
    expect(v1.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('question-not-attempt');
    const v2 = await engine.respond('loops go forever i think'); // a real (wrong) answer DOES count
    expect(v2.debug?.fields.find((f) => f.label === 'attempts')?.value).toBe('1');
  });

  it('QUESTION-REPEAT (T3): re-asking an already-asked question fires the repetition regen even when the whole message looks new', async () => {
    // Live turns 1+3: whole-message stemmed similarity was ~0.47 (under the 0.6 rail) but
    // the question sentence itself was verbatim identical.
    const opening =
      "Hello! Let's explore how boolean values work. What do you think the result of True and False in this expression would be?";
    const rehash =
      'They represent the two possible values in a boolean expression. What do you think the result of True and False in this expression would be?';
    const fresh =
      'True and False evaluates to False, because and needs both sides to be True. What does True and True evaluate to?';
    const { llm } = makeStub({
      assess: () => '{"achieved": false, "evidence": "not demonstrated"}',
      teach: (_s, u) => {
        if (u.includes('very start')) return opening;
        if (u.includes('genuinely NEW')) return fresh;
        return rehash;
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('they are the possible values of the boolean variable');
    expect(view.reply).toBe(fresh);
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('repetition');
  });

  it('EXPLAIN-FIRST (T4): a re-teach that is ONLY questions is regenerated once with the explain note', async () => {
    const allQuestions = 'What do you think the result would be?';
    const explained =
      'Here is one worked case: 3 % 2 equals 1, so 3 is odd. Now, what does 4 % 2 equal?';
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": false, "evidence": "not yet"}',
      teach: (_s, u) => {
        if (u.includes('very start')) return 'A boolean is either True or False. Ready to look at one together?';
        if (u.includes('only questions')) return explained;
        return allQuestions;
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('im not sure at all');
    expect(view.reply).toBe(explained);
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('explain-first');
    const teachCalls = calls.filter((c) => c.kind === 'teach');
    expect(teachCalls[teachCalls.length - 1].user).toContain('only questions');
  });

  it('PYTHON-SYNTAX (T2): JS-flavored code in a Python lesson is regenerated once', async () => {
    // Live: `var result = True;` — JS keyword + semicolon + Python boolean.
    const js = 'You can store it like this: `var result = True;`. What does result hold?';
    const py = 'You can store it like this: `result = True`. What does `result` hold afterwards?';
    const { llm, calls } = makeStub({ teach: (_s, u) => (u.includes('NOT valid Python') ? py : js) });
    const engine = createMilestoneEngine({ ...brief, language: 'Python' }, llm);
    const view = await engine.start();
    expect(view.reply).toBe(py);
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('syntax');
    // and the teach prompt itself pins the language
    const teach = calls.find((c) => c.kind === 'teach')!;
    expect(teach.system).toContain('valid Python');
  });

  it('no syntax rail without a lesson language (nothing to pin against)', async () => {
    const js = 'Try `var x = 1;` maybe. What is x?';
    let teaches = 0;
    const { llm } = makeStub({
      teach: () => {
        teaches++;
        return js;
      },
    });
    const engine = createMilestoneEngine(brief, llm); // no language on this brief
    const view = await engine.start();
    expect(view.reply).toBe(js);
    expect(teaches).toBe(1); // accepted as-is
  });
});

describe('MilestoneEngine — vacuous-question rail', () => {
  it('a self-answered example ending in "What\'s your answer?" is regenerated once (the live weird turn)', async () => {
    const selfAnswered =
      'If you were counting from 0 to stop-1 with stop as 5, the numbers would be 0, 1, 2, 3, 4. What is your answer?';
    const fixed =
      'If stop is 5, the loop counts 0, 1, 2, 3, 4 — it always ends one before stop. What numbers would stop as 3 give?';
    const { llm, calls } = makeStub({
      teach: (_s, u) => (u.includes('no checkable answer') ? fixed : selfAnswered),
    });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect(view.reply).toBe(fixed);
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('vacuous-question');
    const teachCalls = calls.filter((c) => c.kind === 'teach');
    expect(teachCalls[teachCalls.length - 1].user).toContain('DIFFERENT case');
  });

  it('a reply ending in a specific checkable question is NOT regenerated', async () => {
    const good = 'range(0, 3) produces 0, 1, 2 — it stops before 3. What numbers does range(0, 5) produce?';
    let teaches = 0;
    const { llm } = makeStub({
      teach: () => {
        teaches++;
        return good;
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect(view.reply).toBe(good);
    expect(teaches).toBe(1);
  });
});

describe('MilestoneEngine — harness-iter1 rails', () => {
  it('SECOND-PERSON: a reply talking ABOUT "the student" is regenerated once', async () => {
    const thirdPerson = 'The student has not rewritten the chain yet. What should the first condition be?';
    const secondPerson = 'You have not rewritten the chain yet — try starting with the most specific condition. What should come first?';
    const { llm, calls } = makeStub({
      teach: (_s, u) => (u.includes('never refer to "the student"') ? secondPerson : thirdPerson),
    });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect(view.reply).toBe(secondPerson);
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('second-person');
    const teach = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(teach.user).toContain('Address them directly as "you"');
  });

  it('GUESS-QUESTION: "is it 7?" burns an attempt; "what do u mean?" still does not', async () => {
    const { llm } = makeStub(); // assess default: not achieved
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const v1 = await engine.respond('is it 7?');
    expect(v1.debug?.fields.find((f) => f.label === 'attempts')?.value).toBe('1');
    const v2 = await engine.respond('what do u mean?');
    expect(v2.debug?.fields.find((f) => f.label === 'attempts')?.value).toBe('1'); // unchanged
  });

  it('HONEST COMPLETION: impasse-heavy lessons must not claim mastery', async () => {
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": false, "evidence": "still stuck"}',
      completion: () => 'Good effort today — a couple of these ideas deserve another pass.',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    // 4 wrong answers per milestone × 3 milestones → every advance is an impasse
    for (let i = 0; i < 12; i++) await engine.respond(`wrong answer ${i}`);
    const completion = calls.filter((c) => c.kind === 'completion').pop()!;
    expect(completion.user).toContain('Do NOT claim mastery');
    expect(completion.user).toContain('3 of its 3 ideas');
  });

  it('HONEST COMPLETION: a fully mastered lesson still gets the congratulation prompt', async () => {
    const { llm, calls } = makeStub({ assess: () => '{"achieved": true, "evidence": "demonstrated clearly"}' });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond('one');
    await engine.respond('two');
    await engine.respond('three');
    const completion = calls.filter((c) => c.kind === 'completion').pop()!;
    expect(completion.user).toContain('Congratulate them warmly');
  });
});

describe('MilestoneEngine — membership rail + clarifying framing (strings trace)', () => {
  it('MEMBERSHIP: a false substring claim in the reply is corrected in place', async () => {
    const { llm } = makeStub({
      teach: () => 'Look: `salsa` does not contain `al` here. What does `banana` contain?',
    });
    const engine = createMilestoneEngine(brief, llm);
    const view = await engine.start();
    expect(view.reply).toContain('`salsa` does contain `al`');
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('membership');
    expect(view.debug?.fields.find((f) => f.label === 'math rail')?.value).toContain('does contain');
  });

  it('CLARIFYING framing: a confused student gets re-explain framing, not the assessor gap note', async () => {
    const { llm, calls } = makeStub(); // assess default: not achieved
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond("I didn't understand what u say");
    const teach = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(teach.user).toContain('asked for clarification');
    expect(teach.user).toContain('Do not say "Not quite"');
    expect(teach.user).not.toContain('Address this specific gap');
  });
});

describe('MilestoneEngine — assess contradiction guard (fine-tune trace)', () => {
  it('a false verdict with affirming evidence is retried once; unresolved → neutral turn, no wrong-answer framing', async () => {
    let assessN = 0;
    const contradictory = '{"achieved": false, "evidence": "a valid chain, so the ordering is correct"}';
    const { llm, calls } = makeStub({
      assess: () => {
        assessN++;
        return contradictory; // stays contradictory on the retry too
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('it repeats while its condition stays true');
    expect(assessN).toBe(2); // one consistency re-ask
    expect(view.status).toContain('Milestone 1/3'); // the false verdict still stands
    expect(view.debug?.fields.find((f) => f.label === 'attempts')?.value).toBe('0'); // but burns no attempt
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('assess-contradiction');
    // the self-contradicted evidence is never fed to the re-teach as "the gap"
    const teach = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(teach.user).not.toContain('ordering is correct');
  });

  it('a clean retry verdict replaces the contradictory one', async () => {
    let assessN = 0;
    const { llm } = makeStub({
      assess: () => {
        assessN++;
        return assessN === 1
          ? '{"achieved": false, "evidence": "a valid chain, so the ordering is correct"}'
          : '{"achieved": true, "evidence": "the chain the student wrote is correct"}';
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('it repeats while its condition stays true');
    expect(view.status).toContain('Milestone 2/3'); // the consistent retry verdict advanced
  });
});

describe('MilestoneEngine — confusion statements', () => {
  it('"I didnt understand your question" (no question mark) burns no attempt and is not framed as wrong', async () => {
    const { llm, calls } = makeStub(); // assess default: not achieved
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('I didnt understand your question');
    expect(view.debug?.fields.find((f) => f.label === 'attempts')?.value).toBe('0');
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('question-not-attempt');
    // no wrong-answer machinery: the teach prompt carries no NOT-correct note
    const teach = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(teach.user).not.toContain('NOT correct');
  });
});

describe('MilestoneEngine — code-production floor', () => {
  it('a code milestone cannot pass on prose (the live "stay home"), but passes once real code appears', async () => {
    const codeBrief: LessonBrief = {
      id: 'dt',
      title: 'Decision tables',
      goals: [
        { id: 'g1', statement: 'Translate a 3-5 row decision table into clear `if/elif/else` code.' },
        { id: 'g2', statement: 'Identify and list all possible conditions.' },
      ],
    };
    const { llm } = makeStub({ assess: () => '{"achieved": true, "evidence": "sounded right"}' });
    const engine = createMilestoneEngine(codeBrief, llm);
    await engine.start();
    const v1 = await engine.respond('stay home'); // grader said yes; the floor says no
    expect(v1.status).toContain('Milestone 1/2');
    expect(v1.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('code-floor');
    const v2 = await engine.respond('if sunny: go_out() elif rainy: stay_home()');
    expect(v2.status).toContain('Milestone 2/2'); // real code → the grader verdict stands
  });

  it('the floor never gates conceptual milestones', async () => {
    const { llm } = makeStub({ assess: () => '{"achieved": true, "evidence": "explained it"}' });
    const engine = createMilestoneEngine(brief, llm); // "Understand…", "Prevent…", "Explain…"
    await engine.start();
    const view = await engine.respond('it repeats while its condition stays true');
    expect(view.status).toContain('Milestone 2/3'); // prose passes an understand-milestone
  });
});

describe('MilestoneEngine — informed re-teach', () => {
  it('a failed assessment feeds its evidence into the next teach prompt', async () => {
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": false, "evidence": "did not mention the loop condition"}',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond('loops just go forever');
    const teach = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(teach.user).toContain('did not mention the loop condition');
    expect(teach.user).toContain('Address this specific gap');
  });

  it('a distress turn does NOT carry grader evidence (empathy leads, not the gap)', async () => {
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": false, "evidence": "no demonstration"}',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond("I'm so frustrated with this");
    const teach = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(teach.user).not.toContain('Address this specific gap');
  });
});

describe('MilestoneEngine — transition on-topic rail', () => {
  it('an off-milestone transition question is regenerated ONCE with the focus note', async () => {
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": true, "evidence": "demonstrated"}',
      teach: (_s, u) => {
        if (u.includes('DIFFERENT topic')) return 'Right — so what condition stops an infinite loop?';
        if (u.includes('Handoff from the previous part')) return 'What is the difference between cats and dogs?';
        return 'Let us look at while loops. What do you think a loop does?';
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('a while loop repeats while its condition is true'); // → m2 "Prevent infinite loops."
    expect(view.reply).toContain('infinite loop'); // the regenerated, on-topic reply shipped
    expect(view.reply).not.toContain('cats');
    const teachCalls = calls.filter((c) => c.kind === 'teach');
    expect(teachCalls[teachCalls.length - 1].user).toContain('DIFFERENT topic');
    expect(view.debug?.fields.find((f) => f.label === 'rails fired')?.value).toContain('on-topic');
  });

  it('an on-topic transition reply is NOT regenerated', async () => {
    const onTopic = 'Now — an infinite loop never stops. What do you think prevents that?';
    let transitionTeaches = 0;
    const { llm } = makeStub({
      assess: () => '{"achieved": true, "evidence": "demonstrated"}',
      teach: (_s, u) => {
        if (u.includes('Handoff from the previous part')) {
          transitionTeaches++;
          return onTopic;
        }
        return 'Let us start. What do you think a loop does?';
      },
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    const view = await engine.respond('a while loop repeats while its condition is true');
    expect(view.reply).toBe(onTopic);
    expect(transitionTeaches).toBe(1); // no second (regen) transition call
  });

  it('the transition prompt itself states the focus imperatively', async () => {
    const { llm, calls } = makeStub({
      assess: () => '{"achieved": true, "evidence": "demonstrated"}',
      teach: () => 'Now, about preventing infinite loops — what stops one?',
    });
    const engine = createMilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond('a while loop repeats while its condition is true');
    const teach = calls.filter((c) => c.kind === 'teach').pop()!;
    expect(teach.user).toContain('MUST be about exactly this');
    expect(teach.user).toContain('Prevent infinite loops.');
  });
});

describe('MilestoneEngine — persistence', () => {
  it('serialize → restore resumes at the same milestone without re-decomposing', async () => {
    const { llm } = makeStub({
      assess: () => '{"achieved": true, "evidence": "student explained it clearly"}',
    });
    const engine = new MilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond('answer one'); // now on milestone 2
    const snap = engine.serialize();
    expect(snap?.queue.items).toHaveLength(3);

    const { llm: llm2, calls: calls2 } = makeStub();
    const restored = new MilestoneEngine(brief, llm2, JSON.parse(JSON.stringify(snap)));
    const view = await restored.respond('a message after reload');
    expect(view.status).toContain('Milestone 2/3');
    expect(view.debug?.steps?.map((s) => s.state)).toEqual(['done', 'active', 'pending']);
    // no decompose calls on the restored engine — the queue came from the snapshot
    expect(calls2.filter((c) => c.kind === 'expand' || c.kind === 'refine')).toHaveLength(0);
  });

  it('debugView on a restored engine exposes the plan steps without a model call', async () => {
    const { llm } = makeStub({
      assess: () => '{"achieved": true, "evidence": "student explained it clearly"}',
    });
    const engine = new MilestoneEngine(brief, llm);
    await engine.start();
    await engine.respond('answer one'); // now on milestone 2
    const snap = engine.serialize();

    const { llm: llm2, calls: calls2 } = makeStub();
    const restored = new MilestoneEngine(brief, llm2, JSON.parse(JSON.stringify(snap)));
    const debug = restored.debugView();
    expect(debug.steps?.map((s) => s.state)).toEqual(['done', 'active', 'pending']);
    expect(debug.calls).toHaveLength(0); // the call log is per-turn — never restored
    expect(calls2).toHaveLength(0); // pure read: no model call ran
  });

  it('serialize before start returns null; a garbage snapshot is ignored', async () => {
    const { llm } = makeStub();
    const engine = new MilestoneEngine(brief, llm);
    expect(engine.serialize()).toBeNull();
    const withGarbage = new MilestoneEngine(brief, llm, { bogus: true });
    const view = await withGarbage.start();
    expect(view.status).toContain('Milestone 1/3'); // fell back to a fresh decompose
  });
});
