import { useState, type ReactNode } from 'react';
import type { LlmCall, MasteryGoal, PlanStep } from '../engine';

// The "Show engine" dev panel, extracted from LessonPage so the page stays about the chat
// loop. Pure presentation — it renders whatever engine state it's handed; it holds no
// engine state and makes no calls. Rendered only when dev mode is on (LessonPage gates it).
//
// Layout: EVERY box collapses to a single summary line (native <details>), so dev mode
// never buries the conversation — the boxes were observed pushing the tutor's message
// entirely off-screen. The calls box has three levels: one line → per-call list →
// "Expand details" for the full prompt/response elaboration.

interface EngineDebugPanelProps {
  /** engine display name (e.g. "Milestone Flow"). */
  engineName: string;
  /** loaded model name, or the current load note before it's ready. */
  llmName: string;
  /** the latest tutor turn's status line (e.g. "Milestone 2/4 · active"). */
  status?: string;
  /** the Mastery Goals fed to the engine (the lesson input). */
  goals: MasteryGoal[];
  /** the engine's ordered plan this turn (milestone decomposition). */
  steps: PlanStep[];
  /** the decomposition calls (labels starting with `decompose:`) — per-turn calls render
   *  under their own message instead. */
  calls: LlmCall[];
}

/** One collapsible dev box: a colored dashed frame whose header line is the toggle. */
function DevBox({
  color,
  background,
  header,
  children,
  margin = '8px 16px 0',
}: {
  color: string;
  background: string;
  header: ReactNode;
  children: ReactNode;
  margin?: string;
}) {
  return (
    <details
      style={{
        margin,
        padding: '8px 12px',
        border: `1px dashed ${color}`,
        borderRadius: 8,
        background,
        fontSize: 12,
      }}
    >
      <summary style={{ cursor: 'pointer', color, fontWeight: 600, letterSpacing: 0.3 }}>{header}</summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  );
}

/** The amber "LLM calls" box. Collapsed = one summary line; open = one line per call;
 *  "Expand details" = full prompt/response for every call (remounts the rows via key so
 *  the native open state resets). Reused at the top of the page (decomposition calls) and
 *  under every tutor message (that turn's calls). */
export function LlmCallsBox({ calls, heading }: { calls: LlmCall[]; heading: string }) {
  const [allOpen, setAllOpen] = useState(false);
  const [gen, setGen] = useState(0);
  if (!calls.length) return null;
  const toggleAll = () => {
    setAllOpen((v) => !v);
    setGen((g) => g + 1);
  };
  return (
    <DevBox
      color="#fbbf24"
      background="rgba(245, 158, 11, 0.08)"
      margin="8px 0 4px"
      header={
        <>
          📡 {heading} — {calls.length} call{calls.length === 1 ? '' : 's'}, {Math.round(calls.reduce((n, c) => n + c.ms, 0))}ms total
        </>
      }
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <button
          type="button"
          onClick={toggleAll}
          style={{
            background: 'transparent',
            border: '1px solid rgba(245, 158, 11, 0.5)',
            borderRadius: 6,
            color: '#fbbf24',
            fontSize: 11,
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {allOpen ? 'Collapse details' : 'Expand details'}
        </button>
      </div>
      {calls.map((c, i) => (
        <details key={`${gen}-${i}`} open={allOpen} style={{ marginBottom: 4 }}>
          <summary style={{ cursor: 'pointer', color: '#fcd34d' }}>
            {i + 1}. {c.label} · {Math.round(c.ms)}ms
          </summary>
          <div style={{ paddingLeft: 12 }}>
            {([['SYSTEM', c.system], ['USER', c.user], ['RESPONSE', c.response]] as const).map(([tag, body]) => (
              <div key={tag} style={{ marginTop: 6 }}>
                <div style={{ color: '#9ca3af', fontWeight: 600, fontSize: 11 }}>{tag}</div>
                <pre
                  style={{
                    margin: '2px 0 0',
                    padding: '6px 8px',
                    background: 'rgba(0,0,0,0.35)',
                    borderRadius: 6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 200,
                    overflow: 'auto',
                    color: '#d1d5db',
                    fontSize: 11,
                  }}
                >
                  {body || '(empty)'}
                </pre>
              </div>
            ))}
          </div>
        </details>
      ))}
    </DevBox>
  );
}

export function EngineDebugPanel({ engineName, llmName, status, goals, steps, calls }: EngineDebugPanelProps) {
  const done = steps.filter((s) => s.state === 'done').length;
  const current = steps.find((s) => s.state === 'active')?.label;
  return (
    <>
      <div className="engine-bar">
        <span>{engineName || 'Tutor'} · {llmName}</span>
        <span className="state">{status ?? '—'}</span>
      </div>

      <DevBox
        color="#5eead4"
        background="rgba(45, 212, 191, 0.08)"
        header={<>🎯 MASTERY GOALS (input) · dev only — {goals.length} goal{goals.length === 1 ? '' : 's'} fed to the engine</>}
      >
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, color: '#cbd5e1' }}>
          {goals.map((g) => (
            <li key={g.id}>{g.statement}</li>
          ))}
        </ol>
      </DevBox>

      {steps.length > 0 && (
        <DevBox
          color="#a78bfa"
          background="rgba(124, 92, 255, 0.08)"
          margin="8px 16px 0"
          header={
            <>
              🧭 GOAL DECOMPOSITION · dev only — {done}/{steps.length} done
              {current ? ` · current: ${current.length > 48 ? `${current.slice(0, 47)}…` : current}` : ''}
            </>
          }
        >
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            {steps.map((s, i) => (
              <li
                key={i}
                style={{
                  color: s.state === 'done' ? '#4ade80' : s.state === 'active' ? '#fde047' : '#8b8b8b',
                  textDecoration: s.state === 'done' ? 'line-through' : 'none',
                }}
              >
                {s.label}
                {s.state === 'active' ? '  ◀ current' : s.state === 'done' ? '  ✓' : ''}
              </li>
            ))}
          </ol>
        </DevBox>
      )}

      {calls.length > 0 && (
        <div style={{ margin: '0 16px' }}>
          <LlmCallsBox calls={calls} heading="DECOMPOSITION CALLS · dev only" />
        </div>
      )}
    </>
  );
}
