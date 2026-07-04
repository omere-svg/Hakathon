# Week 3 Course Context — Decisions and Loops

This file is a cleaned and structured version of a copied Maestro/LMS page. It should be used as a reference for how Maestro course/lesson content is organized.

## Course Summary

- **Week:** Week 3
- **Number of lessons:** 12
- **Theme:** Decisions and loops
- **Primary language/topic:** Python control flow
- **Main plugin used:** Code Editor

## Why this file matters for the hackathon

This is an example of Maestro/LMS lesson structure. The hackathon brief asks us to use Maestro's existing lesson format instead of inventing a totally new content model. Use this file to understand the shape of a course:

- A week contains multiple lessons.
- Each lesson has a title.
- Each lesson has mastery outcomes.
- Some lessons use plugins, usually the Code Editor.
- Some lessons may have tutor instructions, but in this export they are mostly missing.
- The review lesson contains multiple-choice questions with correct answers and points.

---

# Lessons

## 1. If/else: syntax, indentation, mental model

### Mastery Outcomes

- Introduce indentation as Python's rule for defining code blocks.
- Write a basic `if/else` using comparison operators: `==`, `!=`, `<`, `>`, `<=`, `>=`.
- Differentiate assignment `=` from equality `==` in conditions.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 2. Logical operators: `and` / `or` / `not` and short-circuiting

### Mastery Outcomes

- Combine comparisons with `and`, `or`, and `not` to form compound conditions.
- Show short-circuit behavior by adding prints to the right-hand side expression.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 3. Booleans and comparisons: equality vs identity

### Mastery Outcomes

- Use `True` and `False` in expressions and store boolean results in variables.
- Differentiate between `==` value equality and `is` identity equality.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 4. String membership with `in` in conditions

### Mastery Outcomes

- Test substring membership with `in` and negate with `not in`.
- Use membership checks inside `if/elif` branches to drive simple decisions.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 5. `elif` and refactoring nested decisions

### Mastery Outcomes

- Refactor a nested `if/else` into an equivalent `if/elif/else` chain.
- Order conditions to avoid overlaps and unreachable branches.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 6. Decision tables to branching logic

### Mastery Outcomes

- Translate a 3-5 row decision table into clear `if/elif/else` code.
- Verify mutual exclusivity and completeness of the conditions.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 7. For loops and `range()`: counting iterations

### Mastery Outcomes

- Write `for` loops with `range(stop)`, `range(start, stop)`, and `range(start, stop, step)`.
- Accumulate a total across iterations and print the result.
- Generate even/odd sequences and countdowns with `range`.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 8. Meet the `while` loop

### Mastery Outcomes

- Understand what a `while` loop is and when it is more suitable than `for`.
- Understand the risk of infinite loops and explain how to prevent them.
- Write a `while` loop to repeat actions until a condition changes.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 9. Loop control: `break` and `continue`

### Mastery Outcomes

- Understand when to exit a loop early with `break` versus letting it complete naturally.
- Insert `break` to exit early on a condition.
- Insert `continue` to skip an iteration.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 10. Counters and totals

### Mastery Outcomes

- Initialize and update a counter and running total correctly inside a loop.
- Print the final counts and totals after the loop completes.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 11. Challenge: functions, decisions and loops

### Mastery Outcomes

- Student has answered six challenge questions.

### Tutor Instructions

No tutor instructions were added yet.

### Plugins

- Code Editor

---

## 12. Review: decisions and loops

### Lesson Type

Weekly Review

### Tutor Instructions

No tutor instructions were added yet.

---

# Review Questions

## Question 1

**Question:** What does this condition check?

```python
if "@" in email:
    print("Looks like an email address")
```

**Options:**

1. If `email` is a list
2. If `email` starts with `@`
3. If the character `@` appears anywhere inside the string stored in `email`
4. If email is equal to `@`

**Correct answer:** 3

**Points:** 10

---

## Question 2

**Question:** What does `break` do inside a loop?

**Options:**

1. Skips the current iteration and continues with the next
2. Restarts the loop from the top
3. Stops the loop immediately and continues after the loop
4. Makes the loop infinite

**Correct answer:** 3

**Points:** 10

---

## Question 3

**Question:** What is the value of `result` after this code runs?

```python
is_member = True
has_coupon = False
result = is_member and not has_coupon
```

**Options:**

1. `True`
2. `False`
3. `TrueFalse`
4. It causes an error

**Correct answer:** 1

**Points:** 10

---

## Question 4

**Question:** Which statement is correct about `==` and `is` in Python?

**Options:**

1. `==` compares values, `is` compares whether two variables point to the same object in memory
2. `==` is faster so you should always use it
3. `is` compares values, `==` compares types
4. They always behave exactly the same

**Correct answer:** 1

**Points:** 10

---

## Question 5

**Question:** What is the main problem in this code?

```python
count = 0
while count < 5:
    print("Hi")
```

**Options:**

1. A `while` loop will not run unless it includes an explicit `break`
2. The condition is wrong
3. `count` is never updated, so the loop never ends
4. `while` loops cannot print

**Correct answer:** 3

**Points:** 10

---

## Question 6

**Question:** You design an XP system for an adventure game. XP increases differently depending on player level:

```python
def gain_xp(level):
    if level < 3:
        return 10
    if level < 5:
        return 5
    return 2

xp = 0
level = 1
while level <= 5:
    xp += gain_xp(level)
    level += 1
    if xp > 20:
        break

print(xp)
```

**Options:**

1. `17`
2. `break`
3. `25`
4. It crashes

**Correct answer:** 3

**Points:** 10

---

## Question 7

**Question:** Consider this function with an early return:

```python
def classify(score):
    if score < 0:
        return "invalid"
    if score >= 90:
        return "A"
    return "other"
```

What does `classify(95)` return?

**Options:**

1. `invalid`
2. `A`
3. `other`
4. It crashes

**Correct answer:** 2

**Points:** 10

---

## Question 8

**Question:** A game counts how many odd levels you passed. What does it print?

```python
count = 0
for n in range(1, 6):
    if n % 2 == 0:
        continue
    count += 1

print(count)
```

**Options:**

1. `2`
2. `3`
3. `4`
4. `5`

**Correct answer:** 2

**Points:** 10

---

## Question 9

**Question:** A program keeps asking the user to type something until they type `stop`.

```python
count = 0
word = ""
while word != "stop":
    word = input("Type a word (or stop): ")
    if word != "stop":
        count += 1

print(count)
```

The user types these inputs in order: `hi`, `cat`, `stop`.

**Options:**

1. `1`
2. `2`
3. `3`
4. It causes an error

**Correct answer:** 2

**Points:** 10

---

## Question 10

**Question:** What is printed?

```python
age = 20
is_member = False
allowed = age >= 18 and is_member
print(allowed)
```

**Options:**

1. `True`
2. `False`
3. `20`
4. It causes an error

**Correct answer:** 2

**Points:** 10

---

# Missing Fields / Notes

## Tutor Instructions

The original copied page says that no tutor instructions were added yet. It also mentions that the editor can add a `tutorInstructions` field for the tutor agent, either as a flat tutor field or a tutor node.

## Exam Grading Instructions

The original copied page says no `examGradingInstructions` were added yet.

## Videos / Images

The copied content listed video and image sections, but no actual videos or images were included.

---

# Suggested Use for Claude

When Claude reads this file, it should understand this as a reference example for Maestro/LMS course structure, not as the final app content.

Claude should extract from it:

1. Course/week metadata
2. Lesson list
3. Mastery outcomes per lesson
4. Plugin usage
5. Review question structure
6. Correct answer marking
7. Missing tutor instructions as an opportunity for the new product

This file can help design the `sampleCourse.json`, `sampleLesson.json`, and the lesson engine schema for Maestro Pocket.
