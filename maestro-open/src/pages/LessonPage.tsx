import { useEffect, useRef, useState } from 'react';
import { whileLoopLesson, MCQ_OPTIONS } from '../domain/lessons';
import { getCheck, getKc } from '../domain/schema';
import { initStudentModel, type StudentModel } from '../student/model';
import { initLessonMemory, type LessonMemory } from '../memory/types';
import { runTurn } from '../engine/orchestrator';
import type { ConstraintCheck } from '../engine/constraints';
import { getLLM } from '../llm/engine';
import { webgpuAvailable } from '../llm/webllm';
import type { LLMEngine } from '../llm/types';
import { getFlags } from '../config/features';
import { loadProgress, saveProgress } from '../storage/progress';
import { startingKc } from '../student/spacedRepetition';
import { Markdown } from '../components/Markdown';
import { AgentAvatar, BreadcrumbChevron, BoltIcon, CodeIcon, MicIcon } from '../components/icons';

interface Msg {
  id: string;
  role: 'student' | 'tutor';
  text: string;
  act?: string;
  checks?: ConstraintCheck[];
  repairs?: string[];
  /** Suggestion chips computed for THIS tutor turn (so chips match the message). */
  suggest?: { mcqCheckId?: string; quick?: QuickReply[] };
}

const lesson = whileLoopLesson;
let seq = 0;
const nid = () => `m-${++seq}`;

// Non-graded conversational quick-replies. Unlike the authored MCQ options (which are
// index-graded by the engine), these are just suggestions that steer the conversation.
// Their text is phrased to match the engine's deterministic cue detection (engine/cues.ts)
// so a tap reliably triggers the intended tutor behavior. No model call — always sensible.
interface QuickReply { label: string; text: string }

const TEACHING_REPLIES: QuickReply[] = [
  { label: 'I understand', text: 'I understand' },
  { label: 'Explain that again', text: 'Can you explain that again?' },
  { label: 'Show me an example', text: 'Show me an example' },
  { label: "I'm confused", text: "I'm confused" },
];
const HELP_REPLIES: QuickReply[] = [
  { label: 'Give me a hint', text: 'Can I get a hint?' },
  { label: 'Explain it differently', text: "I don't understand — can you explain it differently?" },
  { label: 'Show me an example', text: 'Show me an example' },
];

// Pick chips from the tutor's latest act + phase. Struggling/open-check turns get
// help-oriented chips; plain teaching turns get comprehension chips. None when done.
function suggestReplies(lastAct: string | undefined, phase: string, hasActiveCheck: boolean): QuickReply[] {
  if (phase === 'complete') return [];
  if (hasActiveCheck || lastAct === 'HINT' || lastAct === 'CORRECT' || lastAct === 'COMFORT') return HELP_REPLIES;
  return TEACHING_REPLIES;
}

// Decide the chips for a tutor turn from its ACT (not just phase — the engine flips to
// 'check' right after the intro, so phase alone would show the quiz options forever).
// Show the graded MCQ answers only on turns where an answer is actually expected
// (asking/probing/correcting) — while explaining or advancing, offer conversational chips.
function computeSuggest(mem: LessonMemory, act: string | undefined): Msg['suggest'] {
  if (mem.phase === 'complete') return undefined;
  const kc = getKc(lesson, mem.currentKcId);
  const activeCheck = kc && mem.activeCheckId ? getCheck(kc, mem.activeCheckId) : undefined;
  const answerExpected = act === 'ASK' || act === 'PROBE' || act === 'HINT' || act === 'CORRECT';
  if (activeCheck?.type === 'mcq' && MCQ_OPTIONS[activeCheck.id] && answerExpected) {
    return { mcqCheckId: activeCheck.id };
  }
  return { quick: suggestReplies(act, mem.phase, !!activeCheck) };
}

export function LessonPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unsupported'>('loading');
  const [dev, setDev] = useState(false);
  const [loadNote, setLoadNote] = useState('Loading the on-device tutor…');

  const studentRef = useRef<StudentModel>(initStudentModel());
  const memRef = useRef<LessonMemory>(initLessonMemory(lesson.id, lesson.knowledgeComponents[0].id));
  const llmRef = useRef<LLMEngine | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const didInit = useRef(false);

  // Load the on-device model, then let the ENGINE produce the first turn.
  // No WebGPU / no model → honest unsupported screen. We never fake teaching.
  // Guard against React 18 StrictMode double-invoking this effect in dev: loading the
  // WebLLM engine twice instantiates the WASM runtime twice and corrupts its Embind type
  // registry (BindingError: "Expected … VectorInt, got … VectorInt" in the tokenizer).
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    (async () => {
      const flags = getFlags();
      // Resume prior progress (modular: only if persistence is on).
      if (flags.persistence) {
        const saved = loadProgress(lesson.id);
        if (saved) {
          studentRef.current = saved.student;
          memRef.current = { ...saved.mem, transcript: [] };
          if (flags.spacedRepetition) memRef.current.currentKcId = startingKc(lesson, saved.student);
        }
      }
      const { llm, fellBack, reason } = await getLLM('webllm', (t) => setLoadNote(t));
      // "unsupported" means NO MODEL loaded — never a turn error (see below).
      if (fellBack || !llm) {
        console.error('[Maestro] model did not load:', reason);
        setLoadNote(reason ?? 'WebGPU is unavailable in this browser.');
        setStatus('unsupported');
        return;
      }
      llmRef.current = llm;
      // The model IS loaded → the device is supported. Show the chat now.
      setStatus('ready');
      try {
        const res = await runTurn({ lesson, lessonMem: memRef.current, student: studentRef.current, studentMessage: '', mode: 'engine', llm });
        studentRef.current = res.student;
        memRef.current = res.lessonMem;
        if (getFlags().persistence) saveProgress(lesson.id, res.student, res.lessonMem);
        setMessages([{ id: nid(), role: 'tutor', text: res.output, act: res.act?.type, checks: res.checks, repairs: res.repairs, suggest: computeSuggest(res.lessonMem, res.act?.type) }]);
      } catch (err) {
        // A first-turn failure is NOT "unsupported" — the model loaded. Greet and let the
        // student start; surface the error in the console for diagnosis.
        console.error('[Maestro] intro turn failed:', err);
        setMessages([{ id: nid(), role: 'tutor', text: "Hi — I'm your Maestro tutor. Say “ready” to begin, or ask me anything about this lesson." }]);
      }
    })();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  // `value` is what the engine grades/sees (e.g. an MCQ index "1"); `display` is what the
  // student sees in the chat (e.g. the option sentence). They differ only for MCQ chips.
  async function send(value: string, display?: string) {
    const t = value.trim();
    const llm = llmRef.current;
    if (!t || busy || status !== 'ready' || !llm) return;
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    setBusy(true);
    setMessages((m) => [...m, { id: nid(), role: 'student', text: display ?? t }]);
    try {
      const res = await runTurn({ lesson, lessonMem: memRef.current, student: studentRef.current, studentMessage: t, mode: 'engine', llm });
      studentRef.current = res.student;
      memRef.current = res.lessonMem;
      if (getFlags().persistence) saveProgress(lesson.id, res.student, res.lessonMem);
      setMessages((m) => [...m, { id: nid(), role: 'tutor', text: res.output, act: res.act?.type, checks: res.checks, repairs: res.repairs, suggest: computeSuggest(res.lessonMem, res.act?.type) }]);
    } catch (err) {
      console.error('[Maestro] turn failed:', err);
      setMessages((m) => [...m, { id: nid(), role: 'tutor', text: 'The on-device model hit an error — please try again.' }]);
    } finally {
      setBusy(false);
    }
  }

  const mem = memRef.current;
  const student = studentRef.current;
  const kc = getKc(lesson, mem.currentKcId);

  // Chips belong to the LATEST tutor message (computed when it was created), so they
  // always render under the message they relate to — and never before it or while busy.
  const lastTutor = [...messages].reverse().find((m) => m.role === 'tutor');
  const suggest = status === 'ready' && !busy ? lastTutor?.suggest : undefined;
  const mcqOptions = suggest?.mcqCheckId ? MCQ_OPTIONS[suggest.mcqCheckId] : undefined;
  const quickReplies = suggest?.quick ?? [];

  if (status === 'unsupported') {
    const hasGpu = webgpuAvailable();
    return (
      <div className="lesson">
        <div className="unsupported">
          <h2>{hasGpu ? "The model didn't finish loading" : "This device can't run the on-device tutor yet"}</h2>
          <p>Maestro Open runs a real AI model privately on <b>your</b> device with WebGPU — no servers, $0 cost, your data never leaves the device.</p>
          {hasGpu ? (
            <p>WebGPU is available, but the model failed to load (often memory on the first big download). Try <b>Reload</b>, or pick a <b>smaller model</b> in Settings.</p>
          ) : (
            <p>Your current browser doesn't support WebGPU. Open this in <b>Chrome or Edge on a laptop/desktop</b> (or a recent device with iOS&nbsp;26 / Android&nbsp;12+) to start learning.</p>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14 }}>
            <button className="run-btn" onClick={() => location.reload()}>Reload</button>
            <a className="run-btn" href="#/settings" style={{ textDecoration: 'none' }}>Open Settings</a>
          </div>
          <p className="dim">{loadNote}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lesson">
      <header className="topbar">
        <nav className="breadcrumb" aria-label="breadcrumb">
          <span className="crumb muted">{lesson.program}</span>
          <BreadcrumbChevron className="crumb-sep" />
          <span className="crumb muted">{lesson.course}</span>
          <BreadcrumbChevron className="crumb-sep" />
          <span className="crumb current">{lesson.title}</span>
        </nav>
        <button className={`dev-toggle${dev ? ' on' : ''}`} onClick={() => setDev((v) => !v)} title="Show the deterministic engine internals">
          {dev ? 'Hide engine' : 'Show engine'}
        </button>
      </header>

      {dev && (
        <div className="engine-bar">
          <span>Verified on-device tutor · {llmRef.current?.name ?? loadNote}</span>
          <span className="state">
            KC: <b>{kc?.label}</b> · phase: {mem.phase} · frustration: {student.affect.frustration.toFixed(1)}
          </span>
        </div>
      )}

      <div className="chat" ref={listRef}>
        <div className="chat-inner">
          <div className="day-divider"><span>Today</span></div>

          {messages.map((m) => (
            <div className={`msg ${m.role}`} key={m.id}>
              {m.role === 'tutor' && (
                <div className="msg-avatar"><AgentAvatar /></div>
              )}
              <div className="msg-body">
                <div className={`bubble ${m.role}`}>
                  {m.role === 'tutor' ? <Markdown text={m.text} /> : <p>{m.text}</p>}
                </div>
                {dev && m.role === 'tutor' && (m.act || m.checks?.length) && (
                  <div className="checks">
                    {m.act && <span className="act-badge">act: {m.act}</span>}
                    {m.checks?.map((c) => (
                      <span className="check" key={c.id}>
                        <span className={`mark ${c.passed ? 'pass' : 'fail'}`}>{c.passed ? '✓' : '✗'}</span>
                        {c.id} {c.label}
                      </span>
                    ))}
                    {m.repairs && m.repairs.length > 0 && <span className="repairs">↻ {m.repairs.join(' ')}</span>}
                  </div>
                )}
              </div>
            </div>
          ))}

          {(status === 'loading' || busy) && (
            <div className="preparing">{status === 'loading' ? loadNote : <span className="typing"><i /><i /><i /></span>}</div>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {mcqOptions && (
          <div className="mcq">
            {mcqOptions.map((opt, i) => (
              // Grade by index (String(i)) but show the option sentence in the chat.
              <button key={i} disabled={busy} onClick={() => send(String(i), opt)}>{opt}</button>
            ))}
          </div>
        )}
        {quickReplies.length > 0 && (
          <div className="mcq quick-replies">
            {quickReplies.map((qr) => (
              <button key={qr.label} disabled={busy} onClick={() => send(qr.text)}>{qr.label}</button>
            ))}
          </div>
        )}

        <div className="composer">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            placeholder="Message Maestro…"
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            disabled={busy || status !== 'ready'}
          />
          <div className="composer-tools">
            <div className="tools-left">
              <button className="tool" type="button" aria-label="Quick actions"><BoltIcon /></button>
              <button className="tool code-toggle" type="button" aria-label="Code mode">
                <CodeIcon />
                <span className="switch" />
              </button>
            </div>
            <button className="tool mic" type="button" aria-label="Voice input" onClick={() => send(input)}>
              <MicIcon />
            </button>
          </div>
        </div>
        <div className="composer-foot">Maestro can make mistakes. Check important info.</div>
      </div>
    </div>
  );
}
