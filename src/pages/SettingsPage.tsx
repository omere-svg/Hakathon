import { useEffect, useState } from 'react';
import { getFlags, resetFlags, setFlags, type FeatureFlags } from '../config/features';
import { MODELS, getSelectedModelId, recommendModel, recommendModelAsync, setSelectedModelId } from '../llm/models';

// On-device control surface: pick the model, and (in dev) toggle Qwen3 thinking to feel its
// latency cost. The milestone engine reads only these two settings; everything else the tutor
// does lives in the engine, not behind a flag.

const IS_DEV = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);

export function SettingsPage() {
  const [flags, setLocal] = useState<FeatureFlags>(getFlags());
  const [modelId, setModel] = useState<string>(getSelectedModelId());
  // Coarse pick shown instantly; upgraded to the probe-backed pick once the adapter responds.
  const [rec, setRec] = useState(recommendModel());

  useEffect(() => {
    let alive = true;
    recommendModelAsync().then((m) => { if (alive) setRec(m); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  function update(patch: Partial<FeatureFlags>) {
    setLocal(setFlags(patch));
  }

  return (
    <div className="evals">
      <h1>Settings</h1>
      <div className="sub">Maestro Open runs a real model privately on your device. Pick the model that fits it — model changes apply on reload.</div>

      <h2 className="bench-h2">On-device model</h2>
      <div className="settings-block">
        <select
          value={modelId}
          onChange={(e) => { setModel(e.target.value); setSelectedModelId(e.target.value); }}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label} (~{m.approxGB}GB) — {m.note}</option>
          ))}
        </select>
        <div className="settings-help">Recommended for this device: <b>{rec.label}</b>. Reload the Lesson after changing.</div>
      </div>

      {IS_DEV && (
        <>
          <h2 className="bench-h2">Dev experiment</h2>
          <div className="settings-list">
            <label className="settings-row">
              <input
                type="checkbox"
                checked={Boolean(flags.thinking)}
                onChange={(e) => update({ thinking: e.target.checked })}
              />
              <span>
                <b>Qwen3 thinking mode</b>
                <span className="settings-help">
                  On → the model reasons in a &lt;think&gt; block before answering (slower). Off → /no_think.
                  Toggle to compare latency. Reload the Lesson after changing. (Dev only; no effect on non-Qwen3 models.)
                </span>
              </span>
            </label>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="run-btn" onClick={() => { setLocal(resetFlags()); }}>Reset settings to defaults</button>
      </div>
    </div>
  );
}
