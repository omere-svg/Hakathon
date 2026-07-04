"""Faithful Python port of maestro-open/src/engine/milestone/prompts.ts.

Every (system, user) pair produced here must match, byte-for-byte, what the
running engine sends to the on-device model — otherwise we train the model on
inputs it will never actually see. The only addition is the ` /no_think` suffix
that quirks.ts appends to the system message at runtime (thinking=false default).

Parity is ENFORCED, not hoped for: scripts/dump_prompts.py and
maestro-open/scripts/dumpPrompts.ts render the same fixtures through both
implementations and scripts/parity_check.py diffs them. Run it after any change
to prompts.ts.
"""

import re

CONTEXT_WINDOW = 8
NO_THINK = " /no_think"  # quirks.ts systemSuffix() when thinking flag is false (the default)

PERSONA = (
    "You are Maestro, a warm, encouraging tutor — a smart friend, not a lecturer. "
    "Reply in 1–4 short sentences of plain conversational text (no headings, no markdown). "
    "When teaching, end with exactly one question. Never be condescending."
)


def sys(content: str) -> str:
    """Apply the runtime system suffix exactly as webllm.ts does."""
    return content + NO_THINK


def render_context(context):
    recent = context[-CONTEXT_WINDOW:]
    if not recent:
        return "(no messages yet)"
    return "\n".join(
        f"{'Tutor' if m['role'] == 'tutor' else 'Student'}: {m['text']}" for m in recent
    )


# ── rails.ts port (only what prompts.ts consumes) ────────────────────────────
PRODUCTION_VERB = re.compile(
    r"\b(?:writ(?:e|ing)|translat(?:e|ing)|implement(?:ing)?|creat(?:e|ing)|build(?:ing)?|convert(?:ing)?|refactor(?:ing)?|rewrit(?:e|ing)|rework(?:ing)?)\b",
    re.IGNORECASE,
)
CODE_NOUN = re.compile(
    r"\b(?:code|program|function|loop|statement|script|snippet|chain|branch)(?:es|s)?\b",
    re.IGNORECASE,
)


def requires_code_production(milestone: str) -> bool:
    return bool(PRODUCTION_VERB.search(milestone)) and bool(CODE_NOUN.search(milestone))


# ── 1. Decomposition step 1 (classify) — one-word ATOMIC/SPLIT judgment ──────
def classify_prompt(lesson_title, goal, depth, max_depth):
    system = "\n".join([
        "You are a curriculum planner reviewing ONE learning goal for a tutoring lesson.",
        "Judge its size honestly — both answers are equally common:",
        "  • ATOMIC — one focused idea a student can be taught and checked on in a single",
        "    short tutoring exchange (about 3-5 minutes).",
        "  • SPLIT — it clearly bundles several distinct ideas or skills that must be",
        "    taught one at a time.",
        "",
        "Reply with exactly ONE WORD: ATOMIC or SPLIT. No other text.",
    ])
    user = "\n".join([
        f"Lesson context: {lesson_title}",
        f"Goal to judge: {goal}",
        f"(Recursion depth {depth} of max {max_depth} — the deeper the goal, the more likely it is already atomic.)",
        "",
        "One word — ATOMIC or SPLIT:",
    ])
    return system, user


# ── 1. Decomposition step 2 (expand) — only for goals judged SPLIT ───────────
def expand_prompt(goal):
    system = "\n".join([
        "You are a curriculum planner doing RECURSIVE decomposition. You are given ONE learning goal",
        "that is too big for a single tutoring turn. Split it into 2 or 3 smaller, strictly ORDERED",
        "sub-goals, each a prerequisite step toward the parent and each clearly smaller than it. Return",
        '    {"atomic": false, "subGoals": [',
        '      {"title": "<3-6 words>", "description": "<what to demonstrate>"},',
        '      {"title": "<3-6 words>", "description": "<what to demonstrate>"}',
        "    ]}",
        "",
        "RULES:",
        '- "subGoals" MUST contain 2 or 3 items. An array with fewer than 2 items is INVALID.',
        "- ONE sub-goal is never a split — that is just rephrasing the goal.",
        "- A sub-goal must NOT restate the parent goal in other words — each must be a strictly",
        "  smaller piece of it.",
        '- Each "description" must be understandable ON ITS OWN: always NAME the specific thing',
        '  it concerns instead of writing "the variable", "the value", or "it".',
        "- Use ONLY the keys shown above. Respond with ONLY the JSON object, no prose.",
        "- Only if the goal truly CANNOT be split into 2 genuinely smaller steps, return",
        '  {"atomic": true} instead.',
    ])
    user = "\n".join([f"Goal to split: {goal}", "", "Split this goal now. Return the JSON."])
    return system, user


# ── 1b. Consolidation (refine) — per goal ────────────────────────────────────
def refine_prompt(goals, draft_steps):
    system = "\n".join([
        "You are finalizing a lesson plan for a tutor — ONE goal at a time. You are given the GOAL",
        "and a rough, auto-generated list of teaching STEPS for it, often redundant or out of order.",
        "Produce the FINAL ordered list of steps that:",
        "- MERGES duplicate or near-duplicate steps into ONE (never repeat the same idea),",
        "- REMOVES steps not needed to reach the goal,",
        "- is ORDERED by dependency (teach prerequisites first),",
        "- keeps each step a single, teachable, checkable idea,",
        "- makes each step understandable ON ITS OWN — every step must NAME what it operates on,",
        '  never a bare "the variable", "the value", or "it",',
        "- ADDS a step ONLY if some part of the goal is taught by NO draft step.",
        "NEVER add generic practice, review, or recap steps — practice happens inside each step.",
        "A single goal usually needs 1-4 steps; fewer is better than padded.",
        "Output ONE step per line — no numbering, no bullets, no quotes, no extra text.",
    ])
    user = "\n".join([
        "Lesson goals:",
        "\n".join(f"{i + 1}. {g}" for i, g in enumerate(goals)),
        "",
        "Rough draft steps (clean these up — merge, drop, reorder):",
        "\n".join(f"- {s}" for s in draft_steps),
        "",
        "Write the final ordered steps now, one per line.",
    ])
    return system, user


# ── 1c. Coverage audit — enumerate requirements, one goal per call ───────────
def coverage_prompt(goal_statement):
    system = "\n".join([
        "You are auditing ONE lesson goal for COVERAGE. Your ONLY job is to enumerate what the",
        "goal requires — deciding what is already covered happens elsewhere.",
        "List every distinct thing this goal explicitly requires the student to be able to DO.",
        "Each requirement: ONE line, 3-12 words, self-contained, reusing the goal's own words.",
        "Do NOT invent requirements the goal does not state. Do NOT give teaching advice.",
        "Output ONLY the requirement lines, one per line — no numbering, no bullets, no other text.",
    ])
    user = "\n".join([f"Goal: {goal_statement}", "", "List the requirements now, one per line."])
    return system, user


# ── 2a. Teaching ─────────────────────────────────────────────────────────────
def escalation_note(attempts):
    if attempts >= 3:
        return (
            "The student has tried this idea several times without getting it. STOP asking them to produce "
            "the answer. Walk through ONE complete worked example step by step — show the answer and why it "
            "works — then ask a much simpler check question (change one small detail of your example)."
        )
    if attempts >= 2:
        return (
            "The student has now missed this idea more than once. Do NOT repeat the same explanation. Give a "
            "concrete hint that removes one step of the difficulty, or a partially-worked example they only "
            "have to finish."
        )
    if attempts >= 1:
        return (
            "The student missed this on their first try. Re-explain it a DIFFERENT way than before — a new "
            "angle or a small concrete example — do not repeat your previous wording."
        )
    return ""


NO_PRAISE_NOTE = (
    "\n\nIMPORTANT: The student's latest answer was NOT correct. Do NOT call it correct, right, or "
    "praise it in any way. Kindly and clearly point out that it is not right, explain briefly why, "
    "and guide them toward the correct idea."
)

REPETITION_NOTE = (
    "\n\nIMPORTANT: Your previous draft repeated what you already told the student — do NOT re-ask "
    "a question you already asked and do NOT reuse your earlier example or wording. Say something "
    "genuinely NEW: a different concrete example with different numbers, or a different angle on the same idea."
)

EXPLAIN_FIRST_NOTE = (
    "\n\nIMPORTANT: Your previous draft was only questions — it explained nothing. First EXPLAIN "
    "the idea in a sentence or two, or SHOW one small worked example including its answer. "
    "Only THEN end with one question — about a DIFFERENT case than the example you just answered "
    '(change one number), never a filler like "What\'s your answer?".'
)

VACUOUS_QUESTION_NOTE = (
    "\n\nIMPORTANT: Your previous draft ended with a filler question that has no checkable answer "
    '(like "What\'s your answer?" or "What are your thoughts?") — and everything before it was '
    "already answered, so the student has nothing to say. Rewrite it: keep the explanation, then "
    "end with ONE specific question about a DIFFERENT case (change one number) whose answer is a "
    "value, a sequence of numbers, or a line of code you have NOT already stated."
)


FALSE_INFINITE_NOTE = (
    "\n\nIMPORTANT: The student's loop DOES terminate — its variable changes every pass until the "
    "condition fails. Do NOT call it infinite or say it runs forever. Judge the code they actually "
    "wrote, and ask one specific question about what it prints."
)

SECOND_PERSON_NOTE = (
    '\n\nIMPORTANT: You are talking TO the student. Address them directly as "you" — never refer '
    'to "the student" in the third person.'
)


def syntax_note(language):
    return (
        f"\n\nIMPORTANT: Your previous draft contained code that is NOT valid {language}. Rewrite "
        f"your reply so every piece of code is valid {language} — do not use keywords or punctuation "
        "from any other programming language."
    )


def off_topic_note(description):
    return (
        "\n\nIMPORTANT: Your previous draft asked about a DIFFERENT topic. Your reply — and your "
        f"question — MUST be about exactly this: {description}. Do not bring up any other topic."
    )


def teach_prompt(milestone, just_advanced, bridge=None, attempts=0, rails=None):
    """milestone: {"description": str, "context": [{"role","text"}]}
    bridge: {"completedTitle", "lastStudentMessage", "mastered"} | None
    rails: {"studentName", "distressed", "graderEvidence", "lessonTopic", "language"} | None
    """
    rails = rails or {}
    is_opening = len(milestone["context"]) == 0
    lesson_start = is_opening and not just_advanced
    transition = is_opening and just_advanced

    production = requires_code_production(milestone["description"])

    lesson_lang_line = ""
    if rails.get("lessonTopic") or rails.get("language"):
        parts = []
        if rails.get("lessonTopic"):
            parts.append(f"LESSON: {rails['lessonTopic']}.")
        if rails.get("language"):
            lang = rails["language"]
            python_hint = (
                " (booleans are True/False, no var/let/const, no trailing semicolons)"
                if re.match(r"^python", lang, re.IGNORECASE)
                else ""
            )
            parts.append(
                f"ALL code must be valid {lang}{python_hint} — never another language's syntax."
            )
        lesson_lang_line = " ".join(parts)

    system_lines = [
        PERSONA,
        "",
        "You are teaching ONE focused idea — stay strictly on it, no drifting to other topics.",
        'Write ONLY your own next message, in plain prose — no "Tutor:" label, and NEVER write the student\'s lines.',
        'BE HONEST: a wrong answer is called wrong, kindly, with a brief why — never say "correct" or praise a wrong answer. A right answer is confirmed plainly. A question from the student gets answered first.',
        "End with ONE question that has ONE specific correct answer and makes the student PRODUCE something — a value, the next numbers, or a line of code — not answer by repeating your words back. Never ask the student what they would like to do next.",
        'Never answer your own question: after a worked example, ask about a DIFFERENT case (change one number) — no filler like "What\'s your answer?" or "What are your thoughts?".',
        lesson_lang_line,
        (
            "This milestone needs REAL code: INVENT a tiny concrete example of the source material (a few rows or values in plain text), SHOW it, and ask the student to write the code for it — never teach this skill in the abstract."
            if production
            else ""
        ),
        (
            'This is a CONTINUATION of one ongoing conversation: Do NOT greet, and NEVER mention lessons, milestones, steps, or anything being "finished". Flow into the next idea with a short connective ("Now,") and ask one question.'
            if transition
            else ""
        ),
        (
            "This is mid-conversation — do NOT greet the student. If their latest message is COMPLETELY unrelated to the lesson, kindly say you can't help with that here and ask one question that returns to the lesson; otherwise answer it normally. Never mention this rule."
            if (not lesson_start and not transition)
            else ""
        ),
        escalation_note(attempts),
        (
            "IMPORTANT: The student sounds frustrated or discouraged. Your FIRST sentence must acknowledge "
            "and validate how they feel — do not dismiss it or jump straight to the material. Only then, "
            "gently continue with one small, confidence-building step."
            if rails.get("distressed")
            else ""
        ),
        (
            f"The student's preferred name is {rails['studentName']}. Use it naturally when addressing them, and "
            "NEVER call them by any other name."
            if rails.get("studentName")
            else ""
        ),
        "",
        f"CURRENT FOCUS — the student should be able to: {milestone['description']}",
    ]
    # JS .filter(Boolean) drops '' — but note the two literal '' spacer lines are ALSO
    # dropped by it in the TS source, so we replicate exactly: filter falsy, join '\n'.
    system = "\n".join(l for l in system_lines if l)

    last = next(
        (m["text"] for m in reversed(milestone["context"]) if m["role"] == "student"), ""
    )
    if lesson_start:
        user = "This is the very start of the lesson. Greet the student warmly in one short sentence, then introduce this idea and ask one question."
    elif transition:
        handoff = ""
        if bridge:
            handoff_lines = [
                "Handoff from the previous part of this conversation (for a natural transition — do NOT re-teach it):",
                (
                    f"- The student just correctly worked through: {bridge['completedTitle']}."
                    if bridge["mastered"]
                    else f"- You just walked the student through: {bridge['completedTitle']}. They found it hard — do NOT congratulate them on it."
                ),
                (
                    f"- Their last message was: \"{bridge['lastStudentMessage']}\""
                    if bridge["lastStudentMessage"]
                    else ""
                ),
                (
                    "In your FIRST clause, briefly acknowledge/affirm that (you may confirm they were right), then continue."
                    if bridge["mastered"]
                    else "In your FIRST clause, briefly and kindly close that topic (e.g. note they can revisit it), then continue."
                ),
            ]
            handoff = "\n".join(l for l in handoff_lines if l)
        user_parts = [
            handoff,
            "Continue naturally into this next idea — no greeting, no mention of milestones or steps. Introduce it in a sentence or two and ask one question.",
            f"Your introduction and your question MUST be about exactly this, and nothing else: {milestone['description']}",
        ]
        user = "\n\n".join(p for p in user_parts if p)
    else:
        user_parts = [
            "Conversation so far on this idea (for your reference only):",
            '"""',
            render_context(milestone["context"]),
            '"""',
            f"The student's latest message was: \"{last}\"" if last else "",
            (
                'The student asked for clarification — they were NOT wrong about anything. Do not say "Not quite" or correct them. Re-explain the idea more simply, with one tiny concrete example, then ask one easy question.'
                if rails.get("clarifying")
                else (
                    f'An assessor judged that the student has not yet demonstrated the idea. Assessor\'s note: "{rails["graderEvidence"]}". Address this specific gap in your reply.'
                    if rails.get("graderEvidence")
                    else ""
                )
            ),
            "Now write your next tutor reply — your message only, ending with one question.",
        ]
        user = "\n".join(p for p in user_parts if p)
    return system, user


# ── 2a'. Quick-reply suggestions ─────────────────────────────────────────────
def suggestions_prompt(tutor_reply, milestone_title):
    system = "\n".join([
        "You write 4 short quick-reply buttons a STUDENT could tap to respond to their tutor.",
        "Output EXACTLY 4 options, ONE PER LINE, first-person, natural and casual, under 10 words.",
        "No numbering, no bullets, no quotes, no extra text — just the 4 lines.",
        "",
        "IMPORTANT: do NOT give away the answer to the tutor's question — the student is still learning,",
        "and buttons that hand over the answer defeat the point. Instead make the options sound like a",
        "real learner: ask what a term means, ask to re-explain a concept, offer a tentative/partial",
        "guess, admit confusion, or ask to move on. Never state the full correct answer.",
        "",
        "EXCEPTION — multiple-choice: if the tutor asked a multiple-choice question (it lists options",
        'like "A) … B) … C) …" or "is it X or Y?"), then output those answer choices as the 4 lines',
        "(one may be the correct one) — here the student is meant to pick one.",
        "",
        'Example — open question ("What do you think a loop does?"):',
        'What exactly do you mean by "loop"?',
        "Can you explain that again?",
        "Maybe it repeats something?",
        "I'm not sure, honestly",
    ])
    user = "\n".join([
        f"(You are helping the student learn: {milestone_title}.)",
        f'The tutor just said: "{tutor_reply}"',
        "",
        "Write the 4 student replies now, one per line.",
    ])
    return system, user


# ── 2b. Focused assessment ───────────────────────────────────────────────────
def assess_prompt(milestone):
    system = "\n".join([
        "You are a strict grader. Judge ONLY whether the student has demonstrated this single",
        "milestone in the conversation below. Do not consider anything outside it. Require real",
        "evidence from the student (their own words/answer) — being told the answer is not enough.",
        "A correct answer in the student's own words counts as evidence — even a short one, and",
        "even if it does not use the milestone's wording. Judge the substance, not the phrasing.",
        "But scope still matters: if the milestone asks to list ALL of something, or to VERIFY",
        "something, a single example or a vague mention is not sufficient evidence.",
        "",
        "Respond with ONLY this JSON, no prose:",
        '{ "achieved": true|false, "evidence": "<short reason citing the student\'s words>" }',
    ])
    user = "\n".join([
        f"MILESTONE: {milestone['description']}",
        f"Achieved means the student can: {milestone['description']}",
        "",
        "Conversation (this milestone only):",
        render_context(milestone["context"]),
        "",
        "Is this milestone achieved? Return the JSON now.",
    ])
    return system, user


# ── 3. Milestone sync ────────────────────────────────────────────────────────
def sync_prompt(completed, remaining):
    """completed: {"description", "context"}; remaining: [{"id", "description"}]"""
    system = "\n".join([
        "You are auditing a learning plan, STRICTLY. One learning goal was just completed. For EACH",
        "remaining goal, decide whether the STUDENT has ALREADY personally demonstrated it — in their",
        "OWN words or answers — within the conversation below.",
        "",
        "Rules (false positives are harmful — be conservative):",
        "- Count a goal ONLY if a specific STUDENT message clearly shows the student themselves did",
        "  exactly what that goal describes.",
        "- The tutor explaining something, or a topic merely being mentioned, does NOT count.",
        "- A different or loosely-related topic does NOT count. If unsure, EXCLUDE it.",
        "- Usually the correct answer is NONE. Only include a goal with undeniable student evidence.",
        "",
        "Respond with ONLY this JSON, no prose:",
        '{ "alsoAchieved": [ { "id": "<remaining goal id>", "evidence": "<quote/paraphrase of the exact STUDENT message that proves it>" } ] }',
        'Use { "alsoAchieved": [] } if none. If you cannot quote a student message that proves a goal, EXCLUDE it. Never invent evidence.',
    ])
    recent = completed["context"][-CONTEXT_WINDOW * 2 :]
    convo = "\n".join(
        f"{'Tutor' if m['role'] == 'tutor' else 'Student'}: {m['text']}" for m in recent
    ) or "(none)"
    user = "\n".join([
        f"Just-completed goal: {completed['description']}",
        "",
        "Conversation (ONLY the student's own messages count as evidence):",
        convo,
        "",
        "Remaining goals to audit:",
        "\n".join(f"- {m['id']}: {m['description']}" for m in remaining),
        "",
        "For each remaining goal, include it ONLY if a specific student message already proves it. Return the JSON now.",
    ])
    return system, user


# ── 4. Completion ────────────────────────────────────────────────────────────
def completion_prompt(brief_title, progress=None):
    """progress: {"total": int, "struggled": int} | None — struggled > 0 selects the
    honest no-mastery-claim variant (mirrors completionPrompt in prompts.ts)."""
    system = PERSONA
    if progress and progress.get("struggled", 0) > 0:
        user = (
            f'The student finished "{brief_title}" but found {progress["struggled"]} of its '
            f'{progress["total"]} ideas genuinely difficult and has not yet mastered them. In 1–2 '
            "sentences: warmly credit the effort, say plainly that some ideas need another pass, "
            "and encourage revisiting. Do NOT claim mastery. No question."
        )
    else:
        user = (
            f'The student has achieved every milestone of "{brief_title}". Congratulate them warmly '
            "in 1–2 sentences and name what they can now do. Do not ask a question."
        )
    return system, user
