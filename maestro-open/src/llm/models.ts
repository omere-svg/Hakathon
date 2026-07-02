// Model catalog + device-tier picker. The picker maps real device signals to the
// largest model we're confident will run, and the load-time step-down (engine.ts) is
// the safety net if we guess too high. See 05-research/mobile-device-strategy.md and
// local-models-comparison.md for the reasoning behind the signals used here.
//
// Why signals + step-down (not just signals): WebGPU deliberately does NOT expose total
// or available VRAM (it's a fingerprinting vector), navigator.deviceMemory is Chromium-
// only / rounded / capped at 8 / undefined on Safari-iOS, and hardwareConcurrency is
// capped (2 on iOS). So no signal is reliable alone — we pick conservatively from what we
// can read, then attempt-load and step down a tier on an out-of-memory / device-lost error.

export type ModelTier = 'floor' | 'low' | 'mid' | 'high';

export interface ModelOption {
  id: string;
  label: string;
  approxGB: number; // download / VRAM footprint of the q4f16_1 build (~ WebLLM's vram_required)
  tier: ModelTier;
  note: string;
}

// Ordered smallest → largest. The Qwen3 family is the spine (best small-model instruction-
// following + free-text JSON in the WebLLM registry, 2026); Qwen2.5-0.5B is kept only as an
// ultra-safe floor for old/weak devices and as the bottom rung for the step-down.
export const MODELS: ModelOption[] = [
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Ultra-light (0.5B)', approxGB: 0.95, tier: 'floor', note: 'Safest floor for old / very weak phones.' },
  { id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Fast (0.6B)', approxGB: 1.4, tier: 'low', note: 'Runs on most phones; new-gen small model.' },
  { id: 'Qwen3-1.7B-q4f16_1-MLC', label: 'Balanced (1.7B)', approxGB: 2.0, tier: 'mid', note: 'Recommended default — ~3B-class quality at a phone footprint.' },
  { id: 'Qwen3-4B-q4f16_1-MLC', label: 'Smart (4B)', approxGB: 3.4, tier: 'high', note: 'Best quality; laptops / strong phones.' },
];

// Ordering for step-down and tier lookup (smallest → largest).
const SIZE_ORDER: ModelTier[] = ['floor', 'low', 'mid', 'high'];

export const DEFAULT_MODEL_ID = 'Qwen3-1.7B-q4f16_1-MLC';

// During `npm run dev`, pin the model to the average-student device (1.7B) so what we feel
// while developing matches what a typical student feels. This overrides device auto-detect
// AND any Settings pick. Production builds keep the real device-based auto-pick.
export const DEV_STUDENT_MODEL_ID = DEFAULT_MODEL_ID;

export function modelById(id: string): ModelOption | undefined {
  return MODELS.find((m) => m.id === id);
}

function byTier(tier: ModelTier): ModelOption {
  return MODELS.find((m) => m.tier === tier) ?? MODELS[0];
}

/** The next-smaller model in the catalog, or undefined if already at the floor. Used by
 *  the engine's load-time step-down when a model OOMs on the device. */
export function smallerModelId(id: string): string | undefined {
  const m = modelById(id);
  if (!m) return undefined;
  const idx = SIZE_ORDER.indexOf(m.tier);
  if (idx <= 0) return undefined;
  return byTier(SIZE_ORDER[idx - 1]).id;
}

// ── Device probing ────────────────────────────────────────────────────────────────

/** Best-effort snapshot of what we can learn about the device. Every field is optional
 *  because each underlying API is unavailable on some browser (see file header). */
export interface DeviceProbe {
  webgpu: boolean;
  deviceMemoryGB?: number; // navigator.deviceMemory — Chromium only, rounded, capped at 8
  cores?: number; // navigator.hardwareConcurrency — capped (2 on iOS, 8 on macOS Safari)
  maxBufferMB?: number; // WebGPU adapter maxBufferSize (tiered, not exact)
  maxStorageBufferMB?: number; // WebGPU adapter maxStorageBufferBindingSize (tiered)
  isIOS: boolean;
  isSafari: boolean;
}

function detectIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iP(hone|ad|od)/.test(ua)) return true;
  // iPadOS 13+ reports a desktop-Mac UA; disambiguate by touch support.
  return /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
}

function detectSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/.test(ua);
}

// Minimal structural types for the WebGPU bits we read (@webgpu/types isn't a dependency).
type AdapterLimits = { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
type Adapter = { limits?: AdapterLimits };
type GpuLike = { requestAdapter(): Promise<Adapter | null> };

/** Probe the device: read memory/CPU hints and, if WebGPU is present, the adapter limits.
 *  Never throws; returns webgpu:false when the API is missing or no adapter is granted. */
export async function probeDevice(): Promise<DeviceProbe> {
  const nav = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { deviceMemory?: number; gpu?: GpuLike })
    : undefined;
  const deviceMemoryGB = typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : undefined;
  const cores = typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined;
  const isIOS = detectIOS();
  const isSafari = detectSafari();

  let webgpu = false;
  let maxBufferMB: number | undefined;
  let maxStorageBufferMB: number | undefined;
  const gpu = nav?.gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        webgpu = true;
        const lim = adapter.limits;
        if (lim?.maxBufferSize) maxBufferMB = lim.maxBufferSize / (1024 * 1024);
        if (lim?.maxStorageBufferBindingSize) maxStorageBufferMB = lim.maxStorageBufferBindingSize / (1024 * 1024);
      }
    } catch {
      // gpu object present but adapter request failed — treat as best-effort available.
      webgpu = true;
    }
  }
  return { webgpu, deviceMemoryGB, cores, maxBufferMB, maxStorageBufferMB, isIOS, isSafari };
}

/** Pure device → model policy (testable). Chooses the largest model we're confident fits.
 *  Conservative by design: memory is the hard wall (a too-big model crashes the tab, a too-
 *  small one is merely weaker), and the engine step-down recovers from an over-optimistic pick. */
export function pickModel(p: DeviceProbe): ModelOption {
  const floor = byTier('floor');
  const low = byTier('low');
  const mid = byTier('mid');
  const high = byTier('high');

  // iOS / iPadOS: strict Metal per-buffer caps + aggressive tab kills. Never go high; drop
  // to the floor when the buffer ceiling looks like an older iPhone (~256–512 MB).
  if (p.isIOS) {
    if (p.maxStorageBufferMB !== undefined && p.maxStorageBufferMB < 512) return floor;
    if (p.maxBufferMB !== undefined && p.maxBufferMB >= 1500) return mid; // iPad Pro / recent iPhone
    return low;
  }

  // Estimate a usable budget (GB). Prefer deviceMemory; else infer a tier from the WebGPU
  // buffer ceiling; else assume a modest device. Integrated GPUs share system RAM, so
  // deviceMemory is a reasonable proxy for the on-device budget on phones/laptops.
  let budgetGB: number;
  if (p.deviceMemoryGB !== undefined) budgetGB = p.deviceMemoryGB;
  else if (p.maxBufferMB !== undefined) budgetGB = p.maxBufferMB >= 2000 ? 8 : p.maxBufferMB >= 1000 ? 6 : 4;
  else budgetGB = 6; // unknown (e.g. Firefox desktop) → balanced-conservative

  // A model needs its footprint plus headroom for the KV cache + browser/OS. Require ~1.6×.
  const HEADROOM = 1.6;
  const fits = (m: ModelOption) => m.approxGB * HEADROOM <= budgetGB;

  for (const m of [high, mid, low, floor]) if (fits(m)) return m;
  return floor;
}

/** Async recommendation: probe the device, then apply the pure policy. */
export async function recommendModelAsync(): Promise<ModelOption> {
  return pickModel(await probeDevice());
}

/** Synchronous, coarse recommendation for immediate UI (no adapter probe). Prefer
 *  recommendModelAsync() where an await is possible. */
export function recommendModel(): ModelOption {
  const mem = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  if (detectIOS()) return byTier('low');
  if (typeof mem !== 'number') return byTier('mid'); // unknown (Safari/Firefox) → balanced
  if (mem >= 8) return byTier('high');
  if (mem >= 6) return byTier('mid');
  if (mem >= 4) return byTier('low');
  return byTier('floor');
}

// ── Selection persistence ───────────────────────────────────────────────────────────

const KEY = 'maestro.model.v1';

function savedModelId(): string | undefined {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(KEY);
      if (raw && modelById(raw)) return raw;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Synchronous selected model: DEV pin → saved pick → coarse recommendation. Used by UI
 *  that can't await. The engine uses resolveModelId() for the probe-backed pick. */
export function getSelectedModelId(): string {
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) return DEV_STUDENT_MODEL_ID;
  return savedModelId() ?? recommendModel().id;
}

/** Probe-backed model resolution for the engine: DEV pin → saved pick → async device
 *  recommendation (falls back to the coarse sync pick if the probe fails). */
export async function resolveModelId(): Promise<string> {
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) return DEV_STUDENT_MODEL_ID;
  const saved = savedModelId();
  if (saved) return saved;
  try {
    return (await recommendModelAsync()).id;
  } catch {
    return recommendModel().id;
  }
}

export function setSelectedModelId(id: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
}
