import { useState } from 'react';
import { DEFAULT_FLAGS, getFlags, resetFlags, setFlags, type FeatureFlags } from '../config/features';
import { MODELS, getSelectedModelId, recommendModel, setSelectedModelId } from '../llm/models';
import { clearAllProgress } from '../storage/progress';

// On-device control surface: toggle each feature module and pick the model. Everything
// here is modular — turning a feature off must never break the rest of the app.

const TOGGLES: { key: keyof FeatureFlags; label: string; help: string }[] = [
  { key: 'structuredOutput', label: 'Grammar-constrained turns', help: 'Force JSON-shaped replies (reliability on small models).' },
  { key: 'repair', label: 'Verify → re-prompt', help: 'Re-ask the model with a correction when it breaks a rule.' },
  { key: 'exemplars', label: 'Few-shot exemplars', help: 'Inject authored gold examples so the model imitates.' },
  { key: 'prefixCache', label: 'Prefix-cache layout', help: 'Put the constant prompt first for KV reuse / lower latency.' },
  { key: 'persistence', label: 'Persistent progress', help: 'Remember the student across sessions (on-device).' },
  { key: 'spacedRepetition', label: 'Spaced repetition', help: 'Revisit weak concepts over time.' },
];

export function SettingsPage() {
  const [flags, setLocal] = useState<FeatureFlags>(getFlags());
  const [modelId, setModel] = useState<string>(getSelectedModelId());
  const rec = recommendModel();

  function update(patch: Partial<FeatureFlags>) {
    setLocal(setFlags(patch));
  }

  return (
    <div className="evals">
      <h1>Settings</h1>
      <div className="sub">Every feature is an independent module. Toggle anything off if your device struggles — the rest keeps working. Model changes apply on reload.</div>

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

      <h2 className="bench-h2">Engine features</h2>
      <div className="settings-list">
        {TOGGLES.map((t) => (
          <label className="settings-row" key={t.key}>
            <input
              type="checkbox"
              checked={Boolean(flags[t.key])}
              onChange={(e) => update({ [t.key]: e.target.checked } as Partial<FeatureFlags>)}
            />
            <span>
              <b>{t.label}</b>
              <span className="settings-help">{t.help}</span>
            </span>
          </label>
        ))}
        <label className="settings-row">
          <input
            type="number"
            min={1}
            max={5}
            value={flags.bestOfN}
            onChange={(e) => update({ bestOfN: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })}
            style={{ width: 56 }}
          />
          <span>
            <b>Best-of-N candidates</b>
            <span className="settings-help">Generate N drafts; the verifier picks the first clean one (1 = off).</span>
          </span>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="run-btn" onClick={() => { setLocal(resetFlags()); }}>Reset features to defaults</button>
        <button className="run-btn" onClick={() => { clearAllProgress(); }}>Reset lesson progress</button>
      </div>
      <div className="settings-help" style={{ marginTop: 8 }}>
        Defaults: best-of-{DEFAULT_FLAGS.bestOfN}, structured/repair/exemplars on.
      </div>
    </div>
  );
}
