import { useEffect, useRef, useState } from 'react';
import { runAllScenarios, type ModeResult, type ScenarioResult } from '../eval/runner';
import { getLLM } from '../llm/engine';
import type { LLMEngine } from '../llm/types';

function ModeColumn({ title, result }: { title: string; result: ModeResult }) {
  return (
    <div className="mode">
      <h4>
        {title} <span className={`pill ${result.passed ? 'pass' : 'fail'}`}>{result.passed ? 'PASS' : 'FAIL'}</span>
        {result.act && <span className="act-badge"> act: {result.act}</span>}
      </h4>
      <div className="out">{result.output}</div>
      {result.checks.map((c) => (
        <div className="check" key={c.id}>
          <span className={`mark ${c.passed ? 'pass' : 'fail'}`}>{c.passed ? '✓' : '✗'}</span>
          <span>{c.id} {c.label}</span>
        </div>
      ))}
    </div>
  );
}

export function EvalsPage() {
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [status, setStatus] = useState<'loading' | 'running' | 'ready' | 'unsupported'>('loading');
  const [note, setNote] = useState('Loading the on-device model…');
  const llmRef = useRef<LLMEngine | null>(null);

  async function run(llm: LLMEngine) {
    setStatus('running');
    setNote(`Running the same on-device model with vs without the engine — ${llm.name}`);
    setResults(await runAllScenarios(llm));
    setStatus('ready');
  }

  useEffect(() => {
    (async () => {
      const { llm, fellBack, reason } = await getLLM('webllm', (t) => setNote(t));
      if (fellBack || !llm) { setNote(reason ?? 'WebGPU unavailable.'); setStatus('unsupported'); return; }
      llmRef.current = llm;
      await run(llm);
    })();
  }, []);

  if (status === 'unsupported') {
    return (
      <div className="evals">
        <div className="unsupported">
          <h2>Evals run on the real on-device model</h2>
          <p>This page proves performance by running the same WebGPU model with and without our engine. Your browser doesn't support WebGPU — open in Chrome/Edge on a laptop.</p>
          <p className="dim">{note}</p>
        </div>
      </div>
    );
  }

  const total = results.length;
  const passing = results.filter((r) => r.engine.passed).length;
  const rawPassing = results.filter((r) => r.raw.passed).length;
  const allPass = total > 0 && passing === total;
  const busy = status === 'loading' || status === 'running';

  return (
    <div className="evals">
      <h1>Proof of performance</h1>
      <div className="sub">
        The 10 TutorBench failure modes as acceptance tests, each graded by a universal constraint (C1–C10) — not
        scenario-specific code. Both columns run the <b>same on-device model</b>: <b>Engine</b> = our verify-and-repair tutor;
        <b> Control</b> = the raw model with no engine. An honest scoreboard — green means the model genuinely complied.
      </div>

      <div className="eval-controls">
        <span className="scoreboard">
          <span className={`score-num ${allPass ? 'all-pass' : ''}`}>{busy ? '…' : `${passing}/${total}`}</span>
          <span>engine{!busy && total > 0 ? ` · ${rawPassing}/${total} raw control` : ''}</span>
        </span>
        <button className="run-btn" onClick={() => llmRef.current && run(llmRef.current)} disabled={busy || !llmRef.current}>
          {status === 'running' ? 'Running…' : 'Re-run'}
        </button>
        {busy && <span className="eval-note">{note}</span>}
      </div>

      {results.map((r) => (
        <div className="scenario-card" key={r.scenario.id}>
          <div className="scenario-head">
            <span className="scenario-id">{r.scenario.id}</span>
            <span className="tag">{r.scenario.track}</span>
            <span className="tag">{r.scenario.constraintId}</span>
            <span>{r.scenario.title}</span>
            <span className={`verdict ${r.engine.passed ? 'pass' : 'fail'}`}>{r.engine.passed ? 'PASS' : 'FAIL'}</span>
          </div>
          <div className="scenario-issue">Failure mode: {r.scenario.subIssue}</div>
          <div className="probe"><b>Student:</b> “{r.scenario.probe}”</div>
          <div className="mode-grid">
            <ModeColumn title="Full engine" result={r.engine} />
            <ModeColumn title="No engine (control)" result={r.raw} />
          </div>
        </div>
      ))}
    </div>
  );
}
