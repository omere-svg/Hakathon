// Renders the shared parity fixtures through the REAL prompts.ts and writes the
// (system, user) pairs to finetune/work/parity/ts-dump.json. The Python side
// (finetune/scripts/dump_prompts.py) renders the same fixtures through the port;
// finetune/scripts/parity_check.py diffs the two. Run from maestro-open/:
//   npx vite-node scripts/dumpPrompts.ts
// NOTE: the runtime ` /no_think` system suffix (quirks.ts) is appended HERE so both
// dumps show exactly what the model sees.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  classifyPrompt,
  expandPrompt,
  refinePrompt,
  coveragePrompt,
  teachPrompt,
  suggestionsPrompt,
  assessPrompt,
  syncPrompt,
  completionPrompt,
} from '../src/engine/milestone/prompts';
import type { Milestone } from '../src/engine/milestone/types';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtures = JSON.parse(readFileSync(join(repoRoot, 'finetune', 'data', 'parity-fixtures.json'), 'utf8'));

const NO_THINK = ' /no_think';
const pair = (p: { system: string; user: string }) => ({ system: p.system + NO_THINK, user: p.user });
// teach/assess/sync fixtures carry only the fields the prompt builders read.
const asMilestone = (m: { description: string; context: unknown[] }) => m as unknown as Milestone;

const out: Record<string, unknown[]> = {
  classify: fixtures.classify.map((f: { lessonTitle: string; goal: string; depth: number; maxDepth: number }) =>
    pair(classifyPrompt(f.lessonTitle, f.goal, f.depth, f.maxDepth))),
  expand: fixtures.expand.map((f: { goal: string }) => pair(expandPrompt(f.goal))),
  refine: fixtures.refine.map((f: { goals: string[]; draftSteps: string[] }) => pair(refinePrompt(f.goals, f.draftSteps))),
  coverage: fixtures.coverage.map((f: { id: string; statement: string }) => pair(coveragePrompt(f))),
  teach: fixtures.teach.map((f: {
    milestone: { description: string; context: unknown[] };
    justAdvanced: boolean;
    bridge?: { completedTitle: string; lastStudentMessage: string; mastered: boolean };
    attempts?: number;
    rails?: Record<string, unknown>;
  }) => pair(teachPrompt(asMilestone(f.milestone), f.justAdvanced, f.bridge, f.attempts ?? 0, f.rails))),
  suggestions: fixtures.suggestions.map((f: { tutorReply: string; milestoneTitle: string }) =>
    pair(suggestionsPrompt(f.tutorReply, f.milestoneTitle))),
  assess: fixtures.assess.map((f: { milestone: { description: string; context: unknown[] } }) =>
    pair(assessPrompt(asMilestone(f.milestone)))),
  sync: fixtures.sync.map((f: { completed: { description: string; context: unknown[] }; remaining: Array<{ id: string; description: string }> }) =>
    pair(syncPrompt(asMilestone(f.completed), f.remaining as unknown as Milestone[]))),
  completion: fixtures.completion.map((f: { title: string }) => pair(completionPrompt({ title: f.title } as never))),
};

const outDir = join(repoRoot, 'finetune', 'work', 'parity');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'ts-dump.json'), JSON.stringify(out, null, 2));
console.log(`wrote ${join(outDir, 'ts-dump.json')}`);
