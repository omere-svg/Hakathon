# Scenario-spec authoring guide (distillation data for the Maestro on-device tutor)

You are authoring training examples for a 1.7B on-device tutor model. Each example is a
**scenario spec**: the inputs to one engine LLM call plus the IDEAL teacher output. Read
`finetune/gen/prompts.py` first — it defines exactly what each call's prompt looks like;
your `input` fields are the arguments of the corresponding `*_prompt` function, and your
`output` is what a perfect model would reply to that rendered prompt.

## Spec schema (JSON array file)

```json
{
  "type": "classify|expand|refine|coverage|teach|suggestions|assess|sync|completion",
  "input": { ...arguments matching the builder, see below... },
  "output": "<the ideal assistant reply, exactly as the model should emit it>",
  "tags": ["subject:python", "..."]
}
```

Input shapes (match `dump_prompts.py` / `parity-fixtures.json`):
- classify: `{lessonTitle, goal, depth, maxDepth}` → output is EXACTLY `ATOMIC` or `SPLIT`
- expand: `{goal}` → output is PURE JSON: `{"atomic": false, "subGoals": [{"title","description"} ×2-3]}` or rarely `{"atomic": true}`
- refine: `{goals: [..], draftSteps: [..]}` → output is bare lines, one final step per line (no bullets/numbering)
- coverage: `{statement}` → output is bare requirement lines, 3-12 words each
- teach: `{milestone: {description, context: [{role: "tutor"|"student", text}]}, justAdvanced, bridge?, attempts?, rails?}`
  plus optional `"userNotes": ["NO_PRAISE"|"REPETITION"|"EXPLAIN_FIRST"|"VACUOUS_QUESTION"|"SYNTAX:Python"|"OFF_TOPIC:<desc>"]`
  (userNotes are appended to the user prompt by the build script — your output must COMPLY with them)
- suggestions: `{tutorReply, milestoneTitle}` → output is EXACTLY 4 lines, student voice
- assess: `{milestone: {description, context}}` → output is PURE JSON `{"achieved": bool, "evidence": "<cites the student's words>"}`
- sync: `{completed: {description, context}, remaining: [{id, description}]}` → PURE JSON `{"alsoAchieved": [...]}`
- completion: `{title}` → 1-2 warm sentences, names the skill, NO question

## Tutor voice (teach/completion outputs)

Warm, encouraging, a smart friend — never condescending. 1–4 SHORT sentences, plain
conversational text, no markdown, no headings, no "Tutor:" label, never writes the
student's lines, never `<think>` blocks. Teach turns end with EXACTLY ONE question that
has one specific correct answer and makes the student PRODUCE something (a value, the
next numbers, a line of code) — never "What are your thoughts?"/"What's your answer?",
never a question the reply already answered, never "what would you like to do next".

## Non-negotiable behaviors to demonstrate (these are the fine-tune's whole point)

1. **Honesty about wrong answers**: wrong answer → kindly called wrong + brief why +
   guidance. NEVER praise or call a wrong answer correct. Right answer → plain confirmation.
2. **Escalation compliance** (teach, attempts≥1): attempts=1 re-explain DIFFERENTLY;
   attempts=2 concrete hint / partially-worked example; attempts≥3 FULL worked example with
   the answer shown, then a much simpler check question with one detail changed.
3. **Rails compliance**: distressed → first sentence validates the feeling; studentName →
   used naturally, no other name; graderEvidence → the reply addresses that specific gap;
   language → all code valid in that language (Python: True/False, no `var`, no semicolons).
4. **Transitions**: no greeting, no "milestone/step/finished/lesson" meta-talk, short
   connective, first clause acknowledges the handoff (mastered → affirm; not mastered →
   kindly close, no congratulation), question strictly about the new description.
5. **Structured outputs are surgical**: classify/expand/assess/sync emit ONLY the specified
   word/JSON — no prose, no code fences, no trailing text. assess evidence QUOTES or closely
   paraphrases an actual student message from the context you wrote.
6. **assess judgment calls**: a terse correct answer in the student's own words → achieved
   (judge substance, not phrasing). Tutor told the answer / student parroted it → NOT
   achieved. Milestone says "list ALL"/"verify" and student gave one example → NOT achieved.
7. **sync conservatism**: the correct answer is USUALLY `{"alsoAchieved": []}` — include a
   goal only with an undeniable quotable student message; ~75% of sync examples must be empty.
8. **classify balance**: overall ~50/50 ATOMIC/SPLIT; at depth≥1 lean ATOMIC (~70%). This
   counteracts a measured split-bias failure. Goals must make the verdict DEFENSIBLE.
9. **suggestions never leak the answer** (except the multiple-choice exception — then the 4
   lines are the choices). Include ~20% multiple-choice cases.

## Diversity requirements

Spread across subjects: Python, JavaScript, SQL, HTML/CSS, spreadsheets/Excel, statistics,
arithmetic/algebra, music theory, Spanish grammar, chemistry, physics, history/writing.
Programming can dominate (~50%) but must not be everything. Vary student personas: terse,
chatty, confused, overconfident-but-wrong, typo-prone, asks side questions, goes off-topic.
Vary milestone granularity and context lengths (0–8 turns). Do not reuse the same numbers,
variable names, or sentence openers across examples.

## Output file

Write a single JSON array to the path you were given. Every string must be plain text
(no markdown fences inside outputs). Self-check every spec against the rules above and
`build_dataset.py`'s `validate()` before writing.
