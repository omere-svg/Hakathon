import { useEffect, useRef, useState } from 'react';

// Dino runner for the two dead-time phases (model download + first decomposition) — see
// knowledge base 05-research/loading-game-engagement.md. Design constraints from that doc:
// bundled and dependency-free (an iframed remote game would contradict the "runs offline on
// your device" pitch — and a dino IS the offline game), drawn entirely in code (assets would
// add their own loading wait), an overlay not a gate (the parent unmounts it the moment the
// lesson is ready), and a Skip affordance so nobody is forced to play.
//
// Input: Space / ArrowUp / click / tap to jump. Score = distance survived. Collision just
// restarts after a beat — no persistence, no leaderboard, cheap to abandon.

const W = 560;
const H = 150;
const GROUND_Y = H - 24;
const DINO_X = 52;
const DINO_W = 22;
const DINO_H = 30;
const GRAVITY = 1900; // px/s²
const JUMP_VY = -640; // px/s
const BASE_SPEED = 240; // px/s, ramps up slowly
const FG = '#9aa0b4'; // matches --text-muted
const ACCENT = '#7479f0'; // matches --accent

interface Cactus {
  x: number;
  w: number;
  h: number;
}

export function LoadingGame({ note }: { note: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [best, setBest] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Crisp on retina: render at devicePixelRatio, draw in logical units.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    let y = GROUND_Y - DINO_H;
    let vy = 0;
    let cacti: Cactus[] = [];
    let nextSpawn = 0.9; // seconds until the next cactus
    let score = 0;
    let dead = false;
    let deadUntil = 0; // timestamp when a restart is allowed
    let last = performance.now();
    let raf = 0;

    const reset = () => {
      y = GROUND_Y - DINO_H;
      vy = 0;
      cacti = [];
      nextSpawn = 0.9;
      score = 0;
      dead = false;
    };

    const jump = () => {
      if (dead) {
        if (performance.now() >= deadUntil) reset();
        return;
      }
      if (y >= GROUND_Y - DINO_H - 0.5) vy = JUMP_VY;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        jump();
      }
    };
    const onTap = (e: Event) => {
      e.preventDefault();
      jump();
    };
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('pointerdown', onTap);

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05); // clamp: background tabs jump time
      last = now;
      const speed = BASE_SPEED + Math.min(score / 18, 160); // gentle ramp

      if (!dead) {
        score += dt * 10;
        vy += GRAVITY * dt;
        y = Math.min(y + vy * dt, GROUND_Y - DINO_H);

        nextSpawn -= dt;
        if (nextSpawn <= 0) {
          const h = 18 + Math.floor(((score * 7919) % 100) / 100 * 20); // deterministic-ish variety
          cacti.push({ x: W + 20, w: 12 + (h % 8), h });
          nextSpawn = 0.9 + ((score * 31) % 100) / 100 * 0.9; // 0.9–1.8s apart
        }
        for (const c of cacti) c.x -= speed * dt;
        cacti = cacti.filter((c) => c.x + c.w > -10);

        // Collision (slightly forgiving box).
        for (const c of cacti) {
          const hitX = DINO_X + DINO_W - 4 > c.x && DINO_X + 4 < c.x + c.w;
          const hitY = y + DINO_H > GROUND_Y - c.h + 3;
          if (hitX && hitY) {
            dead = true;
            deadUntil = now + 450; // ignore panic-taps right after dying
            setBest((b) => Math.max(b, Math.floor(score)));
            break;
          }
        }
      }

      // ── draw ──
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(154, 160, 180, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y + 0.5);
      ctx.lineTo(W, GROUND_Y + 0.5);
      ctx.stroke();

      // dino: body, eye, legs
      ctx.fillStyle = ACCENT;
      ctx.fillRect(DINO_X, y, DINO_W, DINO_H - 6);
      ctx.fillRect(DINO_X + DINO_W - 10, y - 8, 14, 12); // head
      const legPhase = Math.floor(score * 6) % 2 === 0;
      ctx.fillRect(DINO_X + 2, y + DINO_H - 6, 5, legPhase && !dead ? 6 : 4);
      ctx.fillRect(DINO_X + DINO_W - 7, y + DINO_H - 6, 5, legPhase || dead ? 4 : 6);
      ctx.fillStyle = '#0e0e10';
      ctx.fillRect(DINO_X + DINO_W - 2, y - 5, 3, 3); // eye

      ctx.fillStyle = FG;
      for (const c of cacti) ctx.fillRect(c.x, GROUND_Y - c.h, c.w, c.h);

      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.floor(score)}`, W - 10, 18);

      if (dead) {
        ctx.textAlign = 'center';
        ctx.fillStyle = FG;
        ctx.font = '600 14px system-ui, sans-serif';
        ctx.fillText('Oof — tap or press space to run again', W / 2, H / 2 - 8);
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onTap);
    };
  }, []);

  return (
    <div className="loading-game" role="status" aria-label="Loading — play while you wait">
      <div className="loading-game-head">
        <span>While your tutor warms up… jump the cacti 🌵</span>
        {best > 0 && <span className="loading-game-best">best {best}</span>}
      </div>
      <canvas ref={canvasRef} style={{ width: '100%', maxWidth: W, height: 'auto', aspectRatio: `${W} / ${H}`, touchAction: 'none' }} />
      <div className="loading-game-note">{note}</div>
    </div>
  );
}
