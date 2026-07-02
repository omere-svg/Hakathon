import type { LlmCall, MasteryGoal, PlanStep } from '../engine';

// The "Show engine" dev panel, extracted from LessonPage so the page stays about the chat
// loop. Pure presentation — it renders whatever engine state it's handed; it holds no state
// and makes no calls. Rendered only when dev mode is on (LessonPage gates it). The visible
// UI is unchanged from when this lived inline.

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
  /** every model call made to produce this turn (prompt + response + latency). */
  calls: LlmCall[];
}

export function EngineDebugPanel({ engineName, llmName, status, goals, steps, calls }: EngineDebugPanelProps) {
  return (
    <>
      <div className="engine-bar">
        <span>{engineName || 'Tutor'} · {llmName}</span>
        <span className="state">{status ?? '—'}</span>
      </div>

      <div
        style={{
          margin: '8px 16px 0',
          padding: '10px 12px',
          border: '1px dashed #2dd4bf',
          borderRadius: 8,
          background: 'rgba(45, 212, 191, 0.08)',
          fontSize: 12,
        }}
      >
        <div style={{ color: '#5eead4', fontWeight: 600, marginBottom: 6, letterSpacing: 0.3 }}>
          🎯 MASTERY GOALS (input) · dev only — {goals.length} goal{goals.length === 1 ? '' : 's'} fed to the engine
        </div>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, color: '#cbd5e1' }}>
          {goals.map((g) => (
            <li key={g.id}>{g.statement}</li>
          ))}
        </ol>
      </div>

      {steps.length > 0 && (
        <div
          style={{
            margin: '8px 16px',
            padding: '10px 12px',
            border: '1px dashed #7c5cff',
            borderRadius: 8,
            background: 'rgba(124, 92, 255, 0.08)',
            fontSize: 12,
          }}
        >
          <div style={{ color: '#a78bfa', fontWeight: 600, marginBottom: 6, letterSpacing: 0.3 }}>
            🧭 GOAL DECOMPOSITION · dev only — the student never sees this
          </div>
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
        </div>
      )}

      {calls.length > 0 && (
        <div
          style={{
            margin: '8px 16px',
            padding: '10px 12px',
            border: '1px dashed #f59e0b',
            borderRadius: 8,
            background: 'rgba(245, 158, 11, 0.08)',
            fontSize: 12,
          }}
        >
          <div style={{ color: '#fbbf24', fontWeight: 600, marginBottom: 6, letterSpacing: 0.3 }}>
            📡 LLM CALLS (this turn) · dev only — {calls.length} call{calls.length === 1 ? '' : 's'}, {Math.round(calls.reduce((n, c) => n + c.ms, 0))}ms total
          </div>
          {calls.map((c, i) => (
            <details key={i} style={{ marginBottom: 4 }}>
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
        </div>
      )}
    </>
  );
}
