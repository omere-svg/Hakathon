import { useEffect, useRef, useState } from 'react';
import { exampleLessonBriefs, getExampleBriefById, pickRandomExampleBrief } from '../domain/exampleLessons';
import {
  clearPickedCustomBrief,
  clearPickedLesson,
  clearSession,
  loadSession,
  peekPickedCustomBrief,
  peekPickedLessonId,
  saveSession,
  setPickedCustomBrief,
  setPickedLesson,
  type SavedMsg,
} from '../domain/session';
import { createEngine, type LlmCall, type PlanStep, type Suggestions, type TutorEngine } from '../engine';
import { getLLM } from '../llm/engine';
import { webgpuAvailable } from '../llm/webllm';
import type { LLMEngine } from '../llm/types';
import { getFlags } from '../config/features';
import { Markdown } from '../components/Markdown';
import { EngineDebugPanel, LlmCallsBox } from '../components/EngineDebugPanel';
import { LoadingGame } from '../components/LoadingGame';
import { AgentAvatar, BreadcrumbChevron, BoltIcon, CodeIcon, MicIcon } from '../components/icons';

// LessonPage is engine-AGNOSTIC. It holds one TutorEngine instance (chosen by the `engine`
// flag), calls start()/respond(), and renders whatever the engine returns — reply,
// suggestion chips, and dev-panel debug. It knows nothing about milestones, KCs, or memory;
// each engine owns all of that internally. Swap engines in Settings; this file is unchanged.
//
// Sessions persist: every turn is saved (brief + transcript + engine snapshot), so a reload
// or a trip to Settings resumes the lesson instead of losing it. "New lesson" clears the
// saved session and picks a fresh random lesson from the course reference.

interface Msg {
  id: string;
  role: 'student' | 'tutor';
  text: string;
  /** dev status line for this turn (engine-specific). */
  status?: string;
  /** the engine's ordered plan at this turn (e.g. milestone decomposition) — dev panel. */
  steps?: PlanStep[];
  /** every model call made to produce THIS turn (prompt + response) — dev panel. */
  calls?: LlmCall[];
  /** suggestion chips the engine computed for THIS tutor turn. */
  suggest?: Suggestions;
}

let seq = 0;
const nid = () => `m-${++seq}`;

/** Cycled under the dino while the first-turn decomposition runs — honest phase names
 *  (classify/split → refine → coverage), so the wait reads as progress, not a hang. */
const PLANNING_NOTES = [
  'Planning your lesson',
  'Breaking your goals into small milestones',
  'Ordering the steps',
  'Double-checking nothing is missing',
];

export function LessonPage() {
  // Lesson resolution, read once before any state derives from it: a student-authored
  // custom lesson > an explicitly picked lesson (always starts fresh) > a saved session >
  // a fresh random lesson. PURE reads only (peek, never consume): StrictMode invokes this
  // initializer twice, and a consuming read here made the second call miss the pick and
  // fall through to a RANDOM lesson (the "picked X, opened Y" bug). The one-shot keys are
  // cleared in the once-guarded init effect below instead.
  const [init] = useState(() => {
    const custom = peekPickedCustomBrief();
    const pickedId = custom ? null : peekPickedLessonId();
    const picked = pickedId ? getExampleBriefById(pickedId) : undefined;
    const saved = custom || picked ? null : loadSession();
    return { brief: custom ?? picked ?? saved?.brief ?? pickRandomExampleBrief(), saved };
  });
  const { brief } = init;

  const [messages, setMessages] = useState<Msg[]>([]);
  // True when this render restored a saved transcript — shown as a banner so a restored
  // conversation is never mistaken for fresh model output (dismissable, or "Start fresh").
  const [resumed, setResumed] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unsupported'>('loading');
  // Persisted so a reload doesn't silently turn the engine panel back off.
  const [dev, setDev] = useState<boolean>(() => {
    try { return localStorage.getItem('maestro.dev') === '1'; } catch { return false; }
  });
  const toggleDev = () => setDev((v) => {
    const next = !v;
    try { localStorage.setItem('maestro.dev', next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });
  const [loadNote, setLoadNote] = useState('Loading the on-device tutor…');
  const [engineName, setEngineName] = useState('');
  // The dino fills the two dead-time phases (model load + first decomposition); "skip"
  // falls back to the plain progress note for the rest of this visit.
  const [gameSkipped, setGameSkipped] = useState(false);
  const [planNoteIdx, setPlanNoteIdx] = useState(0);

  const engineRef = useRef<TutorEngine | null>(null);
  const llmRef = useRef<LLMEngine | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const didInit = useRef(false);

  /** Persist the whole session (best-effort) — called after every settled turn. */
  function persist(msgs: Msg[]) {
    const engine = engineRef.current;
    if (!engine || !msgs.length) return;
    const saved: SavedMsg[] = msgs.map(({ id, role, text, status: st, suggest }) => ({ id, role, text, status: st, suggest }));
    saveSession({ brief, messages: saved, engine: engine.serialize?.() ?? null });
  }

  /** Fill a tutor message's chips in when the engine's suggestions promise settles —
   *  the reply itself never waits on them. */
  function attachSuggestions(id: string, suggestions?: Promise<Suggestions | undefined>) {
    suggestions?.then((s) => {
      if (!s) return;
      setMessages((m) => {
        const next = m.map((x) => (x.id === id ? { ...x, suggest: s } : x));
        persist(next);
        return next;
      });
    });
  }

  // Load the on-device model, create the selected engine, then let IT produce the first turn
  // (or resume the saved one). No WebGPU / no model → honest unsupported screen.
  // The LLM itself is cached at module level (llm/engine.ts), so navigating away and back
  // reuses the live engine instead of re-instantiating the WASM runtime (which corrupts its
  // Embind type registry). The ref only guards StrictMode's double-invoke of this effect.
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    // The one-shot lesson handoffs were peeked (not consumed) by the state initializer —
    // retire them here, exactly once, so a stale pick never pins a future load.
    clearPickedLesson();
    clearPickedCustomBrief();
    (async () => {
      const { llm, fellBack, reason } = await getLLM('webllm', (t) => setLoadNote(t));
      // "unsupported" means NO MODEL loaded — never a turn error (see below).
      if (fellBack || !llm) {
        console.error('[Maestro] model did not load:', reason);
        setLoadNote(reason ?? 'WebGPU is unavailable in this browser.');
        setStatus('unsupported');
        return;
      }
      llmRef.current = llm;
      const saved = init.saved;
      const engine = createEngine(getFlags().engine, brief, llm, saved?.engine ?? undefined);
      engineRef.current = engine;
      setEngineName(engine.name);
      setStatus('ready');

      if (saved) {
        // Resume: the transcript and the engine's queue come back exactly as saved.
        // Saved messages carry no dev-panel data (persist() strips it for quota), but the
        // restored engine still knows its plan — reattach it to the last tutor message so
        // the decomposition survives a reload. LLM calls don't: they aren't persisted.
        seq = Math.max(seq, ...saved.messages.map((m) => parseInt(m.id.replace(/\D/g, ''), 10) || 0));
        const steps = engine.debugView?.().steps;
        const msgs: Msg[] = saved.messages.map((m) => ({ ...m }));
        const lastTutorIdx = msgs.map((m) => m.role).lastIndexOf('tutor');
        if (lastTutorIdx >= 0) msgs[lastTutorIdx] = { ...msgs[lastTutorIdx], steps };
        setMessages(msgs);
        setResumed(true);
        console.log(`[Maestro] resumed lesson: ${brief.title} (${saved.messages.length} messages)`);
        return;
      }

      console.log(`[Maestro] lesson: ${brief.title} (${brief.goals.length} mastery goals)`);
      // The intro turn can be slow (the milestone engine decomposes the goal first), so mark
      // it busy to render the typing indicator — otherwise the chat looks frozen.
      setBusy(true);
      try {
        const view = await engine.start();
        const id = nid();
        setMessages(() => {
          const next = [{ id, role: 'tutor' as const, text: view.reply, status: view.status, steps: view.debug?.steps, calls: view.debug?.calls }];
          persist(next);
          return next;
        });
        attachSuggestions(id, view.suggestions);
      } catch (err) {
        // A first-turn failure is NOT "unsupported" — the model loaded. Greet and let the
        // student start; surface the error in the console for diagnosis.
        console.error('[Maestro] intro turn failed:', err);
        setMessages([{ id: nid(), role: 'tutor', text: "Hi — I'm your Maestro tutor. Say “ready” to begin, or ask me anything about this lesson." }]);
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  // Cycle the planning note while the first-turn decomposition runs, so the wait visibly moves.
  useEffect(() => {
    if (!(status === 'ready' && busy && messages.length === 0)) return;
    const t = setInterval(() => setPlanNoteIdx((i) => (i + 1) % PLANNING_NOTES.length), 2600);
    return () => clearInterval(t);
  }, [status, busy, messages.length]);

  function newLesson() {
    clearSession();
    location.reload();
  }

  /** Dev-mode lesson switcher: discard the current session and start the chosen lesson
   *  fresh (its own mastery goals → its own decomposition). Reload keeps the engine/LLM
   *  lifecycle identical to any other lesson start. */
  function switchLesson(id: string) {
    if (id === brief.id) return;
    clearSession();
    setPickedLesson(id);
    location.reload();
  }

  // ── Custom lesson: the student writes a title + mastery goals; the engine treats it
  // exactly like a catalog lesson (decompose → milestones → persistence). ─────────────
  const [creating, setCreating] = useState(false);
  const [customTitle, setCustomTitle] = useState('');
  const [customGoals, setCustomGoals] = useState('');

  function startCustomLesson() {
    const title = customTitle.trim();
    const goals = customGoals
      .split(/\r?\n/)
      .map((s) => s.trim().replace(/^[-*•]\s*/, '')) // tolerate pasted bullet lists
      .filter(Boolean)
      .map((statement, i) => ({ id: `g${i + 1}`, statement }));
    if (!title || !goals.length) return;
    clearSession();
    setPickedCustomBrief({
      id: `custom-${Date.now()}`,
      title,
      topic: title,
      program: 'My lessons',
      course: 'Custom lesson',
      language: 'Python',
      goals,
    });
    location.reload();
  }

  async function send(value: string) {
    const t = value.trim();
    const engine = engineRef.current;
    if (!t || busy || done || status !== 'ready' || !engine) return;
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    setBusy(true);
    setMessages((m) => [...m, { id: nid(), role: 'student', text: t }]);
    try {
      const view = await engine.respond(t);
      const id = nid();
      setMessages((m) => {
        const next = [...m, { id, role: 'tutor' as const, text: view.reply, status: view.status, steps: view.debug?.steps, calls: view.debug?.calls }];
        persist(next);
        return next;
      });
      attachSuggestions(id, view.suggestions);
      if (view.done) setDone(true);
    } catch (err) {
      console.error('[Maestro] turn failed:', err);
      setMessages((m) => [...m, { id: nid(), role: 'tutor', text: 'The on-device model hit an error — please try again.' }]);
    } finally {
      setBusy(false);
    }
  }

  // Chips belong to the LATEST tutor message (computed by the engine when it was created),
  // so they always render under the message they relate to — and never before it or while busy.
  const lastTutor = [...messages].reverse().find((m) => m.role === 'tutor');
  const suggest = status === 'ready' && !busy && !done ? lastTutor?.suggest : undefined;
  const quickReplies = suggest?.quick ?? [];
  const devSteps = lastTutor?.steps ?? [];
  // Dev-panel split: decomposition calls (lesson-level, made once before any message) pin
  // to the TOP panel; each message's remaining calls render under its own bubble so the
  // dev data never buries the conversation.
  const isDecomposeCall = (c: LlmCall) => c.label.startsWith('decompose:');
  const firstTutor = messages.find((m) => m.role === 'tutor');
  const decomposeCalls = (firstTutor?.calls ?? []).filter(isDecomposeCall);
  const turnCallsOf = (m: Msg) => (m.calls ?? []).filter((c) => !isDecomposeCall(c));
  // The dino covers the model download AND the first-turn decomposition — the two waits
  // where the screen would otherwise be dead. Mid-lesson turns keep the typing dots.
  const coldStart = status === 'loading' || (busy && messages.length === 0);
  const planning = status === 'ready' && busy && messages.length === 0;

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
          <span className="crumb muted">{brief.program}</span>
          <BreadcrumbChevron className="crumb-sep" />
          <span className="crumb muted">{brief.course}</span>
          <BreadcrumbChevron className="crumb-sep" />
          <span className="crumb current">{brief.title}</span>
        </nav>
        <div style={{ display: 'flex', gap: 8 }}>
          {dev && (
            <select
              className="lesson-pick"
              value={brief.id}
              title="Dev: switch to a specific lesson (discards this session)"
              onChange={(e) => switchLesson(e.target.value)}
            >
              {exampleLessonBriefs.map((b) => (
                <option key={b.id} value={b.id}>{b.title}</option>
              ))}
            </select>
          )}
          <button className="dev-toggle" onClick={() => setCreating(true)} title="Write your own lesson: a title plus its mastery goals">
            Create lesson
          </button>
          <button className="dev-toggle" onClick={newLesson} title="Discard this session and start a fresh random lesson">
            New lesson
          </button>
          <button className={`dev-toggle${dev ? ' on' : ''}`} onClick={toggleDev} title="Show the engine internals">
            {dev ? 'Hide engine' : 'Show engine'}
          </button>
        </div>
      </header>

      {dev && (
        <EngineDebugPanel
          engineName={engineName}
          llmName={llmRef.current?.name ?? loadNote}
          status={lastTutor?.status}
          goals={brief.goals}
          steps={devSteps}
          calls={decomposeCalls}
        />
      )}

      {resumed && (
        <div className="resume-banner" role="status">
          <span>
            Resumed your saved lesson — this conversation is from before the reload.
            {dev ? ' (The LLM call log is per-turn and not saved across reloads.)' : ''}
          </span>
          <button onClick={newLesson}>Start fresh</button>
          <button className="resume-dismiss" onClick={() => setResumed(false)} aria-label="Dismiss">×</button>
        </div>
      )}

      {creating && (
        <div className="modal-overlay" onClick={() => setCreating(false)}>
          <div className="modal" role="dialog" aria-label="Create your own lesson" onClick={(e) => e.stopPropagation()}>
            <h3>Create your own lesson</h3>
            <p className="dim">
              Give it a title and list the mastery goals — one per line. The tutor plans and
              teaches it like any other lesson (Python).
            </p>
            <label className="modal-label" htmlFor="custom-title">Lesson title</label>
            <input
              id="custom-title"
              className="modal-input"
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              placeholder="e.g. Reading and slicing Python lists"
              autoFocus
            />
            <label className="modal-label" htmlFor="custom-goals">Mastery goals (one per line)</label>
            <textarea
              id="custom-goals"
              className="modal-input"
              rows={5}
              value={customGoals}
              onChange={(e) => setCustomGoals(e.target.value)}
              placeholder={'Access list items by index, including negative indexes.\nSlice a list with `[start:stop:step]`.'}
            />
            <div className="modal-actions">
              <button className="dev-toggle" onClick={() => setCreating(false)}>Cancel</button>
              <button
                className="run-btn"
                onClick={startCustomLesson}
                disabled={!customTitle.trim() || !customGoals.trim()}
              >
                Start lesson
              </button>
            </div>
          </div>
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
                {dev && m.role === 'tutor' && m.status && (
                  <div className="checks">
                    <span className="act-badge">{m.status}</span>
                  </div>
                )}
                {dev && m.role === 'tutor' && turnCallsOf(m).length > 0 && (
                  <LlmCallsBox calls={turnCallsOf(m)} heading="LLM CALLS (this turn) · dev only" />
                )}
              </div>
            </div>
          ))}

          {coldStart && !gameSkipped ? (
            <div className="preparing game">
              <LoadingGame note={planning ? PLANNING_NOTES[planNoteIdx] : loadNote} />
              <button className="game-skip" onClick={() => setGameSkipped(true)}>Skip the game</button>
            </div>
          ) : (
            (status === 'loading' || busy) && (
              <div className="preparing">{status === 'loading' ? loadNote : <span className="typing"><i /><i /><i /></span>}</div>
            )
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {quickReplies.length > 0 && (
          <div className="mcq quick-replies">
            {quickReplies.map((qr) => (
              <button key={qr.label} disabled={busy} onClick={() => send(qr.text)}>{qr.label}</button>
            ))}
          </div>
        )}

        {done && (
          <div className="mcq quick-replies">
            <button onClick={newLesson}>Lesson complete — start a new one</button>
          </div>
        )}

        <div className="composer">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            placeholder={done ? 'Lesson complete' : 'Message Maestro…'}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
            disabled={busy || done || status !== 'ready'}
          />
          <div className="composer-tools">
            <div className="tools-left">
              <button className="tool" type="button" aria-label="Quick actions"><BoltIcon /></button>
              <button className="tool code-toggle" type="button" aria-label="Code mode">
                <CodeIcon />
                <span className="switch" />
              </button>
            </div>
            <button className="tool mic" type="button" aria-label="Send message" onClick={() => send(input)}>
              <MicIcon />
            </button>
          </div>
        </div>
        <div className="composer-foot">Maestro can make mistakes. Check important info.</div>
      </div>
    </div>
  );
}
