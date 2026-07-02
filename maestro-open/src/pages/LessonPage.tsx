import { useEffect, useRef, useState } from 'react';
import { pickRandomExampleBrief } from '../domain/exampleLessons';
import { createEngine, type LlmCall, type PlanStep, type Suggestions, type TutorEngine } from '../engine';
import { getLLM } from '../llm/engine';
import { webgpuAvailable } from '../llm/webllm';
import type { LLMEngine } from '../llm/types';
import { getFlags } from '../config/features';
import { Markdown } from '../components/Markdown';
import { EngineDebugPanel } from '../components/EngineDebugPanel';
import { AgentAvatar, BreadcrumbChevron, BoltIcon, CodeIcon, MicIcon } from '../components/icons';

// LessonPage is engine-AGNOSTIC. It holds one TutorEngine instance (chosen by the `engine`
// flag), calls start()/respond(), and renders whatever the engine returns — reply,
// suggestion chips, and dev-panel debug. It knows nothing about milestones, KCs, or memory;
// each engine owns all of that internally. Swap engines in Settings; this file is unchanged.

// A fresh random lesson from the Week-3 course reference each page load, so we exercise the
// milestone engine across all the week's lessons instead of only the while-loop one.
const brief = pickRandomExampleBrief();
console.log(`[Maestro] lesson: ${brief.title} (${brief.goals.length} mastery goals)`);
let seq = 0;
const nid = () => `m-${++seq}`;

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

export function LessonPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
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

  const engineRef = useRef<TutorEngine | null>(null);
  const llmRef = useRef<LLMEngine | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const didInit = useRef(false);

  // Load the on-device model, create the selected engine, then let IT produce the first turn.
  // No WebGPU / no model → honest unsupported screen. We never fake teaching.
  // Guard against React 18 StrictMode double-invoking this effect in dev: loading the
  // WebLLM engine twice instantiates the WASM runtime twice and corrupts its Embind type
  // registry (BindingError: "Expected … VectorInt, got … VectorInt" in the tokenizer).
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
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
      const engine = createEngine(getFlags().engine, brief, llm);
      engineRef.current = engine;
      setEngineName(engine.name);
      // The model IS loaded → the device is supported. Show the chat now. The intro turn can
      // be slow (the milestone engine decomposes the goal first), so mark it busy to render
      // the typing indicator — otherwise the chat looks frozen until the first reply lands.
      setStatus('ready');
      setBusy(true);
      try {
        const view = await engine.start();
        setMessages([{ id: nid(), role: 'tutor', text: view.reply, status: view.status, steps: view.debug?.steps, calls: view.debug?.calls, suggest: view.suggestions }]);
      } catch (err) {
        // A first-turn failure is NOT "unsupported" — the model loaded. Greet and let the
        // student start; surface the error in the console for diagnosis.
        console.error('[Maestro] intro turn failed:', err);
        setMessages([{ id: nid(), role: 'tutor', text: "Hi — I'm your Maestro tutor. Say “ready” to begin, or ask me anything about this lesson." }]);
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  // `value` is what the engine sees (e.g. an MCQ index "1"); `display` is what the student
  // sees in the chat (e.g. the option sentence). They differ only for MCQ chips.
  async function send(value: string, display?: string) {
    const t = value.trim();
    const engine = engineRef.current;
    if (!t || busy || status !== 'ready' || !engine) return;
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    setBusy(true);
    setMessages((m) => [...m, { id: nid(), role: 'student', text: display ?? t }]);
    try {
      const view = await engine.respond(t);
      setMessages((m) => [...m, { id: nid(), role: 'tutor', text: view.reply, status: view.status, steps: view.debug?.steps, calls: view.debug?.calls, suggest: view.suggestions }]);
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
  const suggest = status === 'ready' && !busy ? lastTutor?.suggest : undefined;
  const quickReplies = suggest?.quick ?? [];
  const devSteps = lastTutor?.steps ?? [];
  const devCalls = lastTutor?.calls ?? [];

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
        <button className={`dev-toggle${dev ? ' on' : ''}`} onClick={toggleDev} title="Show the engine internals">
          {dev ? 'Hide engine' : 'Show engine'}
        </button>
      </header>

      {dev && (
        <EngineDebugPanel
          engineName={engineName}
          llmName={llmRef.current?.name ?? loadNote}
          status={lastTutor?.status}
          goals={brief.goals}
          steps={devSteps}
          calls={devCalls}
        />
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
              </div>
            </div>
          ))}

          {(status === 'loading' || busy) && (
            <div className="preparing">{status === 'loading' ? loadNote : <span className="typing"><i /><i /><i /></span>}</div>
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
