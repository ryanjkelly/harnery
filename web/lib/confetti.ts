/**
 * Side-cannon confetti burst — fires when a council CLOSES (deliberation
 * complete, the actual accomplishment). The pre-extraction original (host repo
 * `a82d27bdc`, dropped in the agents-coord → Harnery migration, rediscovered
 * 2026-07-06) fired on archive; operator feedback the same day moved it to
 * close — archive is housekeeping, not the win. Two cannons angle inward from
 * the bottom corners for ~800ms of fire, ~3s of fall. The original used the
 * `canvas-confetti` package; this replicates its side-cannon config
 * dependency-free so harnery's web app stays lean.
 *
 * The canvas is appended imperatively to `document.body` (exactly why the
 * original survived the React re-render that follows `router.refresh()` — the
 * confetti keeps falling while the archived-state banner swaps in). Removes
 * itself when the last particle dies. No-ops under prefers-reduced-motion.
 */

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rot: number;
  vr: number;
  born: number;
};

const COLORS = ["#10b981", "#34d399", "#6ee7b7", "#a7f3d0", "#fef3c7"];
const CANNON_MS = 800; // how long the cannons keep firing
const LIFE_MS = 3000; // per-particle fall time
const PER_FRAME_PER_CANNON = 4;

export function fireCouncilConfetti(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch {
    /* matchMedia unavailable → celebrate anyway */
  }

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText =
    "position:fixed;inset:0;z-index:100;pointer-events:none;width:100vw;height:100vh";
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  document.body.appendChild(canvas);

  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const particles: Particle[] = [];
  const start = performance.now();

  // Mirrors canvas-confetti's {angle, spread, startVelocity} shot shape:
  // base angle 60° (left cannon, aiming up-right) / 120° (right cannon,
  // up-left), ±spread/2 jitter, origin at the bottom corners.
  const spawn = (now: number, originX: number, baseAngleDeg: number) => {
    for (let i = 0; i < PER_FRAME_PER_CANNON; i++) {
      const angle =
        ((baseAngleDeg + (Math.random() - 0.5) * 55) * Math.PI) / 180;
      const velocity = (60 * (0.75 + Math.random() * 0.5)) / 3.2;
      particles.push({
        x: originX * w,
        y: h,
        vx: Math.cos(angle) * velocity * (originX === 0 ? 1 : -1),
        vy: -Math.sin(angle) * velocity,
        size: 4 + Math.random() * 5,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        born: now,
      });
    }
  };

  let raf = 0;
  const tick = (now: number) => {
    ctx.clearRect(0, 0, w, h);
    if (now - start < CANNON_MS) {
      spawn(now, 0, 60);
      spawn(now, 1, 60);
    }
    let alive = 0;
    for (const p of particles) {
      const age = now - p.born;
      if (age > LIFE_MS) continue;
      alive++;
      p.vy += 0.18; // gravity
      p.vx *= 0.992; // drag
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - age / LIFE_MS);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (alive > 0 || now - start < CANNON_MS) {
      raf = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(raf);
      canvas.remove();
    }
  };
  raf = requestAnimationFrame(tick);
}
