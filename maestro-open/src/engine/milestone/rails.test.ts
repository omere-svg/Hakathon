// Tests for the deterministic text rails (rails.ts) — each maps to a TutorBench failure
// mode the small model can't be trusted to handle alone. False positives matter as much
// as hits: a rail that fires on normal messages degrades every lesson.

import { describe, expect, it } from 'vitest';
import {
  claimsInfiniteLoop,
  containsCodeSignal,
  containsUnqualifiedPraise,
  contradictsVerdict,
  scrubInfiniteClaims,
  detectDistress,
  detectPreferredName,
  isAcknowledgment,
  isAllQuestions,
  isClarifyingQuestion,
  isConfusion,
  isVacuousQuestion,
  looksLikeNonPythonCode,
  mentionsOtherLanguage,
  questionSentences,
  requiresCodeProduction,
  scrubPraise,
  talksAboutStudent,
} from './rails';

describe('isAcknowledgment (trust-the-student ruling)', () => {
  it('accepts pure acknowledgments — the exact live message included', () => {
    expect(isAcknowledgment('understood')).toBe(true);
    expect(isAcknowledgment('ok')).toBe(true);
    expect(isAcknowledgment('OK, got it!')).toBe(true);
    expect(isAcknowledgment('makes sense, thanks')).toBe(true);
    expect(isAcknowledgment('I understand now')).toBe(true);
    expect(isAcknowledgment('yes i understand')).toBe(true);
  });

  it('a question mark defeats it — "understood?" is asking, not confirming', () => {
    expect(isAcknowledgment('understood?')).toBe(false);
    expect(isAcknowledgment('ok but why does it stop?')).toBe(false);
  });

  it('any real content defeats it — the grader must still see substantive replies', () => {
    expect(isAcknowledgment('ok but I still think it never stops')).toBe(false);
    expect(isAcknowledgment('I understand the loop but not the condition')).toBe(false);
    expect(isAcknowledgment('the loop stops when the condition is false')).toBe(false);
    expect(isAcknowledgment('yes')).toBe(false); // could be answering a question, not acknowledging
    expect(isAcknowledgment('')).toBe(false);
  });
});

describe('containsUnqualifiedPraise (SWE/BIZ-01)', () => {
  it('flags correctness-affirming praise', () => {
    expect(containsUnqualifiedPraise('Correct! The loop stops at zero.')).toBe(true);
    expect(containsUnqualifiedPraise("That's right, well done.")).toBe(true);
    expect(containsUnqualifiedPraise('Exactly — nicely done. What next?')).toBe(true);
    expect(containsUnqualifiedPraise('You got it!')).toBe(true);
  });

  it('does NOT flag negated or qualified praise', () => {
    expect(containsUnqualifiedPraise("That's not correct — a while loop checks first.")).toBe(false);
    expect(containsUnqualifiedPraise("Close, but not quite right. Let's look again.")).toBe(false);
    expect(containsUnqualifiedPraise("That isn't exactly what happens here.")).toBe(false);
  });

  it('does NOT flag effort-acknowledging language', () => {
    expect(containsUnqualifiedPraise('Good try! A while loop actually checks the condition first.')).toBe(false);
    expect(containsUnqualifiedPraise('I can see the thinking there. What does the condition do?')).toBe(false);
  });

  it('flags a praising sentence even when another sentence has a qualifier', () => {
    expect(containsUnqualifiedPraise('Perfect! But there is one more thing to cover.')).toBe(true);
  });
});

describe('scrubPraise', () => {
  it('drops only the praising sentences', () => {
    const out = scrubPraise('Correct! Now, a while loop checks its condition first. What does that mean?');
    expect(out).not.toContain('Correct!');
    expect(out).toContain('a while loop checks its condition first');
  });

  it('falls back to an honest re-engage when everything was praise', () => {
    const out = scrubPraise('Well done! Exactly right!');
    expect(out).toContain('Not quite');
    expect(out).toContain('?');
  });
});

describe('questionSentences (booleans-trace rail unit)', () => {
  it('extracts each question sentence', () => {
    expect(questionSentences('Booleans have two values. What is True and False? Sure?')).toEqual([
      'What is True and False?',
      'Sure?',
    ]);
  });

  it('returns [] for a reply with no questions', () => {
    expect(questionSentences('True and False evaluates to False.')).toEqual([]);
  });
});

describe('isAllQuestions', () => {
  it('flags the live attempts-3 turn: one question, no example, no answer', () => {
    expect(
      isAllQuestions('What would the result be if we evaluated True and False in this expression: True and False?'),
    ).toBe(true);
  });

  it('passes a reply that explains before asking', () => {
    expect(
      isAllQuestions('True and False evaluates to False because and needs both sides True. What does True and True give?'),
    ).toBe(false);
  });
});

describe('isVacuousQuestion (self-answer + filler-stub trace)', () => {
  it('flags the live filler stubs — questions with nothing left to answer', () => {
    expect(isVacuousQuestion("What's your answer?")).toBe(true);
    expect(isVacuousQuestion("What's your take on that?")).toBe(true);
    expect(isVacuousQuestion("What's your first thought?")).toBe(true);
    expect(isVacuousQuestion("What's your thought?")).toBe(true);
    expect(isVacuousQuestion('What do you think?')).toBe(true); // bare — no object
    expect(isVacuousQuestion('Does that make sense?')).toBe(true);
  });

  it('passes real questions with a checkable answer', () => {
    expect(isVacuousQuestion('What do you think the result would be?')).toBe(false); // has an object
    expect(isVacuousQuestion('What does 4 % 2 equal?')).toBe(false);
    expect(isVacuousQuestion('How would that look in code?')).toBe(false);
    expect(isVacuousQuestion('What numbers would range(3) produce?')).toBe(false);
  });
});

describe('looksLikeNonPythonCode', () => {
  it('flags the live chimera and JS lines', () => {
    expect(looksLikeNonPythonCode('like this: `var result = True;` and `var other = False;`')).toBe(true);
    expect(looksLikeNonPythonCode('try `let result = true; let other = false;`')).toBe(true);
    expect(looksLikeNonPythonCode('check `x === 5` here')).toBe(true);
  });

  it('flags teaching ANOTHER language by name in a Python lesson (harness iter1)', () => {
    expect(looksLikeNonPythonCode('JavaScript uses the equals sign for equality, so 1 == 1 is True.')).toBe(true);
    expect(looksLikeNonPythonCode("What's the identity equality comparison in JavaScript between two strings?")).toBe(true);
    expect(looksLikeNonPythonCode('In Python, use == for value equality and is for identity.')).toBe(false);
  });

  it('flags PROSE-STYLE non-Python outside backticks (the elif trace example)', () => {
    expect(
      looksLikeNonPythonCode(
        'if num > 1 and num < 10, print("Greater"); else if num <= 10, print("Between"); else, print("Less")',
      ),
    ).toBe(true);
    expect(looksLikeNonPythonCode('you could write else if num == 2 there')).toBe(true); // Python spells it elif
    expect(looksLikeNonPythonCode('call print(x); then continue')).toBe(true); // statement semicolon
  });

  it('passes valid Python and ordinary prose ("Let me explain" is not `let`)', () => {
    expect(looksLikeNonPythonCode('Let me explain: `result = True` stores a boolean. What does `result` hold?')).toBe(
      false,
    );
    expect(looksLikeNonPythonCode('Try `for i in range(3): print(i)` — what prints?')).toBe(false);
  });
});

describe('claimsInfiniteLoop / scrubInfiniteClaims (the recurring "runs forever" hallucination)', () => {
  it('detects the live phrasings', () => {
    expect(claimsInfiniteLoop('the loop runs forever because n never leaves 1')).toBe(true);
    expect(claimsInfiniteLoop("that's the same loop forever, it never exits")).toBe(true);
    expect(claimsInfiniteLoop('this is an infinite loop')).toBe(true);
    expect(claimsInfiniteLoop('the loop stops when n reaches 0')).toBe(false);
  });

  it('scrub drops only the claiming sentences', () => {
    const out = scrubInfiniteClaims(
      'Not quite — the loop runs forever because n never leaves 1. The total is 1 + 2 + 3 = 6. What does it print?',
    );
    expect(out).not.toContain('forever');
    expect(out).toContain('The total is 1 + 2 + 3 = 6.');
    expect(out).toContain('What does it print?');
  });

  it('falls back to an honest re-engage when everything was the claim', () => {
    expect(scrubInfiniteClaims('The loop runs forever.')).toContain('trace your loop');
  });
});

describe('contradictsVerdict (fine-tune trace)', () => {
  it('flags the live self-contradiction: false verdict, cleanly affirming evidence', () => {
    expect(contradictsVerdict('Student wrote "if mouse click…" — a valid if/elif/else chain, so the ordering is correct.')).toBe(true);
  });

  it('does NOT flag genuinely negative or hedged evidence', () => {
    expect(contradictsVerdict('Student only answered "I didnt understand" — they never gave an example.')).toBe(false);
    expect(contradictsVerdict('wrong; the full code was never written')).toBe(false);
    expect(contradictsVerdict('partially right but incomplete')).toBe(false);
    expect(contradictsVerdict('no demonstration yet')).toBe(false);
  });
});

describe('isConfusion (fine-tune trace)', () => {
  it('flags confusion statements without a question mark', () => {
    expect(isConfusion('I didnt understand your question')).toBe(true);
    expect(isConfusion("i don't get it")).toBe(true);
    expect(isConfusion("I'm not sure, honestly")).toBe(true);
    expect(isConfusion('no idea')).toBe(true);
    expect(isConfusion('im so confused')).toBe(true);
  });

  it('does NOT flag real answers', () => {
    expect(isConfusion('the loop stops when the condition is false')).toBe(false);
    expect(isConfusion('counter = 0')).toBe(false);
    expect(isConfusion('I understand now')).toBe(false);
  });
});

describe('mentionsOtherLanguage (planning-time drift, harness iter2)', () => {
  it('flags a foreign language named in a Python lesson', () => {
    expect(mentionsOtherLanguage('Explain what `is` does in JavaScript', 'Python')).toBe(true);
    expect(mentionsOtherLanguage('Compare it with the Java equals method', 'Python')).toBe(true);
  });

  it('passes Python content, and passes everything when the lesson language is unknown', () => {
    expect(mentionsOtherLanguage('Use `is` for identity in Python', 'Python')).toBe(false);
    expect(mentionsOtherLanguage('Explain what `is` does in JavaScript', '')).toBe(false);
  });
});

describe('talksAboutStudent (assessor-voice leak, harness iter1)', () => {
  it('flags third-person replies observed live', () => {
    expect(talksAboutStudent('The same pattern is still in place, and the student hasn\'t rewritten it.')).toBe(true);
    expect(talksAboutStudent('Not quite — the loop is exactly the same as before, and the student is just echoing it again.')).toBe(true);
  });

  it('passes normal second-person tutoring', () => {
    expect(talksAboutStudent('Not quite — you kept the same code. Can you rewrite it for hours instead?')).toBe(false);
  });
});

describe('isClarifyingQuestion (help vs guess, harness iter1)', () => {
  it('protects help-seeking questions', () => {
    expect(isClarifyingQuestion('what do u mean?')).toBe(true);
    expect(isClarifyingQuestion('in what expression?')).toBe(true);
    expect(isClarifyingQuestion('can you explain that again?')).toBe(true);
    expect(isClarifyingQuestion('understood?')).toBe(true);
  });

  it('a guess phrased as a question is an ATTEMPT, not a clarification', () => {
    expect(isClarifyingQuestion('is it 7?')).toBe(false);
    expect(isClarifyingQuestion('maybe the else runs first?')).toBe(false);
    expect(isClarifyingQuestion('does it print 5?')).toBe(false);
  });
});

describe('code-production floor (decision-tables trace)', () => {
  it('requiresCodeProduction: production verb + code noun', () => {
    expect(requiresCodeProduction('Translate a 3-5 row decision table into clear `if/elif/else` code.')).toBe(true);
    expect(requiresCodeProduction('Write a while loop to repeat actions until a condition changes.')).toBe(true);
    expect(requiresCodeProduction('create a for loop that iterates over the range from 0 to stop-1')).toBe(true);
    // elif trace: this matched NEITHER list, so the tutor asked an evaluate question for a
    // refactoring milestone and the student's correct answer could never count.
    expect(requiresCodeProduction('Refactor a nested `if/else` into an equivalent `if/elif/else` chain.')).toBe(true);
    expect(requiresCodeProduction('Rewrite the branches as one flat chain')).toBe(true);
  });

  it('requiresCodeProduction: conceptual milestones stay ungated', () => {
    expect(requiresCodeProduction('Compute the result of `True` and `False` in a boolean expression')).toBe(false);
    expect(requiresCodeProduction('Identify and list all possible conditions')).toBe(false);
    expect(requiresCodeProduction('Explain when a while loop ends.')).toBe(false);
    expect(requiresCodeProduction('Prevent infinite loops.')).toBe(false); // code noun, no production verb
    expect(requiresCodeProduction('Order conditions to avoid overlaps and unreachable branches.')).toBe(false); // `branch`, no verb
  });

  it('containsCodeSignal: the live prose answers are not code', () => {
    expect(containsCodeSignal('stay home')).toBe(false);
    expect(containsCodeSignal('time if the year')).toBe(false); // one keyword alone is prose
    expect(containsCodeSignal('rules of times like 7 days in week 365 in a year etc')).toBe(false);
  });

  it('containsCodeSignal: real code (or naming two constructs) counts', () => {
    expect(containsCodeSignal('if sunny: stay_home()')).toBe(true);
    expect(containsCodeSignal('total = total + 2')).toBe(true);
    expect(containsCodeSignal('`for i in range(3)`')).toBe(true);
    expect(containsCodeSignal('i would use if and elif branches')).toBe(true); // two constructs named
  });
});

describe('detectDistress (SWE/BIZ-09)', () => {
  it('detects distress cues', () => {
    expect(detectDistress("I've been stuck on this for 2 hours")).toBe(true);
    expect(detectDistress('honestly I feel so behind everyone else')).toBe(true);
    expect(detectDistress('this is too hard, I want to quit')).toBe(true);
    expect(detectDistress("I'm so frustrated with this")).toBe(true);
  });

  it('ignores neutral messages', () => {
    expect(detectDistress('the loop stops when the condition is false')).toBe(false);
    expect(detectDistress('can we move on to the next part?')).toBe(false);
  });
});

describe('detectPreferredName (SWE/BIZ-10)', () => {
  it('extracts stated name preferences, normalized', () => {
    expect(detectPreferredName('call me Liz, not Elizabeth')).toBe('Liz');
    expect(detectPreferredName('my name is matt by the way')).toBe('Matt');
    expect(detectPreferredName('I go by Sam')).toBe('Sam');
    expect(detectPreferredName('I prefer to be called Ana')).toBe('Ana');
  });

  it('ignores non-name phrases', () => {
    expect(detectPreferredName('call me back later')).toBeNull();
    expect(detectPreferredName('call me when the loop ends')).toBeNull();
    expect(detectPreferredName('the answer is 42')).toBeNull();
  });
});
