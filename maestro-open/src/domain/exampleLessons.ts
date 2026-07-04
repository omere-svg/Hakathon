// Loads the Maestro course-reference markdown (Week 3 — Decisions and Loops) and turns each
// lesson's Mastery Outcomes into a LessonBrief. This lets us test the milestone engine across
// the whole week's lessons — not just the while-loop one — by picking a random lesson per load.
//
// We only need the goal STATEMENTS (the milestone engine's input), so this is a light markdown
// parse, not the full authored KC schema. The reference file is VENDORED into src/content/ so
// the repo builds standalone (the original lives in the maestro-pocket-hackathon-knowledge-base
// sibling repo — re-copy it if the shared reference changes).

import type { LessonBrief, MasteryGoal } from '../engine/api';
import raw from '../content/example-maestro-lesson-structure.md?raw';

const PROGRAM = 'Masterschool Fellowship';
const COURSE = 'Week 3 — Decisions and Loops';

/** Keep the text verbatim (only trim). Backticks around code tokens like `in` / `not in` /
 *  `and` are meaningful — dropping them changes the meaning — so we preserve them. */
function clean(s: string): string {
  return s.trim();
}

/** Parse the "# Lessons" region into one LessonBrief per lesson that has mastery outcomes. */
function parseLessons(md: string): LessonBrief[] {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#\s+Lessons\s*$/.test(l));
  const afterStart = lines.slice(start + 1);
  const endRel = afterStart.findIndex((l) => /^#\s+Review Questions\s*$/.test(l));
  const region = start < 0 ? lines : afterStart.slice(0, endRel < 0 ? afterStart.length : endRel);

  const briefs: LessonBrief[] = [];
  let cur: { num: string; title: string; outcomes: string[] } | null = null;
  let inOutcomes = false;

  const flush = () => {
    const c = cur;
    if (c && c.outcomes.length) {
      const goals: MasteryGoal[] = c.outcomes.map((o, i) => ({ id: `g${i + 1}`, statement: o }));
      briefs.push({
        id: `w3-l${c.num}`,
        title: c.title,
        program: PROGRAM,
        course: COURSE,
        topic: c.title,
        language: 'Python', // the whole Week 3 course is Python
        goals,
      });
    }
    cur = null;
    inOutcomes = false;
  };

  for (const line of region) {
    const header = line.match(/^##\s+(\d+)\.\s+(.*)$/);
    if (header) {
      flush();
      cur = { num: header[1], title: clean(header[2]), outcomes: [] };
      continue;
    }
    if (!cur) continue;
    if (/^###\s+Mastery Outcomes/i.test(line)) {
      inOutcomes = true;
      continue;
    }
    if (/^###\s+/.test(line)) {
      inOutcomes = false; // a different subsection (Tutor Instructions / Plugins / Lesson Type)
      continue;
    }
    if (inOutcomes) {
      const bullet = line.match(/^\s*-\s+(.*)$/);
      if (bullet) cur.outcomes.push(clean(bullet[1]));
    }
  }
  flush();
  // Challenge/Review lessons aren't concept-teaching lessons — their "outcomes" are meta
  // (e.g. "answered six challenge questions"), which the tutor can't teach. Keep only real
  // concept lessons so every random pick is something the milestone engine can actually teach.
  return briefs.filter((b) => !/^(challenge|review)\b/i.test(b.title));
}

// Safety fallback so the lesson page never dead-ends if the reference file can't be parsed.
const FALLBACK: LessonBrief = {
  id: 'w3-l8',
  title: 'Meet the while loop',
  program: PROGRAM,
  course: COURSE,
  topic: 'while loops',
  language: 'Python',
  goals: [
    { id: 'g1', statement: 'Understand what a while loop is and when it is more suitable than for.' },
    { id: 'g2', statement: 'Understand the risk of infinite loops and explain how to prevent them.' },
    { id: 'g3', statement: 'Write a while loop to repeat actions until a condition changes.' },
  ],
};

export const exampleLessonBriefs: LessonBrief[] = (() => {
  const parsed = parseLessons(raw);
  return parsed.length ? parsed : [FALLBACK];
})();

/** Pick a random lesson from the course reference (a fresh one each page load). */
export function pickRandomExampleBrief(): LessonBrief {
  const list = exampleLessonBriefs;
  return list[Math.floor(Math.random() * list.length)];
}

/** Look up a specific lesson (the dev-mode lesson picker); undefined if the id is unknown. */
export function getExampleBriefById(id: string): LessonBrief | undefined {
  return exampleLessonBriefs.find((b) => b.id === id);
}
