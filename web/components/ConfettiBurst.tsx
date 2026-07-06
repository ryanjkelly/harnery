"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One-shot confetti burst for the council "complete" moment (archived state).
 * Self-contained canvas animation — no deps, CSP-safe, ~2.6s then unmounts.
 *
 * Fires once per dedup key per tab (sessionStorage, mirroring the attention
 * ack pattern) so revisiting an archived council doesn't re-celebrate. Skips
 * entirely under prefers-reduced-motion.
 */
export function ConfettiBurst({ dedupKey }: { dedupKey: string }) {
  const [active, setActive] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const storageKey = `confetti:${dedupKey}`;
      if (sessionStorage.getItem(storageKey)) return;
      sessionStorage.setItem(storageKey, "1");
    } catch {
      /* storage unavailable → still celebrate, just maybe twice */
    }
    setActive(true);
  }, [dedupKey]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    // Existing state-colour grammar: emerald (done) leads, sky + amber accent.
    const colors = ["#34d399", "#10b981", "#38bdf8", "#fbbf24", "#a7f3d0"];
    const COUNT = 140;
    const particles = Array.from({ length: COUNT }, () => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = 7 + Math.random() * 9;
      return {
        x: w / 2 + (Math.random() - 0.5) * w * 0.2,
        y: h * 0.35,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 3 + Math.random() * 5,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        life: 1,
      };
    });

    const DURATION_MS = 2600;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = (now - start) / DURATION_MS;
      ctx.clearRect(0, 0, w, h);
      if (t >= 1) {
        setActive(false);
        return;
      }
      for (const p of particles) {
        p.vy += 0.22; // gravity
        p.vx *= 0.99; // drag
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life = 1 - t;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="fixed inset-0 z-[100] pointer-events-none"
      style={{ width: "100vw", height: "100vh" }}
    />
  );
}
