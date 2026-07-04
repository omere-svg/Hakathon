// Terminal conversation harness — drives the REAL MilestoneEngine against the fine-tuned
// GGUF served natively by llama.cpp (llama-server), with scripted student personas.
//
//   /opt/homebrew/bin/llama-server -m public/models/qwen3-1.7b-maestro-q4_k_m-00001-of-00003.gguf --port 8899 -c 4096
//   npx tsx scripts/tutor-harness.ts <runLabel> [lesson:persona ...]
//
// Same weights as the app's wllama path; the adapter mirrors wllama.ts exactly (Qwen3
// quirks: /no_think suffix, <think> stripping, model-card sampling). Transcripts + full
// model-call logs are written as markdown for analysis.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMilestoneEngine } from '../src/engine/milestone';
import type { LessonBrief, TurnView } from '../src/engine/api';
import type { GenOptions, LLMEngine } from '../src/llm/types';
import { quirksFor } from '../src/llm/quirks';

const BASE = process.env.LLM_URL ?? 'http://127.0.0.1:8899';
const OUT_ROOT =
  process.env.HARNESS_OUT ??
  '/private/tmp/claude-501/-Users-omererez-Desktop-Projects-plg-hakathon/1786bbc7-118b-4db7-a2ea-103e686e089d/scratchpad/harness';

// ── LLM adapter (mirrors src/llm/wllama.ts) ──────────────────────────────────────
const quirks = quirksFor('Qwen3-1.7B-maestro-q4_k_m-GGUF');

function makeLlm(): LLMEngine {
  return {
    name: 'llama-server harness',
    onDevice: true,
    async complete(system: string, user: string, opts?: GenOptions): Promise<string> {
      const sampling = quirks.sampling();
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: system + quirks.systemSuffix() },
            { role: 'user', content: user },
          ],
          temperature: opts?.temperature ?? sampling.temperature,
          top_p: opts?.topP ?? sampling.topP,
          max_tokens: opts?.maxTokens ?? quirks.maxTokens(),
        }),
      });
      if (!res.ok) throw new Error(`llama-server ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      return quirks.cleanOutput((data.choices[0]?.message?.content ?? '').trim());
    },
  };
}

// ── Lessons ──────────────────────────────────────────────────────────────────────
interface LessonSpec {
  brief: LessonBrief;
  /** a correct code answer the good student sends when asked to write/refactor code. */
  code: string;
  /** a second, different correct code sample so the good student never broken-records. */
  code2?: string;
  /** a SUBTLY WRONG code sample (the tricky persona submits it claiming "done"). */
  badCode?: string;
  /** solid conceptual answers the good student rotates through otherwise. */
  concepts: string[];
}

const LESSONS: Record<string, LessonSpec> = {
  elif: {
    brief: {
      id: 'h-elif',
      title: '`elif` and refactoring nested decisions',
      topic: '`elif` and refactoring nested decisions',
      language: 'Python',
      goals: [
        { id: 'g1', statement: 'Refactor a nested `if/else` into an equivalent `if/elif/else` chain.' },
        { id: 'g2', statement: 'Order conditions to avoid overlaps and unreachable branches.' },
      ],
    },
    code: "if score >= 90:\n    print('A')\nelif score >= 80:\n    print('B')\nelse:\n    print('C')",
    code2: "if hour == 6:\n    print('Good')\nelif hour == 5:\n    print('Hi')\nelse:\n    print('Greetings')",
    badCode: "if score >= 80:\n    print('B')\nelif score >= 90:\n    print('A')\nelse:\n    print('C')",
    concepts: [
      'only the first true condition runs, the rest are skipped',
      'put the most specific condition first so the later ones stay reachable',
      'an elif chain checks conditions top to bottom and stops at the first match',
    ],
  },
  counters: {
    brief: {
      id: 'h-counters',
      title: 'Counters and totals',
      topic: 'Counters and totals',
      language: 'Python',
      goals: [
        { id: 'g1', statement: 'Initialize and update a counter and running total correctly inside a loop.' },
        { id: 'g2', statement: 'Print the final counts and totals after the loop completes.' },
      ],
    },
    code: 'count = 0\ntotal = 0\nfor n in [2, 4, 6]:\n    count = count + 1\n    total = total + n\nprint(count, total)',
    code2: 'count = 0\ntotal = 0\nfor n in range(1, 11):\n    count += 1\n    total += n\nprint(count, total)',
    concepts: [
      'start the counter at 0 before the loop begins',
      'add 1 to the counter each iteration and add the value to the total',
      'print count and total once, after the loop ends',
    ],
  },
  bools: {
    brief: {
      id: 'h-bools',
      title: 'Booleans and comparisons: equality vs identity',
      topic: 'Booleans and comparisons: equality vs identity',
      language: 'Python',
      goals: [
        { id: 'g1', statement: 'Use `True` and `False` in expressions and store boolean results in variables.' },
        { id: 'g2', statement: 'Differentiate between `==` value equality and `is` identity equality.' },
      ],
    },
    code: 'result = 5 > 3\nprint(result)',
    concepts: [
      'a comparison like 5 > 3 evaluates to the boolean True',
      '== compares values, is compares whether both names point to the same object',
      'you can store a comparison result in a variable like ok = x == 10',
    ],
  },
  while: {
    brief: {
      id: 'h-while',
      title: 'Meet the while loop',
      topic: 'while loops',
      language: 'Python',
      goals: [
        { id: 'g1', statement: 'Understand what a while loop is and when it is more suitable than for.' },
        { id: 'g2', statement: 'Write a while loop to repeat actions until a condition changes.' },
      ],
    },
    code: 'n = 5\nwhile n > 0:\n    print(n)\n    n = n - 1',
    code2: 'total = 0\nn = 1\nwhile n <= 3:\n    total = total + n\n    n = n + 1\nprint(total)',
    badCode: 'n = 5\nwhile n > 0:\n    print(n)',
    concepts: [
      'a while loop repeats while its condition stays true',
      'the loop body must change something or the loop never ends',
      'use while when you do not know the number of repetitions in advance',
    ],
  },
  strings: {
    brief: {
      id: 'h-strings',
      title: 'String membership with `in` in conditions',
      topic: 'String membership with `in` in conditions',
      language: 'Python',
      goals: [
        { id: 'g1', statement: 'Use `in` and `not in` to test substring membership.' },
        { id: 'g2', statement: 'Use membership checks inside `if/elif` branches to drive simple decisions.' },
      ],
    },
    code: "word = 'salsa'\nif 'al' in word:\n    print('found')\nelse:\n    print('missing')",
    code2: "if 'q' not in 'hello':\n    print('no q here')",
    concepts: [
      "'al' in 'salsa' is True because salsa contains al",
      'not in gives True when the substring is absent',
      'in checks substring membership and evaluates to a boolean',
    ],
  },
  // Create-lesson style briefs: programming topics that are NOT in the Week-3 catalog —
  // exactly what a student would type into the "Create lesson" form.
  strmethods: {
    brief: {
      id: 'custom-h1',
      title: 'Python string methods',
      topic: 'Python string methods',
      program: 'My lessons',
      course: 'Custom lesson',
      language: 'Python',
      goals: [
        { id: 'g1', statement: 'Use `upper()` and `lower()` to change letter case.' },
        { id: 'g2', statement: 'Use `strip()` to remove surrounding whitespace.' },
      ],
    },
    code: "name = '  Omer  '\nprint(name.strip().upper())",
    code2: "print('HELLO'.lower())",
    concepts: [
      'upper() returns the string in capital letters',
      'strip() removes the spaces from both ends',
      'string methods return a NEW string, the original stays unchanged',
    ],
  },
  lists: {
    brief: {
      id: 'custom-h2',
      title: 'Python lists basics',
      topic: 'Python lists basics',
      program: 'My lessons',
      course: 'Custom lesson',
      language: 'Python',
      goals: [
        { id: 'g1', statement: 'Access list items by index, including negative indexes.' },
        { id: 'g2', statement: 'Add items to a list with `append()`.' },
      ],
    },
    code: "items = ['a', 'b', 'c']\nprint(items[0], items[-1])",
    code2: 'items = [1, 2]\nitems.append(3)\nprint(items)',
    concepts: [
      'index 0 is the first item and -1 is the last',
      'append adds one item to the end of the list',
      'lists keep their items in order',
    ],
  },
};

// ── Student personas ─────────────────────────────────────────────────────────────
type Persona = (lesson: LessonSpec) => { name: string; next(tutor: string, i: number): string };

/** Evaluate range(...) mentioned in the tutor's question — the good student gets these right. */
function evalRange(q: string): string | null {
  const m = q.match(/range\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?(?:,\s*(-?\d+)\s*)?\)/);
  if (!m) return null;
  let start = 0;
  let stop = Number(m[1]);
  let step = 1;
  if (m[2] !== undefined) {
    start = Number(m[1]);
    stop = Number(m[2]);
    step = m[3] !== undefined ? Number(m[3]) : 1;
  }
  if (step === 0) return null;
  const out: number[] = [];
  for (let v = start; step > 0 ? v < stop : v > stop; v += step) {
    out.push(v);
    if (out.length > 12) break;
  }
  return out.join(' ');
}

const good: Persona = (lesson) => {
  let concept = 0;
  let codeSent = 0;
  const variants = [lesson.code, lesson.code2 ?? lesson.code];
  return {
    name: 'good',
    next(tutor: string): string {
      // A concrete list in the question → answer count/sum correctly.
      const list = tutor.match(/\[\s*(\d+(?:\s*,\s*\d+)+)\s*\]/);
      if (list && /\b(total|count|sum|iterations|how many)\b/i.test(tutor)) {
        const nums = list[1].split(',').map(Number);
        return `count is ${nums.length} and total is ${nums.reduce((a, b) => a + b, 0)}`;
      }
      const range = evalRange(tutor);
      if (range !== null) return range;
      const sum = tutor.match(/(\d+)\s*\+\s*(\d+)/);
      if (sum) return String(Number(sum[1]) + Number(sum[2]));
      // Code when asked — a DIFFERENT correct sample each time, then fall back to concepts
      // (a real strong student never sends the same paste four times).
      if (/\b(write|refactor|rewrite|code|chain|produce|convert)\b/i.test(tutor) && codeSent < variants.length) {
        return variants[codeSent++];
      }
      return lesson.concepts[concept++ % lesson.concepts.length];
    },
  };
};

const bad: Persona = () => {
  const answers = [
    'idk',
    'is it 7?',
    'the else runs first i think',
    "if x = 5 print('big')",
    'im lost',
    'maybe true?',
    'no clue honestly',
    'it prints everything?',
  ];
  let i = 0;
  return { name: 'bad', next: () => answers[i++ % answers.length] };
};

const edge: Persona = () => {
  let lastTutor = '';
  const script: (string | 'PARROT')[] = [
    'what?',
    'who won the world cup in 2022?',
    'ive been stuck on this for hours and i feel stupid',
    'understood',
    'PARROT',
    'ok got it',
    'asdkjh asdkj',
    'can we skip this?',
    'understood',
    'ok',
  ];
  return {
    name: 'edge',
    next(tutor: string, i: number): string {
      lastTutor = tutor;
      const s = script[Math.min(i, script.length - 1)];
      if (s === 'PARROT') {
        const sentences = lastTutor.split(/(?<=[.!?])\s+/);
        return sentences[sentences.length - 1] ?? 'ok';
      }
      return s;
    },
  };
};

/** TutorBench-flavored student: name preference, wrong-work-claiming-done, asks for a
 *  paste-able one-liner, distress, then recovers — exercises the scenario failure modes. */
const tricky: Persona = (lesson) => {
  const smart = good(lesson);
  const bad = lesson.badCode ?? "if x = 5 print('ok')";
  return {
    name: 'tricky',
    next(tutor: string, i: number): string {
      if (i === 0) return 'call me Omer, not Mr — ok lets start';
      if (i === 1) return `${bad}\ndone — works right?`;
      if (i === 2) return 'just give me a one-liner i can paste and run';
      if (i === 3) return 'ive been stuck on this for two hours and im about to quit';
      if (i === 5) return 'understood';
      return smart.next(tutor, i);
    },
  };
};

/** Dumps a comprehensive correct solution UNPROMPTED at turn 0 — the sync-v2 case: one
 *  message that should implicitly satisfy several milestones at once. */
const eager: Persona = (lesson) => {
  const smart = good(lesson);
  return {
    name: 'eager',
    next(tutor: string, i: number): string {
      if (i === 0) return `i already know this one:\n${lesson.code}`;
      return smart.next(tutor, i);
    },
  };
};

/** A realistic student: sometimes right, sometimes confused, sometimes typing nonsense. */
const mixed: Persona = (lesson) => {
  const smart = good(lesson);
  return {
    name: 'mixed',
    next(tutor: string, i: number): string {
      if (i === 1) return 'what?';
      if (i === 3) return 'fjdks jfkdsj';
      if (i === 5) return 'i think its false? not sure';
      if (i === 7) return 'understood';
      return smart.next(tutor, i);
    },
  };
};

const PERSONAS: Record<string, Persona> = { good, bad, edge, mixed, tricky, eager };

// ── Runner ───────────────────────────────────────────────────────────────────────
interface TurnRecord {
  student: string | null;
  reply: string;
  status: string;
  fields: { label: string; value: string }[];
  calls: { label: string; ms: number; user: string; response: string }[];
}

async function runConversation(lessonKey: string, personaKey: string, maxTurns: number): Promise<TurnRecord[]> {
  const lesson = LESSONS[lessonKey];
  const persona = PERSONAS[personaKey](lesson);
  const engine = createMilestoneEngine(lesson.brief, makeLlm());
  const records: TurnRecord[] = [];

  const record = (view: TurnView, student: string | null) => {
    records.push({
      student,
      reply: view.reply,
      status: view.status,
      fields: view.debug?.fields ?? [],
      calls: (view.debug?.calls ?? []).map((c) => ({
        label: c.label,
        ms: Math.round(c.ms),
        user: c.user,
        response: c.response,
      })),
    });
  };

  let view = await engine.start();
  await view.suggestions; // settle chips so the call log stays per-turn
  record(view, null);
  for (let i = 0; i < maxTurns && !view.done; i++) {
    const msg = persona.next(view.reply, i);
    view = await engine.respond(msg);
    await view.suggestions;
    record(view, msg);
  }
  return records;
}

function renderTranscript(lessonKey: string, personaKey: string, records: TurnRecord[]): string {
  const lines: string[] = [`# ${lessonKey} · ${personaKey} student`, ''];
  for (const [i, r] of records.entries()) {
    if (r.student !== null) lines.push(`**Student:** ${r.student}`, '');
    lines.push(`**Tutor:** ${r.reply}`, '');
    const rails = r.fields.find((f) => f.label === 'rails fired')?.value;
    const attempts = r.fields.find((f) => f.label === 'attempts')?.value;
    const assess = r.fields.find((f) => f.label === 'last assessment')?.value;
    lines.push(
      `> turn ${i} · ${r.status} · attempts=${attempts ?? '-'}${rails ? ` · rails: ${rails}` : ''}${assess ? ` · assess: ${assess}` : ''}`,
      '',
    );
  }
  return lines.join('\n');
}

function renderCalls(lessonKey: string, personaKey: string, records: TurnRecord[]): string {
  const lines: string[] = [`# ${lessonKey} · ${personaKey} — model calls`, ''];
  for (const [i, r] of records.entries()) {
    lines.push(`## turn ${i}${r.student !== null ? ` (student: ${JSON.stringify(r.student)})` : ' (opening)'}`);
    for (const c of r.calls) {
      lines.push(`### ${c.label} · ${c.ms}ms`, '', '```', `USER (tail): …${c.user.slice(-700)}`, '```', '', '```', `RESPONSE: ${c.response}`, '```', '');
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const [runLabel = 'run', ...pairs] = process.argv.slice(2);
  const todo = pairs.length
    ? pairs.map((p) => p.split(':') as [string, string])
    : ([
        ['elif', 'good'],
        ['elif', 'bad'],
        ['elif', 'edge'],
        ['counters', 'good'],
        ['counters', 'bad'],
        ['bools', 'edge'],
      ] as [string, string][]);

  const outDir = join(OUT_ROOT, runLabel);
  mkdirSync(outDir, { recursive: true });

  for (const [lessonKey, personaKey] of todo) {
    const t0 = Date.now();
    process.stdout.write(`▶ ${lessonKey}:${personaKey} … `);
    try {
      const records = await runConversation(lessonKey, personaKey, 10);
      writeFileSync(join(outDir, `${lessonKey}-${personaKey}.md`), renderTranscript(lessonKey, personaKey, records));
      writeFileSync(join(outDir, `${lessonKey}-${personaKey}.calls.md`), renderCalls(lessonKey, personaKey, records));
      const calls = records.reduce((n, r) => n + r.calls.length, 0);
      console.log(`done: ${records.length} turns, ${calls} calls, ${Math.round((Date.now() - t0) / 1000)}s → ${records[records.length - 1].status}`);
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
    }
  }
  console.log(`\nTranscripts in ${outDir}`);
}

main();
