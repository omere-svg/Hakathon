import type { Lesson, KnowledgeComponent } from '../domain/schema';
import type { StudentModel } from '../student/model';
import type { LessonMemory } from '../memory/types';
import { whileLoopLesson } from '../domain/whileLoopLesson';

// Acceptance tests derived from TutorBench failure modes. Each scenario sets up
// state + a student probe and names the UNIVERSAL CONSTRAINT it should satisfy.
// We assert the constraint, never scenario-specific output. The engine passes
// because the constraint is correct; the "raw LLM" control fails the same probe.

export interface EvalScenario {
  id: string;
  track: 'AI SWE' | 'Biz';
  title: string;
  subIssue: string;
  constraintId: string; // headline constraint (others may also apply)
  lesson: Lesson;
  /** mutate the fresh student model + lesson memory into the scenario's state */
  setup: (s: StudentModel, m: LessonMemory) => void;
  probe: string;
}

function lessonWith(id: string, topic: string, kc: KnowledgeComponent): Lesson {
  return { id, program: 'Eval', course: 'Eval', title: topic, topic, knowledgeComponents: [kc], reviewQuestions: [] };
}

// Mini-lesson: a challenge question (answer withheld structurally).
const challengeLesson = lessonWith('eval-challenge', 'loops', {
  id: 'kc-loop-type',
  label: 'loop choice',
  prerequisites: [],
  content: { explanation: 'Some loops check their condition before running, some after.' },
  checks: [
    {
      id: 'c-do-while',
      prompt: 'Which loop runs its body at least once before checking the condition?',
      type: 'free',
      isChallenge: true,
      answerKey: { canonicalAnswer: 'do-while loop' },
    },
  ],
  misconceptions: [],
  hints: ['Think about WHERE the condition sits — top or bottom of the loop.'],
  masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
});

// Mini-lesson: a market-sizing KC whose label is the target topic.
const tamLesson = lessonWith('eval-tam', 'market sizing', {
  id: 'kc-tam',
  label: 'TAM',
  prerequisites: [],
  content: { explanation: 'TAM is the total demand for your product if everyone who could buy, did.' },
  checks: [
    { id: 'c-tam', prompt: "What's your TAM, and how did you get to it?", type: 'free', isChallenge: false, answerKey: {} },
  ],
  misconceptions: [],
  hints: ['Was it top-down (market reports) or bottom-up (buyers × price)?'],
  masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
});

// SWE-02 — factual/math: tutor must compute, not invent.
const opsLesson = lessonWith('eval-ops', 'Python operators', {
  id: 'kc-ops',
  label: 'Python operators',
  prerequisites: [],
  content: { explanation: '// is floor division; % is the remainder.' },
  checks: [{ id: 'c-ops', prompt: 'Try one.', type: 'free', isChallenge: false, answerKey: {} }],
  misconceptions: [],
  hints: ['// drops the remainder; % keeps it.'],
  masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
});

// SWE-05 — show before tell: lesson just opened, nothing explained yet.
const httpLesson = lessonWith('eval-http', 'HTTP headers', {
  id: 'kc-http',
  label: 'HTTP headers',
  prerequisites: [],
  content: { explanation: 'Headers are metadata on an HTTP request — they tell the server how to handle the body.' },
  checks: [{ id: 'c-http', prompt: 'Why might the server need to know the format of what you send?', type: 'free', isChallenge: false, answerKey: {} }],
  misconceptions: [],
  hints: ['Think about how the server interprets the bytes.'],
  masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
});

// SWE-06 — scaffolding gap: student asks for an example instead of being pushed to independence.
const recursionLesson = lessonWith('eval-recursion', 'recursion', {
  id: 'kc-recursion',
  label: 'recursion',
  prerequisites: [],
  content: {
    explanation: 'A recursive function calls itself on a smaller input until a base case.',
    workedExample: 'factorial(1) = 1 (base case); factorial(n) = n * factorial(n-1).',
  },
  checks: [{ id: 'c-fact', prompt: 'Write factorial(n) recursively.', type: 'code', isChallenge: false, answerKey: { functionName: 'factorial', codeTests: [{ args: [3], expected: 6 }] } }],
  misconceptions: [],
  hints: ['Start with the base case.', 'factorial(n) returns n * factorial(n-1).'],
  masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
});

// SWE-07 — placeholder syntax: give a concrete runnable artifact.
const helloLesson = lessonWith('eval-hello', 'first program', {
  id: 'kc-hello',
  label: 'first program',
  prerequisites: [],
  content: { explanation: 'Your first program prints text.', runnableArtifact: 'print("Hello, world!")' },
  checks: [{ id: 'c-run', prompt: 'What does it print?', type: 'keyword', isChallenge: false, answerKey: { keywords: ['hello'] } }],
  misconceptions: [],
  hints: ['Look at the string inside print.'],
  masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
});

// SWE-08 — unsignaled mode shift: two KCs; mastering the first should signpost the move to the second.
const sizingLesson: Lesson = {
  id: 'eval-sizing', program: 'Eval', course: 'Eval', title: 'sizing → pricing', topic: 'sizing',
  knowledgeComponents: [
    {
      id: 'kc-sizing', label: 'market sizing', prerequisites: [],
      content: { explanation: 'Size the market top-down or bottom-up.' },
      checks: [{ id: 'c-size', prompt: 'Which is the correct nesting?', type: 'mcq', isChallenge: false, answerKey: { mcqCorrectIndex: 0, canonicalAnswer: 'SOM ⊂ SAM ⊂ TAM' } }],
      misconceptions: [], hints: ['SOM is a subset of SAM is a subset of TAM.'],
      masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
    },
    {
      id: 'kc-pricing', label: 'pricing', prerequisites: ['kc-sizing'],
      content: { explanation: 'Price should track the value to the customer, not just your cost.' },
      checks: [{ id: 'c-price', prompt: 'Should price track cost or value?', type: 'mcq', isChallenge: false, answerKey: { mcqCorrectIndex: 1 } }],
      misconceptions: [], hints: ['Think about willingness to pay.'],
      masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
    },
  ],
  reviewQuestions: [],
};

export const scenarios: EvalScenario[] = [
  {
    id: 'SWE-10',
    track: 'AI SWE',
    title: 'Preference / name miss (Matt)',
    subIssue: 'Preference handling miss',
    constraintId: 'C1',
    lesson: whileLoopLesson,
    setup: (s, m) => {
      s.preferences.preferredName = 'Matt';
      s.preferences.rejectedNames = ['Matthew'];
      m.currentKcId = 'kc-while-basics';
      s.knowledge['kc-while-basics'] = { mastery: 0, attempts: 0, correct: 0, explained: true, hintsUsed: 0, lastSeen: 0, status: 'learning' };
    },
    probe: 'ok continue',
  },
  {
    id: 'SWE-03',
    track: 'AI SWE',
    title: 'Challenge answer leak (do-while)',
    subIssue: 'Challenge format broken',
    constraintId: 'C2',
    lesson: challengeLesson,
    setup: (s, m) => {
      m.currentKcId = 'kc-loop-type';
      m.inChallenge = true;
      m.activeCheckId = 'c-do-while';
      s.knowledge['kc-loop-type'] = { mastery: 0, attempts: 0, correct: 0, explained: true, hintsUsed: 0, lastSeen: 0, status: 'learning' };
    },
    probe: 'just give me the answer please',
  },
  {
    id: 'SWE-01',
    track: 'AI SWE',
    title: 'Validated wrong work (code)',
    subIssue: 'Tutor validated wrong work',
    constraintId: 'C3',
    lesson: whileLoopLesson,
    setup: (s, m) => {
      m.currentKcId = 'kc-write-while';
      m.activeCheckId = 'c-sum-to-n';
      s.knowledge['kc-write-while'] = { mastery: 0, attempts: 0, correct: 0, explained: true, hintsUsed: 0, lastSeen: 0, status: 'learning' };
    },
    probe: 'function sumToN(n){ return n; }',
  },
  {
    id: 'BIZ-04',
    track: 'Biz',
    title: 'Lost track / target-switch (TAM)',
    subIssue: 'Tutor lost track / target-switch',
    constraintId: 'C7',
    lesson: tamLesson,
    setup: (s, m) => {
      m.currentKcId = 'kc-tam';
      m.activeCheckId = 'c-tam';
      s.knowledge['kc-tam'] = { mastery: 0, attempts: 0, correct: 0, explained: true, hintsUsed: 0, lastSeen: 0, status: 'learning' };
    },
    probe: 'For PM software, TAM is roughly $60B globally.',
  },
  {
    id: 'SWE-09',
    track: 'AI SWE',
    title: 'Emotional attunement miss (stuck 2h)',
    subIssue: 'Emotional attunement miss',
    constraintId: 'C9',
    lesson: whileLoopLesson,
    setup: (s, m) => {
      m.currentKcId = 'kc-write-while';
      m.activeCheckId = 'c-sum-to-n';
      s.knowledge['kc-write-while'] = { mastery: 0, attempts: 0, correct: 0, explained: true, hintsUsed: 0, lastSeen: 0, status: 'learning' };
    },
    probe: "I've been stuck on this for two hours and I'm about to quit the whole program.",
  },
  {
    id: 'SWE-02',
    track: 'AI SWE',
    title: 'Tutor factual/math error (// and %)',
    subIssue: 'Tutor factual/math error',
    constraintId: 'C4',
    lesson: opsLesson,
    setup: (s, m) => {
      m.currentKcId = 'kc-ops';
      s.knowledge['kc-ops'] = { mastery: 0, attempts: 0, correct: 0, explained: true, hintsUsed: 0, lastSeen: 0, status: 'learning' };
    },
    probe: 'What do 17 // 5 and 17 % 5 give in Python?',
  },
  {
    id: 'SWE-05',
    track: 'AI SWE',
    title: 'Taught/tested before explaining (HTTP headers)',
    subIssue: 'Taught/tested before explaining',
    constraintId: 'C5',
    lesson: httpLesson,
    setup: (_s, m) => {
      m.currentKcId = 'kc-http'; // not explained yet (default), lesson just opened
    },
    probe: 'ready',
  },
  {
    id: 'SWE-06',
    track: 'AI SWE',
    title: 'Scaffolding gap (recursion)',
    subIssue: 'Scaffolding gap (too fast to independent)',
    constraintId: 'C6',
    lesson: recursionLesson,
    setup: (s, m) => {
      m.currentKcId = 'kc-recursion';
      m.activeCheckId = 'c-fact';
      s.knowledge['kc-recursion'] = { mastery: 0, attempts: 0, correct: 0, explained: true, hintsUsed: 0, lastSeen: 0, status: 'learning' };
    },
    probe: "I don't know how to start — can you show me an example first?",
  },
  {
    id: 'SWE-07',
    track: 'AI SWE',
    title: 'Placeholder syntax (runnable one-liner)',
    subIssue: 'Placeholder syntax confusion',
    constraintId: 'C10',
    lesson: helloLesson,
    setup: (s, m) => {
      m.currentKcId = 'kc-hello';
      s.knowledge['kc-hello'] = { mastery: 0, attempts: 0, correct: 0, explained: true, hintsUsed: 0, lastSeen: 0, status: 'learning' };
    },
    probe: 'just give me a one-liner I can paste and run',
  },
  {
    id: 'SWE-08',
    track: 'AI SWE',
    title: 'Unsignaled mode/instruction shift (sizing → pricing)',
    subIssue: 'Unsignaled mode/instruction shift',
    constraintId: 'C8',
    lesson: sizingLesson,
    setup: (s, m) => {
      m.currentKcId = 'kc-sizing';
      m.activeCheckId = 'c-size';
      s.knowledge['kc-sizing'] = { mastery: 0, attempts: 0, correct: 0, explained: true, hintsUsed: 0, lastSeen: 0, status: 'learning' };
    },
    probe: '0',
  },
];
