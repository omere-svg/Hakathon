import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Repo root (parent of maestro-open) — so we can `?raw`-import the Maestro course reference
// markdown that lives in the sibling maestro-pocket-hackathon-knowledge-base/ folder.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// WebLLM is heavy; it is dynamically imported at runtime (see src/tutor/webllmTutor.ts)
// so the initial bundle stays small and the app builds/runs even without WebGPU.
export default defineConfig({
  plugins: [react()],
  // Pin the dev server to a fixed port so the URL never drifts (Vite otherwise
  // auto-increments when the port is taken, which orphans open browser tabs).
  // strictPort makes startup fail loudly if 5174 is busy instead of silently moving.
  // fs.allow lets the dev server read the course-reference markdown one level up.
  server: { port: 5174, strictPort: true, fs: { allow: [repoRoot] } },
});
