// MilestoneEngine — a standalone, model-driven tutoring engine implementing TutorEngine.
//
// The algorithm (Goal-Oriented Milestone Flow):
//   Decomposition (init): the local model breaks the lesson goal into a strictly ordered
//     MilestoneQueue.
//   Milestone Loop: for the current milestone, with STRICT context isolation (the model
//     sees only this milestone's messages):
//       Focused Assessment — "is THIS milestone achieved?"
//       Execution — if no, keep teaching this milestone; if yes, trigger the Sync.
//   Milestone Sync (cleanup): the completed milestone's transcript + the remaining list go
//     to the model, which cross-checks which remaining milestones were implicitly achieved.
//     The engine updates the queue, clears context, and advances.
//
// The model owns the pedagogy, but two thin deterministic rails guard the places a small
// model predictably fails (see the knowledge base's small-llm-performance-playbook):
//   - arithmetic: every numeric claim in a tutor reply is re-computed (math.ts) — a 1-2B
//     model WILL eventually botch 17 // 5 live;
//   - impasse: failed assessments escalate the scaffold (hint → worked example) and a hard
//     cap force-advances so a student is never trapped repeating one milestone forever.

import type { EngineDebug, LessonBrief, LlmCall, PlanStep, Suggestions, TurnView, TutorEngine } from '../api';
import type { GenOptions, LLMEngine } from '../../llm/types';
import { MilestoneQueue, type Milestone, type QueueSnapshot } from './types';
import { extractJson, parseAchieved, parseStringList } from './json';
import {
  correctArithmetic,
  correctListClaims,
  correctMembership,
  findUnreachableBranch,
  simpleLoopTerminates,
  type MathCorrection,
} from './math';
import {
  claimsInfiniteLoop,
  containsCodeSignal,
  containsUnqualifiedPraise,
  contradictsVerdict,
  detectDistress,
  detectPreferredName,
  isAcknowledgment,
  isAllQuestions,
  isClarifyingQuestion,
  isConfusion,
  isVacuousQuestion,
  looksLikeNonPythonCode,
  questionSentences,
  requiresCodeProduction,
  scrubInfiniteClaims,
  scrubPraise,
  talksAboutStudent,
} from './rails';
import {
  codeTokens,
  contentWords,
  NEAR_DUPLICATE,
  sharesContent,
  STALE_REPLY,
  stemmedJaccard,
  stemmedOverlapRatio,
} from './overlap';
import {
  assessPrompt,
  completionPrompt,
  CONTRADICTION_NUDGE,
  EXPLAIN_FIRST_NOTE,
  FALSE_INFINITE_NOTE,
  NO_PRAISE_NOTE,
  offTopicNote,
  REPETITION_NOTE,
  SECOND_PERSON_NOTE,
  suggestionsPrompt,
  syntaxNote,
  teachPrompt,
  VACUOUS_QUESTION_NOTE,
  type MilestoneBridge,
  type TeachRails,
} from './prompts';
import { decomposeRecursive } from './decompose';

/** Failed assessments before the engine force-advances past a stuck milestone. The student
 *  has by then seen: a re-explanation, a concrete hint, and a full worked example. */
export const MAX_ATTEMPTS = 4;

/** Grading/JSON phases run low-temperature — but NEVER 0: Qwen3 forbids greedy decoding
 *  (degenerate/repetitive output). 0.3/0.8 is the near-deterministic floor per the research
 *  in knowledge base 05-research/temperature-per-scenario.md.
 *  maxTokens bounds fine-tune degeneration loops (a repeated-line loop ran ~10s live);
 *  a correct assess verdict is well under 100 tokens, so healthy output never clips. */
const GRADER_OPTS: GenOptions = { temperature: 0.3, topP: 0.8, maxTokens: 200 };
/** Compliance retries (the model ignored a format/content instruction): sharpen toward
 *  the instruction without going greedy. */
const RETRY_OPTS: GenOptions = { temperature: 0.3, topP: 0.8 };

/** Appended to the user prompt on the single retry after an unparseable JSON reply. */
const JSON_NUDGE = '\n\nIMPORTANT: Respond with ONLY the JSON object — no prose, no explanation, no code fences.';

/** Strip role-play bleed: small models sometimes echo a "Tutor:" label and then continue the
 *  whole dialogue for both sides ("… Student: … Teacher: …"). Keep only the tutor's first turn.
 *  Exported for tests. */
export function cleanReply(text: string): string {
  let t = text.trim();
  // Drop a leading self-label the model sometimes emits.
  t = t.replace(/^\s*(tutor|teacher|maestro|assistant)\s*(\([^)]*\))?\s*:\s*/i, '');
  // Cut at the first fabricated turn marker (the model impersonating another speaker).
  const m = t.match(/\b(student|teacher|tutor|user|assistant)\s*(\([^)]*\))?\s*:/i);
  if (m && m.index !== undefined && m.index > 0) t = t.slice(0, m.index);
  t = t.trim();
  // An UNMATCHED wrapping quote is an artifact (the model closing a quotation it never
  // opened — observed live: `…how it works?"`). Balanced quotes are content; only an odd
  // count loses its edge quote.
  if (((t.match(/"/g) ?? []).length & 1) === 1) {
    if (t.endsWith('"')) t = t.slice(0, -1);
    else if (t.startsWith('"')) t = t.slice(1);
  }
  // STUTTER scrub: the model sometimes says the same sentence twice back-to-back
  // (observed live: "…so `salsa` does not contain `al`, and `salsa` does contain `s`.
  // So `salsa` does not contain `al`, and `salsa` does contain `s`."). Drop a sentence
  // that duplicates the previous one — exactly, or as its tail after a connective.
  const sentences = t.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  const norm = (x: string): string => x.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const sentence of sentences) {
    const cur = norm(sentence);
    const prev = kept.length ? norm(kept[kept.length - 1]) : '';
    if (cur && cur === prev) continue;
    const core = cur.replace(/^(?:so|and|but|now|then)[,\s]+/, '');
    if (core.length >= 20 && prev.endsWith(core)) continue;
    kept.push(sentence);
  }
  t = kept.join(' ');
  return t.trim();
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

/** Plain-data snapshot of the engine (for localStorage session persistence). */
export interface MilestoneEngineSnapshot {
  v: 1;
  queue: QueueSnapshot;
  planNote: string;
  /** cross-milestone student preferences (e.g. preferred name) — must survive a reload. */
  prefs?: { name?: string };
  /** milestones force-advanced past the impasse cap — the completion message must not
   *  claim mastery of them. */
  impasses?: number;
}

function isSnapshot(x: unknown): x is MilestoneEngineSnapshot {
  const s = x as MilestoneEngineSnapshot | null;
  return !!s && s.v === 1 && !!s.queue && Array.isArray(s.queue.items) && s.queue.items.length > 0;
}

export class MilestoneEngine implements TutorEngine {
  readonly id = 'milestone';
  readonly name = 'Milestone Engine';

  private queue: MilestoneQueue | null = null;
  private lastEvidence = '';
  private planNote = '';
  private suggestSource: 'dynamic' | 'none' = 'none';
  private lastMathFix: MathCorrection[] = [];
  private lastRails: string[] = [];
  /** milestones force-advanced without mastery — completion must stay honest about them. */
  private impasses = 0;
  /** Cross-milestone student preferences. Context isolation deliberately discards each
   *  milestone's transcript — a stated name preference must NOT die with it (SWE/BIZ-10). */
  private prefs: { name?: string } = {};
  /** every model call made during the CURRENT turn (reset each start/respond), for the dev panel. */
  private turnCalls: LlmCall[] = [];

  constructor(private readonly brief: LessonBrief, private readonly llm: LLMEngine, snapshot?: unknown) {
    if (isSnapshot(snapshot)) {
      this.queue = MilestoneQueue.restore(snapshot.queue);
      this.planNote = snapshot.planNote || 'restored session';
      this.prefs = { ...snapshot.prefs };
      this.impasses = snapshot.impasses ?? 0;
    }
  }

  /** Snapshot for persistence — everything needed to resume mid-lesson after a reload. */
  serialize(): MilestoneEngineSnapshot | null {
    if (!this.queue) return null;
    return {
      v: 1,
      queue: this.queue.snapshot(),
      planNote: this.planNote,
      prefs: { ...this.prefs },
      impasses: this.impasses,
    };
  }

  /** Dev-panel state on demand (no turn run) — after a restore this carries the plan steps,
   *  but never calls: the per-turn LLM call log is not persisted. */
  debugView(): EngineDebug {
    return this.debug();
  }

  /** One model call, recorded (label + prompt + response + latency) for the dev "LLM calls" panel. */
  private async call(label: string, system: string, user: string, opts?: GenOptions): Promise<string> {
    const t0 = now();
    const response = await this.llm.complete(system, user, opts);
    this.turnCalls.push({ label, system, user, response, ms: now() - t0 });
    return response;
  }

  async start(): Promise<TurnView> {
    this.requireModel();
    this.turnCalls = [];
    if (!this.queue) {
      const milestones = await this.decompose();
      this.queue = new MilestoneQueue(milestones);
    }
    if (this.queue.isComplete()) return this.view('This lesson is complete — great work!', true);
    const reply = await this.teach(this.queue.current()!, false);
    return this.view(reply, false);
  }

  async respond(message: string): Promise<TurnView> {
    this.requireModel();
    this.turnCalls = [];
    // Restart path (e.g. a failed init): decompose now but KEEP the student's message —
    // it must flow into this turn, not be silently dropped.
    if (!this.queue) {
      const milestones = await this.decompose();
      this.queue = new MilestoneQueue(milestones);
    }
    if (this.queue.isComplete()) return this.view('This lesson is complete — great work!', true);

    const current = this.queue.current()!;
    const text = message.trim();
    this.lastRails = [];
    let distressed = false;
    if (text) {
      current.context.push({ role: 'student', text });
      // Deterministic rails on the STUDENT message (rails.ts) — cheap, run every turn.
      const name = detectPreferredName(text);
      if (name) {
        this.prefs.name = name;
        this.lastRails.push(`name→${name}`);
      }
      distressed = detectDistress(text);
      if (distressed) this.lastRails.push('distress');
      // TRUST-THE-STUDENT rail (product ruling 2026-07-04): a pure acknowledgment
      // ("understood", "ok got it") after the tutor has taught means the milestone is
      // achieved — deterministically, WITHOUT asking the grader. The grader was observed
      // flipping its verdict on identical evidence with a bare "understood" as tiebreaker;
      // now the rule is consistent by construction.
      if (!distressed && isAcknowledgment(text) && current.context.some((t) => t.role === 'tutor')) {
        this.lastRails.push('trust-ack');
        this.lastEvidence = 'student said they understood — trusted by rule';
        return this.advanceFrom(current, /* mastered */ true);
      }
    }

    // Focused assessment: is ONLY this milestone achieved?
    let assessment = await this.assess(current);
    // CODE FLOOR (approved 2026-07-04): a milestone that demands PRODUCING code cannot be
    // achieved without the student ever typing any — the grader passed "stay home" for
    // "Translate a decision table into `if/elif/else` code" live. Deterministic, grader-
    // proof; the trust-ack rail above is deliberately NOT gated (standing product ruling).
    if (assessment.achieved && requiresCodeProduction(current.description)) {
      const hasCode = current.context.some((m) => m.role === 'student' && containsCodeSignal(m.text));
      if (!hasCode) {
        assessment = {
          achieved: false,
          evidence: 'this milestone requires producing code — the student has not written any yet',
        };
        this.lastRails.push('code-floor');
      }
    }
    // FALSE-INFINITE guard: a rejection justified by "runs forever" about student code
    // that PROVABLY terminates is a hallucinated premise — treat the turn as neutral
    // (verdict stands, but no wrong-answer framing), same handling as a contradiction.
    if (!assessment.achieved && claimsInfiniteLoop(assessment.evidence)) {
      const code = [...current.context].reverse().find((m) => m.role === 'student')?.text ?? '';
      if (simpleLoopTerminates(code) === true) {
        assessment = { ...assessment, contradictory: true };
        this.lastRails.push('false-infinite');
      }
    }
    this.lastEvidence = assessment.evidence;

    if (!assessment.achieved) {
      // A distress message ("I've been stuck for 2 hours") is not a failed ATTEMPT —
      // counting it would fire the "you missed this" escalation at someone who only vented.
      // Neither is a CLARIFYING message — a help-seeking question ("what do u mean?") or a
      // confusion statement without one ("I didnt understand your question"). A GUESS
      // phrased as a question ("is it 7?") IS an attempt — shielding every trailing-'?'
      // let a flailing student take ~10 turns to reach the impasse cap (harness iter1).
      // A CONTRADICTORY grade (verdict false, evidence says correct) is neutral too: the
      // verdict stands but cannot justify "your answer was wrong".
      const isClarifying = isClarifyingQuestion(text) || isConfusion(text);
      if (assessment.contradictory) this.lastRails.push('assess-contradiction');
      if (!distressed && !isClarifying && !assessment.contradictory) {
        current.attempts = (current.attempts ?? 0) + 1;
      } else if (isClarifying && text) {
        this.lastRails.push('question-not-attempt');
      }
      if ((current.attempts ?? 0) < MAX_ATTEMPTS) {
        // Execution: keep teaching this milestone (isolated context), escalating the
        // scaffold as attempts accumulate (re-explain → hint → worked example).
        const reply = await this.teach(current, false, undefined, {
          distressed,
          // Praise-guard only when there was a real, non-distress WRONG answer — a
          // clarifying message or a self-contradicted grade is not one.
          studentWasWrong: !!text && !distressed && !isClarifying && !assessment.contradictory,
          // A clarifying turn gets a re-explain framing instead of the assessor's gap
          // note — "not demonstrated" framing made the tutor say "Not quite" to a
          // student who asked for help (observed live).
          clarifying: !!text && isClarifying && !distressed,
          // Let the re-teach target the assessor's stated gap instead of blindly
          // rephrasing — but never feed it a self-contradicted evidence line.
          graderEvidence:
            text && !distressed && !isClarifying && !assessment.contradictory ? assessment.evidence : undefined,
        });
        return this.view(reply, false);
      }
      // Impasse cap: the student has seen the full scaffold ladder and is still stuck.
      // Move on rather than trap them — honestly (the bridge says NOT to congratulate).
      this.lastEvidence = `not demonstrated after ${current.attempts} attempts — advancing past the impasse`;
      return this.advanceFrom(current, /* mastered */ false);
    }

    // Achieved → Milestone Sync, then advance.
    return this.advanceFrom(current, /* mastered */ true);
  }

  /** Shared advance path: mark, cross-check (sync), advance, and teach the next milestone
   *  (or close the lesson). `mastered` distinguishes a real achievement from an impasse cap. */
  private async advanceFrom(current: Milestone, mastered: boolean): Promise<TurnView> {
    this.queue!.achieveCurrent();
    if (mastered) await this.sync(current); // an impasse produced no new student evidence
    else this.impasses++;
    this.queue!.advance();

    if (this.queue!.isComplete()) {
      const reply = await this.complete();
      return this.view(reply, true);
    }
    // Hand a minimal bridge from the just-completed milestone to the next one so the
    // transition reads as one continuous conversation (see teachPrompt / MilestoneBridge).
    const reply = await this.teach(this.queue!.current()!, true, this.bridgeFrom(current, mastered));
    return this.view(reply, false);
  }

  /** Compress the just-completed milestone into a tiny handoff: its topic + the student's last
   *  message. Deliberately minimal — enough for continuity, not enough to pollute the new context.
   *  The DESCRIPTION, not the UI title — the ellipsized title ("…range from 0 to st…") was
   *  leaking into the transition prompt. */
  private bridgeFrom(completed: Milestone, mastered: boolean): MilestoneBridge {
    const lastStudent = [...completed.context].reverse().find((m) => m.role === 'student')?.text ?? '';
    return { completedTitle: completed.description, lastStudentMessage: lastStudent.slice(0, 200), mastered };
  }

  // ── phases ────────────────────────────────────────────────────────────────────

  /** Decomposition (recursive): split each goal into micro-milestones and flatten the leaves.
   *  Falls back to the brief's own ordered goals if recursion yields nothing usable — the
   *  goals are already an ordered curriculum, so we never dead-end. */
  private async decompose(): Promise<Milestone[]> {
    try {
      const { milestones, stats, calls } = await decomposeRecursive(this.brief, this.llm);
      this.turnCalls.push(...calls); // surface decompose/refine calls in the dev panel
      if (milestones.length) {
        this.planNote =
          `recursive · ${stats.rawLeaves}→${stats.leaves} steps${stats.refined ? ' (refined)' : ''}` +
          `${stats.appended ? ` · +${stats.appended} coverage` : ''} · ` +
          `depth ${stats.maxDepthReached} · ${stats.calls} calls`;
        return milestones;
      }
    } catch {
      /* fall through to goal fallback */
    }
    this.planNote = 'goal fallback (recursion unavailable)';
    return this.goalFallback();
  }

  private goalFallback(): Milestone[] {
    const goals = this.brief.goals.length
      ? this.brief.goals
      : [{ id: 'm1', statement: this.brief.title, reference: undefined }];
    return goals.map((g, i) => ({
      id: g.id || `m${i + 1}`,
      title: g.statement.slice(0, 48),
      description: g.reference ? `${g.statement} (${g.reference})` : g.statement,
      status: 'pending' as const,
      context: [],
    }));
  }

  /** Execution: draft one teaching turn for the milestone and record it in its context.
   *  Rails on the way out: role-play scrubbing, the no-false-praise guard (regenerate once,
   *  then deterministic scrub), and the arithmetic corrector. */
  private async teach(
    milestone: Milestone,
    justAdvanced: boolean,
    bridge?: MilestoneBridge,
    turn?: { distressed?: boolean; studentWasWrong?: boolean; graderEvidence?: string; clarifying?: boolean },
  ): Promise<string> {
    const rails: TeachRails = {
      studentName: this.prefs.name,
      distressed: turn?.distressed,
      graderEvidence: turn?.graderEvidence,
      clarifying: turn?.clarifying,
      lessonTopic: this.brief.topic || this.brief.title,
      language: this.brief.language,
    };
    const p = teachPrompt(milestone, justAdvanced, bridge, milestone.attempts ?? 0, rails);
    let reply = cleanReply(await this.call('teach', p.system, p.user));
    if (!reply) {
      // A generation truncated mid-<think> strips to '' — one low-temperature re-ask, then an
      // honest fallback rather than an empty bubble.
      reply = cleanReply(await this.call('teach:retry', p.system, p.user, RETRY_OPTS));
    }
    if (!reply) reply = `Let's keep going with ${milestone.title}. Can you tell me what you understand so far?`;

    // ON-TOPIC rail for transition turns: a fresh milestone's opening question drifting to
    // another topic makes the NEXT assessment grade the student against the wrong idea
    // (observed live: "components of a while loop" opened with a while-vs-for question).
    // Two checks, regenerate once with an explicit note, then accept:
    //  - zero shared content words with the milestone = total drift;
    //  - the milestone names a CODE TOKEN (`break`) and the intro never mentions it —
    //    a `break` milestone taught as generic while-loops shares the word "loop" and
    //    slipped the first check (reported live). Short/stopword-ish tokens (`in`) are
    //    exempt: prose naturally drops them.
    const focusWords = new Set<string>();
    for (const t of codeTokens(milestone.description)) {
      for (const w of t.toLowerCase().split(/[^a-z0-9_]+/)) if (w.length >= 3) focusWords.add(w);
    }
    const replyWords = contentWords(reply);
    const mentionsFocus = !focusWords.size || [...focusWords].some((w) => replyWords.has(w));
    if (justAdvanced && (!sharesContent(reply, `${milestone.title} ${milestone.description}`) || !mentionsFocus)) {
      const regen = cleanReply(
        await this.call('teach:on-topic', p.system, p.user + offTopicNote(milestone.description), RETRY_OPTS),
      );
      if (regen) reply = regen;
      this.lastRails.push('on-topic');
    }

    // SWE/BIZ-01 rail: the assessor just judged this answer WRONG — sycophancy is the #1
    // small-model failure, so an unqualified "correct!/well done" must never ship. One
    // regeneration with an explicit note; if the model still praises, scrub deterministically.
    if (turn?.studentWasWrong && containsUnqualifiedPraise(reply)) {
      const regen = cleanReply(await this.call('teach:no-praise', p.system, p.user + NO_PRAISE_NOTE, RETRY_OPTS));
      reply = regen && !containsUnqualifiedPraise(regen) ? regen : scrubPraise(regen || reply);
      this.lastRails.push('no-praise');
    }

    // REPETITION rail: a re-teach that mirrors the previous tutor message teaches nothing —
    // observed live: the attempts-2 "hint" restated the student's own correct sequence and
    // re-asked a question the tutor itself had answered two turns earlier, looping the
    // student until the impasse cap. Two tiers:
    //   message tier — stemmed similarity vs the LAST tutor message (whole reply rehash);
    //   question tier — the draft's QUESTION sentences vs every question already asked this
    //     milestone. The booleans trace asked the same question 3×: whole-message scores
    //     stayed at 0.47–0.53 (filler diluted them) while the question itself was verbatim.
    // One regeneration with the be-new note, then accept. Runs AFTER the praise guard (a
    // praise regen is new content by construction), and its own regen keeps the
    // no-false-praise guarantee via the deterministic scrub. Transitions never fire it —
    // a fresh milestone's context has no prior tutor message.
    const priorTutorTexts = milestone.context.filter((m) => m.role === 'tutor').map((m) => m.text);
    const lastTutor = priorTutorTexts[priorTutorTexts.length - 1];
    const priorQuestions = priorTutorTexts.flatMap(questionSentences);
    const repeatsMessage = !!lastTutor && stemmedJaccard(reply, lastTutor) >= STALE_REPLY;
    const repeatsQuestion = questionSentences(reply).some((q) =>
      priorQuestions.some((pq) => stemmedJaccard(q, pq) >= NEAR_DUPLICATE),
    );
    if (repeatsMessage || repeatsQuestion) {
      const regen = cleanReply(await this.call('teach:repetition', p.system, p.user + REPETITION_NOTE, RETRY_OPTS));
      if (regen) {
        reply = turn?.studentWasWrong && containsUnqualifiedPraise(regen) ? scrubPraise(regen) : regen;
      }
      this.lastRails.push('repetition');
    }

    // EXPLAIN-FIRST rail: on a re-teach turn (the student just missed or asked), a reply
    // where EVERY sentence is a question explains nothing — observed live: the attempts-3
    // "worked example" turn was one question, no example, no answer. Regen once, then accept.
    const isReteach = milestone.context.some((m) => m.role === 'student');
    if (isReteach && isAllQuestions(reply)) {
      const regen = cleanReply(
        await this.call('teach:explain-first', p.system, p.user + EXPLAIN_FIRST_NOTE, RETRY_OPTS),
      );
      if (regen) {
        reply = turn?.studentWasWrong && containsUnqualifiedPraise(regen) ? scrubPraise(regen) : regen;
      }
      this.lastRails.push('explain-first');
    }

    // VACUOUS-QUESTION rail: the model answers its own quiz question ("…if stop was 5?
    // The numbers would be 0, 1, 2, 3, 4.") and then — forced to end with a question —
    // appends a stub with no checkable answer ("What's your answer?", "What's your take
    // on that?", the opening "What's your first thought?"). The student has nothing left
    // to say. The stubs are a small closed set → deterministic check on the reply's LAST
    // question; regen once with a be-specific note, then accept.
    const finalQuestion = questionSentences(reply).pop();
    if (finalQuestion && isVacuousQuestion(finalQuestion)) {
      const regen = cleanReply(
        await this.call('teach:vacuous-question', p.system, p.user + VACUOUS_QUESTION_NOTE, RETRY_OPTS),
      );
      if (regen) {
        reply = turn?.studentWasWrong && containsUnqualifiedPraise(regen) ? scrubPraise(regen) : regen;
      }
      this.lastRails.push('vacuous-question');
    }

    // SECOND-PERSON rail: the model copies assessor-note register into student-facing
    // replies ("the student hasn't rewritten it" — said TO the student, twice in six
    // harness conversations). Regen once, then accept.
    if (talksAboutStudent(reply)) {
      const regen = cleanReply(
        await this.call('teach:second-person', p.system, p.user + SECOND_PERSON_NOTE, RETRY_OPTS),
      );
      if (regen) {
        reply = turn?.studentWasWrong && containsUnqualifiedPraise(regen) ? scrubPraise(regen) : regen;
      }
      this.lastRails.push('second-person');
    }

    // LANGUAGE rail (Python lessons): the model wrote `var result = True;` — JS keyword +
    // semicolon + Python boolean, valid in no language. Prompt pinning is the first
    // defense; this catches what slips through. Regen once, then accept.
    if (rails.language && /^python/i.test(rails.language) && looksLikeNonPythonCode(reply)) {
      const regen = cleanReply(
        await this.call('teach:syntax', p.system, p.user + syntaxNote(rails.language), RETRY_OPTS),
      );
      if (regen) {
        reply = turn?.studentWasWrong && containsUnqualifiedPraise(regen) ? scrubPraise(regen) : regen;
      }
      this.lastRails.push('syntax');
    }

    // FALSE-INFINITE rail: three separate traces called a provably terminating counter
    // loop "infinite"/"runs forever". When the student's code matches the simulatable
    // shape and terminates, a reply claiming otherwise is regenerated once.
    const lastStudentCode = [...milestone.context].reverse().find((m) => m.role === 'student')?.text ?? '';
    if (claimsInfiniteLoop(reply) && simpleLoopTerminates(lastStudentCode) === true) {
      const regen = cleanReply(
        await this.call('teach:false-infinite', p.system, p.user + FALSE_INFINITE_NOTE, RETRY_OPTS),
      );
      if (regen) {
        reply = turn?.studentWasWrong && containsUnqualifiedPraise(regen) ? scrubPraise(regen) : regen;
      }
      // The model is stubbornly attached to the phrase (observed live: the regen
      // re-asserted "runs forever") — deterministic scrub as the last resort.
      if (claimsInfiniteLoop(reply)) reply = scrubInfiniteClaims(reply);
      this.lastRails.push('false-infinite');
    }

    const fixed = correctArithmetic(reply);
    // CLAIM rails — the arithmetic rail's siblings: "`salsa` does not contain `al`"
    // (it does) and "a slice of [1,2,3,4,5] from 2 to 3 gives [2, 3]" (it gives [3])
    // are as computable as "17 // 5 = 4". Verified and fixed in place.
    const membership = correctMembership(fixed.text);
    const lists = correctListClaims(membership.text);
    const corrections = [...fixed.corrections, ...membership.corrections, ...lists.corrections];
    if (corrections.length) this.lastMathFix = corrections;
    if (membership.corrections.length) this.lastRails.push('membership');
    if (lists.corrections.length) this.lastRails.push('list-claims');
    reply = lists.text;
    milestone.context.push({ role: 'tutor', text: reply });
    return reply;
  }

  /** Focused assessment of a single milestone from its isolated context. Near-deterministic
   *  (GRADER_OPTS) with ONE retry when the reply has no recoverable JSON — the fallback
   *  heuristic only ever sees the retry's output.
   *  CONTRADICTION guard (fine-tune trace): a false verdict whose evidence argues the
   *  answer was CORRECT is re-asked once; if it stays contradictory, the verdict stands
   *  (never auto-advance on a hallucinatable evidence line) but is flagged `contradictory`
   *  so respond() treats the turn as NEUTRAL — no attempt burned, no "your answer was
   *  wrong" framing forced onto a possibly-right student. */
  private async assess(
    milestone: Milestone,
  ): Promise<{ achieved: boolean; evidence: string; contradictory?: boolean }> {
    // Nothing to grade until the student has actually said something this milestone.
    const hasStudentTurn = milestone.context.some((m) => m.role === 'student');
    if (!hasStudentTurn) return { achieved: false, evidence: 'no student input yet' };
    try {
      const p = assessPrompt(milestone);
      const raw = await this.call('assess', p.system, p.user, GRADER_OPTS);
      let result: { achieved: boolean; evidence: string };
      if (extractJson(raw) !== null) {
        result = parseAchieved(raw);
      } else {
        const retry = await this.call('assess:retry', p.system, p.user + JSON_NUDGE, GRADER_OPTS);
        result = parseAchieved(retry);
      }
      if (!result.achieved && contradictsVerdict(result.evidence)) {
        const raw2 = await this.call('assess:contradiction', p.system, p.user + CONTRADICTION_NUDGE, GRADER_OPTS);
        const retried = extractJson(raw2) !== null ? parseAchieved(raw2) : null;
        if (retried && !(!retried.achieved && contradictsVerdict(retried.evidence))) return retried;
        return { ...result, contradictory: true };
      }
      // UNREACHABLE-BRANCH floor (iter6): a wrong-order threshold chain (`>= 80` before
      // `>= 90`) was accepted by the grader AND sync-credited. The shape is computable —
      // an achieved verdict over code with a provably dead branch is overturned with a
      // precise, grounded reason (which then drives the honest re-teach).
      if (result.achieved) {
        const lastStudent = [...milestone.context].reverse().find((m) => m.role === 'student')?.text ?? '';
        const dead = findUnreachableBranch(lastStudent);
        if (dead) {
          this.lastRails.push('unreachable-branch');
          return { achieved: false, evidence: `the condition order hides a bug: ${dead}` };
        }
      }
      return result;
    } catch {
      return { achieved: false, evidence: 'assessment failed; continuing to teach' };
    }
  }

  /** Milestone Sync v2: cross-check remaining milestones for implicit achievement.
   *  The old design — ONE multi-goal audit call — never fired: across every recorded
   *  trace and a controlled probe with undeniable evidence, the model answered
   *  {"alsoAchieved":[]} (its conservatism prompt worked too well). The single-milestone
   *  grader, meanwhile, is the best-performing judgment call we have. So: deterministic
   *  candidate gating (skip the model entirely on the common no-candidate case), then the
   *  PROVEN assess prompt per candidate, capped at 2, with the code floor re-applied. */
  private async sync(completed: Milestone): Promise<void> {
    const remaining = this.queue!.remaining();
    if (!remaining.length) return;
    const studentText = completed.context
      .filter((m) => m.role === 'student')
      .map((m) => m.text)
      .join('\n');
    if (!studentText) return;
    const candidates = remaining
      .map((m) => ({ m, score: stemmedOverlapRatio(m.description, studentText) }))
      .filter((c) => c.score > 0 && sharesContent(c.m.description, studentText))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    for (const { m } of candidates) {
      try {
        const verdict = await this.assess({ ...m, context: completed.context });
        if (!verdict.achieved || verdict.contradictory) continue;
        // Same floor as the main loop: a code-production milestone needs actual code.
        if (requiresCodeProduction(m.description) && !containsCodeSignal(studentText)) continue;
        this.queue!.markAchieved([m.id]);
      } catch {
        /* conservative: on failure, mark nothing extra achieved */
      }
    }
  }

  private async complete(): Promise<string> {
    try {
      const p = completionPrompt(this.brief, { total: this.queue!.size(), struggled: this.impasses });
      return cleanReply(await this.call('complete', p.system, p.user));
    } catch {
      return this.impasses > 0
        ? `That's the end of "${this.brief.title}" — some of it was tough going, and revisiting those parts will really help.`
        : `You've completed every milestone of "${this.brief.title}" — great work!`;
    }
  }

  // ── view / debug ────────────────────────────────────────────────────────────────

  private view(reply: string, done: boolean): TurnView {
    const q = this.queue;
    const status = q
      ? `Milestone ${q.position()}/${q.size()}${done ? ' · complete' : ` · ${q.current()?.status ?? 'done'}`}`
      : 'Initializing…';
    // Chips are cosmetic and cost a full model call — the reply must NEVER wait on them.
    // The promise settles after the view is already rendered; it never rejects.
    const suggestions = done ? undefined : this.suggestReplies(reply).catch(() => undefined);
    return { reply, done, status, suggestions, debug: this.debug() };
  }

  /** Dynamic quick replies: after the tutor's reply, ask the model for 4 plausible student
   *  responses so the chips track the conversation. Product ruling 2026-07-04: 3 usable
   *  options are enough to show (the old all-or-nothing rule silently ate chips on flaky
   *  turns); fewer than 3 → NO chips (never canned fallbacks). */
  private async suggestReplies(reply: string): Promise<Suggestions | undefined> {
    // Description, not the UI title — the ellipsized title was leaking "…from 0 to st…"
    // into the suggestions prompt.
    const title = this.queue?.current()?.description ?? this.brief.title;
    try {
      const p = suggestionsPrompt(reply, title);
      const raw = await this.call('suggestions', p.system, p.user);
      // Dedupe while preserving order.
      const seen = new Set<string>();
      const opts = parseStringList(raw)
        .filter((t) => {
          const k = t.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 4);
      if (opts.length >= 3) {
        this.suggestSource = 'dynamic';
        // Show the full suggestion — the chips are full-width and wrap; don't truncate.
        return { quick: opts.map((t) => ({ label: t, text: t })) };
      }
    } catch {
      /* no chips on failure */
    }
    this.suggestSource = 'none';
    return undefined;
  }

  private debug(): EngineDebug {
    const q = this.queue;
    const fields = [
      { label: 'engine', value: 'milestone (model-driven + arithmetic/impasse rails)' },
      { label: 'plan', value: this.planNote || '—' },
      { label: 'milestone', value: q ? `${q.position()}/${q.size()}` : '—' },
      { label: 'current', value: q?.current()?.title ?? '—' },
      { label: 'attempts', value: String(q?.current()?.attempts ?? 0) },
      { label: 'suggestions', value: this.suggestSource },
    ];
    if (this.lastEvidence) fields.push({ label: 'last assessment', value: this.lastEvidence });
    if (this.lastRails.length) fields.push({ label: 'rails fired', value: this.lastRails.join(', ') });
    if (this.prefs.name) fields.push({ label: 'student name', value: this.prefs.name });
    if (this.lastMathFix.length) {
      fields.push({
        label: 'math rail',
        value: this.lastMathFix.map((c) => `${c.expr} = ${c.stated} → ${c.actual}`).join('; '),
      });
    }
    // The recursive decomposition, as an ordered plan for the dev panel.
    const steps: PlanStep[] | undefined = q
      ?.all()
      .map((m) => ({
        label: m.title,
        state: m.status === 'achieved' ? 'done' : m.status === 'active' ? 'active' : 'pending',
      }));
    return { engine: this.name, fields, steps, calls: this.turnCalls };
  }

  private requireModel(): void {
    if (!this.llm.onDevice) throw new Error('Maestro Open requires an on-device model (WebGPU).');
  }
}

export function createMilestoneEngine(brief: LessonBrief, llm: LLMEngine, snapshot?: unknown): TutorEngine {
  return new MilestoneEngine(brief, llm, snapshot);
}
