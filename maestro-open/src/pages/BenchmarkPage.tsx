import { useState } from 'react';
import { runAllScenarios, type ScenarioResult } from '../eval/runner';
import { getLLM } from '../llm/engine';
import { MODELS, getSelectedModelId, modelById } from '../llm/models';
import { getFlags } from '../config/features';

// Proof of performance: run the 10 TutorBench failure modes on a chosen on-device model,
// WITH the engine vs the RAW model, and report pass-rate, latency, and repair count.
// The headline: small models fail raw, pass wrapped — and the lift grows as the model shrinks.

interface Agg {
  modelId: string;
  modelLabel: string;
  total: number;
  enginePass: number;
  rawPass: number;
  medEngineMs: number;
  avgRepairs: number;
  results: ScenarioResult[];
}

function aggregate(modelId: string, modelLabel: string, results: ScenarioResult[]): Agg {
  const ms = results.map((r) => r.engine.ms).sort((a, b) => a - b);
  const med = ms.length ? ms[Math.floor(ms.length / 2)] : 0;
  const repairs = results.reduce((n, r) => n + r.engine.repairs, 0);
  return {
    modelId,
    modelLabel,
    total: results.length,
    enginePass: results.filter((r) => r.engine.passed).length,
    rawPass: results.filter((r) => r.raw.passed).length,
    medEngineMs: Math.round(med),
    avgRepairs: results.length ? +(repairs / results.length).toFixed(1) : 0,
    results,
  };
}

export function BenchmarkPage() {
  const [modelId, setModelId] = useState(getSelectedModelId());
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<Agg[]>([]);
  const [last, setLast] = useState<Agg | null>(null);
  const flags = getFlags();

  async function run() {
    setRunning(true);
    setNote('Loading model…');
    const { llm, fellBack, reason } = await getLLM('webllm', (t) => setNote(t), modelId);
    if (fellBack || !llm) {
      setNote(reason ?? 'WebGPU unavailable — open in Chrome/Edge on a laptop.');
      setRunning(false);
      return;
    }
    setNote('Running 10 scenarios × {engine, raw}…');
    const results = await runAllScenarios(llm);
    const label = modelById(modelId)?.label ?? modelId;
    const agg = aggregate(modelId, label, results);
    setRows((prev) => [...prev.filter((r) => r.modelId !== modelId), agg]);
    setLast(agg);
    setNote('Done.');
    setRunning(false);
  }

  return (
    <div className="evals">
      <h1>Benchmark — does the engine make a small model teach well?</h1>
      <div className="sub">
        Runs the 10 TutorBench failure modes on a real on-device model, <b>with our engine</b> vs the <b>raw model</b>.
        Engine config: best-of-{flags.bestOfN}, structured={String(flags.structuredOutput)}, repair={String(flags.repair)},
        exemplars={String(flags.exemplars)} (change in Settings).
      </div>

      <div className="eval-controls">
        <label>
          Model:&nbsp;
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={running}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label} (~{m.approxGB}GB)</option>
            ))}
          </select>
        </label>
        <button className="run-btn" onClick={run} disabled={running}>{running ? 'Running…' : 'Run benchmark'}</button>
        {note && <span className="eval-note">{note}</span>}
      </div>

      {rows.length > 0 && (
        <table className="bench-table">
          <thead>
            <tr><th>Model</th><th>Engine</th><th>Raw model</th><th>Lift</th><th>Median latency</th><th>Avg repairs</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.modelId}>
                <td>{r.modelLabel}</td>
                <td className="pass">{r.enginePass}/{r.total}</td>
                <td className="fail">{r.rawPass}/{r.total}</td>
                <td><b>+{r.enginePass - r.rawPass}</b></td>
                <td>{r.medEngineMs} ms</td>
                <td>{r.avgRepairs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {last && (
        <>
          <h2 className="bench-h2">Per-scenario · {last.modelLabel}</h2>
          {last.results.map((r) => (
            <div className="scenario-card" key={r.scenario.id}>
              <div className="scenario-head">
                <span className="scenario-id">{r.scenario.id}</span>
                <span className="tag">{r.scenario.constraintId}</span>
                <span>{r.scenario.title}</span>
                <span className={`verdict ${r.engine.passed ? 'pass' : 'fail'}`}>engine {r.engine.passed ? 'PASS' : 'FAIL'}</span>
                <span className={`verdict ${r.raw.passed ? 'pass' : 'fail'}`}>raw {r.raw.passed ? 'PASS' : 'FAIL'}</span>
              </div>
              <div className="mode-grid">
                <div className="mode"><h4>Engine ({Math.round(r.engine.ms)} ms, {r.engine.repairs} repairs)</h4><div className="out">{r.engine.output}</div></div>
                <div className="mode"><h4>Raw model ({Math.round(r.raw.ms)} ms)</h4><div className="out">{r.raw.output}</div></div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
