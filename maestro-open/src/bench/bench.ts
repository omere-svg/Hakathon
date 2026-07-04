// Standalone benchmark page (bench.html) — NOT part of the app. Compares the two
// on-device backends (WebLLM/WebGPU vs wllama/CPU-WASM) on REAL milestone-engine
// prompts, then POSTs the numbers to the dev server (vite.config.ts bench-report
// plugin) so an automated run can read finetune/work/bench/bench-results.json.
//
// Run: npm run dev, open http://localhost:5174/bench.html, wait for "DONE".

import { classifyPrompt, expandPrompt, suggestionsPrompt } from '../engine/milestone/prompts';
import { createWebLLMEngine } from '../llm/webllm';
import { createWllamaEngine } from '../llm/wllama';
import type { GenOptions, LLMEngine } from '../llm/types';

const el = document.getElementById('log')!;
function log(line: string) {
  el.textContent += `\n${line}`;
  console.log(`[bench] ${line}`);
  // Stream every line to disk too — the bench runs unattended, and a browser-only
  // error is otherwise invisible to the automation driving it.
  fetch('/__bench-report?mode=log', { method: 'POST', body: `${new Date().toISOString()} ${line}` }).catch(() => {});
}
window.addEventListener('error', (e) => log(`WINDOW ERROR: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log(`UNHANDLED REJECTION: ${(e.reason as Error)?.message ?? e.reason}`));

// Representative engine calls: a near-deterministic one-word judgment, a structured
// JSON generation, and a creative student-voice generation. Temperatures mirror the
// engine's per-scenario settings (structured 0.3, creative default).
const CASES: Array<{ name: string; system: string; user: string; opts: GenOptions }> = [
  (() => {
    const p = classifyPrompt('Python if/elif/else', 'Understand how boolean conditions decide which branch runs', 0, 2);
    return { name: 'classify (1-word judgment)', system: p.system, user: p.user, opts: { temperature: 0.3, maxTokens: 16 } };
  })(),
  (() => {
    const p = expandPrompt('Write and run a Python program that uses if/elif/else to grade a numeric score');
    return { name: 'expand (JSON decomposition)', system: p.system, user: p.user, opts: { temperature: 0.3, maxTokens: 280 } };
  })(),
  (() => {
    const p = suggestionsPrompt(
      'Great question! A boolean condition is just an expression that is either True or False — like score >= 90. What do you think happens if score is exactly 90?',
      'Boolean conditions',
    );
    return { name: 'suggestions (creative chips)', system: p.system, user: p.user, opts: {} };
  })(),
];

const ITERS = 2;

interface CallResult {
  case: string;
  iter: number;
  ms: number;
  chars: number;
  approxToksPerSec: number;
  output: string;
}

async function benchEngine(label: string, make: () => Promise<LLMEngine>): Promise<{
  label: string;
  loadMs: number;
  calls: CallResult[];
  error?: string;
}> {
  log(`— loading ${label} …`);
  const t0 = performance.now();
  let engine: LLMEngine;
  try {
    engine = await make();
  } catch (err) {
    log(`  LOAD FAILED: ${(err as Error).message}`);
    return { label, loadMs: -1, calls: [], error: String((err as Error).message) };
  }
  const loadMs = Math.round(performance.now() - t0);
  log(`  loaded in ${(loadMs / 1000).toFixed(1)}s`);
  const calls: CallResult[] = [];
  for (const c of CASES) {
    for (let i = 1; i <= ITERS; i++) {
      const s = performance.now();
      try {
        const out = await engine.complete(c.system, c.user, c.opts);
        const ms = Math.round(performance.now() - s);
        // chars/4 ≈ tokens — identical estimator on both engines keeps the comparison fair.
        const approx = out.length / 4 / (ms / 1000);
        calls.push({ case: c.name, iter: i, ms, chars: out.length, approxToksPerSec: Math.round(approx * 10) / 10, output: out.slice(0, 400) });
        log(`  ${c.name} #${i}: ${ms}ms, ${out.length} chars (~${approx.toFixed(1)} tok/s)`);
      } catch (err) {
        calls.push({ case: c.name, iter: i, ms: -1, chars: 0, approxToksPerSec: 0, output: `ERROR: ${(err as Error).message}` });
        log(`  ${c.name} #${i}: ERROR ${(err as Error).message}`);
      }
    }
  }
  try {
    await engine.unload?.();
  } catch {
    /* best-effort */
  }
  return { label, loadMs, calls };
}

async function main() {
  log(`crossOriginIsolated: ${String(crossOriginIsolated)} (multi-thread WASM ${crossOriginIsolated ? 'ON' : 'OFF — results not representative!'})`);
  log(`hardwareConcurrency: ${navigator.hardwareConcurrency}`);
  const results = {
    when: new Date().toISOString(),
    crossOriginIsolated,
    cores: navigator.hardwareConcurrency,
    ua: navigator.userAgent,
    engines: [] as unknown[],
  };
  // wllama first (CPU) so its memory is fully released before WebLLM grabs the GPU.
  // The fine-tuned GGUF runs too: this doubles as the in-browser smoke test for the
  // tuned build (fine-tuned models have crashed ONLY in-browser before — mlc-llm#2601).
  results.engines.push(await benchEngine('wllama · Qwen3-1.7B Q4_K_M stock (CPU/WASM)', () => createWllamaEngine((t) => log(`    ${t}`), 'Qwen3-1.7B-q4_k_m-GGUF')));
  results.engines.push(await benchEngine('wllama · Qwen3-1.7B Q4_K_M MAESTRO-TUNED (CPU/WASM)', () => createWllamaEngine((t) => log(`    ${t}`), 'Qwen3-1.7B-maestro-q4_k_m-GGUF')));
  results.engines.push(await benchEngine('WebLLM · Qwen3-1.7B q4f16_1 (WebGPU)', () => createWebLLMEngine((t) => log(`    ${t}`), 'Qwen3-1.7B-q4f16_1-MLC')));
  await fetch('/__bench-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(results, null, 2) });
  log('DONE — results POSTed to finetune/work/bench/bench-results.json');
  document.title = 'BENCH DONE';
}

// Gate on ?run=1 so hot-reloads of stray open tabs don't kick off duplicate runs
// (two racing tabs overwrite each other's results and contend for the GPU). The param
// is stripped once the run starts, so a source-edit hot-reload of THIS tab idles too
// instead of silently re-benchmarking and overwriting the results file.
if (new URLSearchParams(location.search).get('run') === '1') {
  history.replaceState(null, '', location.pathname);
  main().catch((err) => log(`FATAL: ${err?.message ?? err}`));
} else {
  el.textContent = 'idle — open bench.html?run=1 to start';
}
