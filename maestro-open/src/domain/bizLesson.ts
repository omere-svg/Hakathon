import type { Lesson } from './schema';

// BIZ unit-economics lesson — DRAFT structure, authored with the v2.5 decomposition
// (05-research/offline-to-ondevice-pipeline.md §1): each knowledge component carries a
// Presentation Guideline (how to teach it), gradeable checks + keys, misconceptions
// with remediations, and a hint ladder. Demonstrates the method generalizes from CS to
// Business. Not yet wired into the UI (the lesson picker is future work) — it exists so
// the decomposition is concrete and type-checked.

export const bizLesson: Lesson = {
  id: 'biz-w1-unit-economics',
  program: 'Masterschool Fellowship',
  course: 'Business · Unit Economics',
  title: 'Unit economics: margin, CAC, LTV',
  topic: 'unit economics',
  knowledgeComponents: [
    {
      id: 'kc-gross-margin',
      label: 'gross margin',
      prerequisites: [],
      presentation: {
        coreIdea: 'Gross margin is profit as a share of revenue: (price − cost) / price.',
        analogy: 'Of every $1 a customer pays, how many cents are left after the cost to deliver it.',
        arc: ['margin is about revenue, not cost', 'formula (price − cost) / price', 'work an example'],
        emphasize: ['the denominator is PRICE (revenue), not cost — this is where people slip'],
        avoid: ['don\'t confuse it with markup (which divides by cost)'],
      },
      content: {
        explanation:
          'Gross margin is profit over revenue: (price − cost) / price. It tells you what fraction of each sale you keep after the direct cost of delivering it.',
      },
      checks: [
        {
          id: 'c-gm',
          prompt: 'A product costs $40 to make and sells for $50. What is the gross margin %?',
          type: 'numeric',
          isChallenge: false,
          answerKey: { numericValue: 20, numericTolerance: 0.5, canonicalAnswer: '20%' },
        },
      ],
      misconceptions: [
        {
          id: 'm-cost-denominator',
          kcId: 'kc-gross-margin',
          description: 'Divides profit by cost instead of by price (computes markup, not margin).',
          remediation: 'Margin is a share of REVENUE — what number should go on the bottom, the price or the cost?',
        },
      ],
      hints: [
        'Margin is a fraction of revenue, not of cost.',
        'Profit is (price − cost); divide that by the price.',
      ],
      masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: true },
    },
    {
      id: 'kc-cac',
      label: 'customer acquisition cost (CAC)',
      prerequisites: ['kc-gross-margin'],
      presentation: {
        coreIdea: 'CAC is what you spend to win one customer: sales + marketing ÷ new customers.',
        analogy: 'If you spent $1,000 on ads and got 10 customers, each one cost you $100 to acquire.',
        arc: ['why acquisition has a cost', 'the formula', 'check understanding'],
        emphasize: ['count ALL sales + marketing spend in the numerator'],
        avoid: ['don\'t fold in delivery/COGS — that\'s margin, not CAC'],
      },
      content: {
        explanation:
          'CAC (customer acquisition cost) is your sales + marketing spend in a period divided by the number of new customers it won.',
      },
      checks: [
        {
          id: 'c-cac',
          prompt: 'You spend $2,000 on marketing and win 40 new customers. What is your CAC (in $)?',
          type: 'numeric',
          isChallenge: false,
          answerKey: { numericValue: 50, numericTolerance: 0.5, canonicalAnswer: '$50' },
        },
      ],
      misconceptions: [],
      hints: [
        'CAC = total acquisition spend ÷ new customers.',
        'Divide the $2,000 by the 40 customers it produced.',
      ],
      masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
    },
    {
      id: 'kc-ltv',
      label: 'lifetime value (LTV)',
      prerequisites: ['kc-cac'],
      presentation: {
        coreIdea: 'LTV is the total gross profit one customer brings over their whole relationship.',
        analogy: 'Not what they pay once — what they\'re worth across every month they stay.',
        arc: ['LTV = ARPU × gross margin % × average lifespan', 'why margin (not revenue) belongs in it', 'compare LTV to CAC'],
        emphasize: ['a healthy business has LTV comfortably above CAC'],
        avoid: ['don\'t give a fill-in-the-blanks template with placeholders — give a concrete worked formula'],
      },
      content: {
        explanation:
          'LTV (lifetime value) = ARPU × gross margin % × average customer lifespan (in months). Use gross margin, not revenue, so it reflects real profit.',
      },
      checks: [
        {
          id: 'c-ltv',
          prompt: 'Which best describes a healthy unit economics relationship?',
          type: 'mcq',
          isChallenge: false,
          answerKey: { mcqCorrectIndex: 1, mcqMisconceptionByIndex: { 0: 'm-ltv-revenue' }, canonicalAnswer: 'LTV is several times larger than CAC' },
        },
      ],
      misconceptions: [
        {
          id: 'm-ltv-revenue',
          kcId: 'kc-ltv',
          description: 'Uses revenue instead of gross margin in LTV, overstating customer value.',
          remediation: 'Should LTV count the whole price the customer pays, or only the profit you keep after costs?',
        },
      ],
      hints: [
        'Compare what a customer is worth (LTV) to what they cost to acquire (CAC).',
        'For the business to work, value should exceed acquisition cost — by how much?',
      ],
      masteryCriteria: { minCorrect: 1, requireNoActiveMisconception: false },
    },
  ],
  reviewQuestions: [],
};

export const BIZ_MCQ_OPTIONS: Record<string, string[]> = {
  'c-ltv': [
    'LTV roughly equals CAC',
    'LTV is several times larger than CAC',
    'CAC is larger than LTV',
    'LTV and CAC are unrelated',
  ],
};
