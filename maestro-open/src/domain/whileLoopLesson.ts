import type { Lesson } from './schema';

// Sample lesson authored from the Maestro reference course
// "Week 3 — Decisions and Loops", lesson 8 "Meet the while loop".
// (In production this JSON is generated offline by a big model from the LMS lesson.)
//
// 3 knowledge components, each deterministically gradeable:
//   KC1 concept (MCQ) -> KC2 infinite-loop risk (MCQ + misconception) -> KC3 write a loop (code).

export const whileLoopLesson: Lesson = {
  id: 'ff-w3-l8-while-loop',
  program: 'Masterschool Fellowship',
  course: 'Week 3 — Decisions and Loops',
  title: 'Meet the while loop',
  topic: 'while loops',
  knowledgeComponents: [
    {
      id: 'kc-while-basics',
      label: 'while loop basics',
      prerequisites: [],
      presentation: {
        coreIdea: 'A while loop repeats until a condition stops being true — use it when you don\'t know the count in advance.',
        analogy: '"Keep stirring while the sauce is too thick" — you stop the instant the condition flips.',
        arc: ['what "while" means', 'for-loop = known count vs while = repeat-until-change', 'check understanding'],
        emphasize: ['the loop ends the moment the condition becomes false'],
        avoid: ['don\'t introduce break/continue yet', 'don\'t show infinite-loop bugs yet'],
      },
      exemplars: {
        EXPLAIN:
          'A while loop keeps running as long as its condition stays true — like "keep stirring while the sauce is too thick." Do you reach for it when you know the exact number of repeats, or when you repeat until something changes?',
        HINT: "Here's a nudge: think about what each loop is best at — one is for a known count, the other repeats until something changes. Which fits an unknown number of steps?",
      },
      content: {
        explanation:
          'A while loop repeats a block of code as long as its condition stays true. Unlike a for loop, which is best when you know how many times to repeat, a while loop is best when you repeat until something changes.',
        analogy:
          'Think of it like "keep stirring while the sauce is too thick" — you stop the moment the condition is no longer true.',
      },
      checks: [
        {
          id: 'c-when-while',
          prompt: 'When is a while loop usually a better choice than a for loop?',
          type: 'mcq',
          isChallenge: false,
          answerKey: {
            mcqCorrectIndex: 1,
            canonicalAnswer: 'When you repeat until a condition changes (unknown number of times).',
          },
        },
      ],
      misconceptions: [],
      hints: [
        'Think about what each loop is best at.',
        'One loop is for a known count; the other repeats until something changes.',
      ],
      masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: true },
    },
    {
      id: 'kc-infinite-loop',
      label: 'infinite loops',
      prerequisites: ['kc-while-basics'],
      presentation: {
        coreIdea: 'A while loop only stops when its condition turns false — so something inside must change toward that.',
        arc: ['the condition must eventually become false', 'so a variable in it must change each pass', 'spot the missing update'],
        emphasize: ['no break is needed — the condition itself ends a correct loop'],
        avoid: ['don\'t suggest break as the fix; the real fix is updating the variable'],
      },
      exemplars: {
        CORRECT:
          'Not quite — a while loop actually stops on its own when its condition turns false, no break needed. What would have to change about `count` for `count < 5` to eventually become false?',
        HINT: "Here's a nudge: look at the loop's condition and ask what it depends on. Does anything inside the loop ever change that value?",
      },
      content: {
        explanation:
          'A while loop only ends when its condition becomes false. If nothing inside the loop ever changes the condition, the loop runs forever — an infinite loop.',
        workedExample:
          'count = 0\nwhile count < 5:\n    print("Hi")\n    count += 1   # <- this line is what eventually makes the condition false',
      },
      checks: [
        {
          id: 'c-infinite',
          prompt:
            'What is the main problem in this code?\n\ncount = 0\nwhile count < 5:\n    print("Hi")',
          type: 'mcq',
          isChallenge: false,
          answerKey: {
            mcqCorrectIndex: 2,
            mcqMisconceptionByIndex: { 0: 'm-needs-break' },
            canonicalAnswer: 'count is never updated, so the loop never ends.',
          },
        },
      ],
      misconceptions: [
        {
          id: 'm-needs-break',
          kcId: 'kc-infinite-loop',
          description: 'Believes a while loop needs an explicit break to ever stop.',
          remediation:
            'A while loop stops on its own when its condition turns false — no break needed. What in the code would have to change for `count < 5` to eventually be false?',
        },
      ],
      hints: [
        'Look at the loop condition. What does it depend on?',
        'Does anything inside the loop ever change `count`?',
        'If `count` never changes, can `count < 5` ever become false?',
      ],
      masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: true },
    },
    {
      id: 'kc-write-while',
      label: 'writing a while loop',
      prerequisites: ['kc-infinite-loop'],
      presentation: {
        coreIdea: 'A correct while loop has three parts: set up a variable, loop while a condition holds, update the variable inside.',
        arc: ['initialize', 'loop-while-condition', 'update-inside-to-terminate', 'now you write one'],
        emphasize: ['the update line is what prevents an infinite loop'],
        avoid: ['don\'t write the full solution for them — scaffold it'],
      },
      content: {
        explanation:
          'Now you write one. A correct while loop has three parts: set up a variable, loop while a condition holds, and update the variable inside so the loop ends.',
        workedExample:
          'A countdown: start at n, print while n > 0, and do n -= 1 each pass.',
      },
      checks: [
        {
          id: 'c-sum-to-n',
          prompt:
            'Write a JavaScript function `sumToN(n)` that uses a while loop to return 1 + 2 + ... + n. (e.g. sumToN(5) === 15)',
          type: 'code',
          isChallenge: false,
          answerKey: {
            functionName: 'sumToN',
            codeTests: [
              { args: [5], expected: 15 },
              { args: [1], expected: 1 },
              { args: [10], expected: 55 },
            ],
            canonicalAnswer:
              'function sumToN(n){let total=0,i=1;while(i<=n){total+=i;i++;}return total;}',
          },
        },
      ],
      misconceptions: [],
      hints: [
        'Keep a running total and a counter that starts at 1.',
        'Loop while the counter is <= n; add the counter to the total each pass.',
        'Remember to increase the counter inside the loop, or it never ends.',
      ],
      masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
    },
  ],
  reviewQuestions: [
    {
      id: 'rq-infinite',
      question: 'What is the main problem in this code?\n\ncount = 0\nwhile count < 5:\n    print("Hi")',
      options: [
        'A while loop will not run unless it includes an explicit break',
        'The condition is wrong',
        'count is never updated, so the loop never ends',
        'while loops cannot print',
      ],
      correctIndex: 2,
      points: 10,
    },
  ],
};

// MCQ option text lives with the UI/check rendering. For the seed lesson we keep
// the options alongside the check via this lookup (kept out of the answer key so
// the engine never sees the correct index unless a tool reads it).
export const MCQ_OPTIONS: Record<string, string[]> = {
  'c-when-while': [
    'When you know exactly how many times to repeat',
    'When you repeat until a condition changes',
    'When you never need to repeat',
    'While loops and for loops are identical',
  ],
  'c-infinite': [
    'A while loop will not run unless it includes an explicit break',
    'The condition is wrong',
    'count is never updated, so the loop never ends',
    'while loops cannot print',
  ],
};
