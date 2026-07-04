import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Repo root (parent of maestro-open) — so we can `?raw`-import the Maestro course reference
// markdown that lives in the sibling maestro-pocket-hackathon-knowledge-base/ folder.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Dev-only sink for the bench harness (bench.html): it POSTs its JSON results here so an
// automated run can read them from disk instead of scraping the browser console.
function benchReportPlugin(): Plugin {
  return {
    name: 'bench-report',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__bench-report', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const dir = join(repoRoot, 'finetune', 'work', 'bench');
          mkdirSync(dir, { recursive: true });
          // ?mode=log → append a progress/error line; default → final results JSON.
          if ((req.url ?? '').includes('mode=log')) {
            appendFileSync(join(dir, 'bench-progress.log'), body + '\n');
          } else {
            writeFileSync(join(dir, 'bench-results.json'), body);
          }
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// WebLLM is heavy; it is dynamically imported at runtime (see src/tutor/webllmTutor.ts)
// so the initial bundle stays small and the app builds/runs even without WebGPU.
export default defineConfig({
  plugins: [react(), benchReportPlugin()],
  // Pin the dev server to a fixed port so the URL never drifts (Vite otherwise
  // auto-increments when the port is taken, which orphans open browser tabs).
  // strictPort makes startup fail loudly if 5174 is busy instead of silently moving.
  // fs.allow lets the dev server read the course-reference markdown one level up.
  // COOP/COEP: cross-origin isolation enables SharedArrayBuffer, which the wllama
  // (llama.cpp WASM) backend needs for multi-threaded decoding. `credentialless` (not
  // `require-corp`) so WebLLM's anonymous cross-origin model fetches from the HF CDN
  // keep working in Chromium. Production hosting needs the same two headers.
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: [repoRoot] },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});
