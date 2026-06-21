"use client";

import { useEffect, useRef } from "react";

/**
 * Ethereal cursor→target flow lines, rendered while an attention alert is
 * live (mounted by AttentionProvider). A full-viewport canvas draws, for each
 * attention target on the page, a softly bowing guide curve from the mouse to
 * the target plus a stream of glowing particles drifting along it: "the thing
 * you're looking for is over THERE".
 *
 * Targets are discovered per frame from the DOM, generically:
 *   1. explicit `[data-attention-target]` markers (e.g. the round-complete
 *      banner's Advance link), then
 *   2. `.attention-ring` spotlights (the active prompt chip + Copy button),
 * capped at MAX_TARGETS. Pages opt in just by carrying those markers, with no
 * coupling to this component.
 *
 * Drawing starts after the first real mousemove (no fake anchor point),
 * pauses while the tab is hidden, skips targets the cursor is already on, and
 * honors prefers-reduced-motion by rendering nothing at all. Unmounts (= ack
 * or state resolved) tear down the rAF loop and listeners.
 */

const MAX_TARGETS = 3;
const PARTICLES_PER_TARGET = 12;
/** Don't draw a line to a target the cursor is effectively already on. */
const NEAR_PX = 56;

type Particle = {
  t: number;
  speed: number;
  size: number;
  wobbleAmp: number;
  wobbleFreq: number;
  phase: number;
};

function spawn(): Particle {
  return {
    t: Math.random() * 0.2,
    speed: 0.22 + Math.random() * 0.38,
    size: 0.8 + Math.random() * 1.6,
    wobbleAmp: 2 + Math.random() * 7,
    wobbleFreq: 4 + Math.random() * 6,
    phase: Math.random() * Math.PI * 2,
  };
}

export function AttentionFlow() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const mouse = { x: 0, y: 0, has: false };
    const pools = new Map<number, Particle[]>();
    let raf = 0;
    let last = performance.now();

    const resize = () => {
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
    };
    resize();

    const onMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.has = true;
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("resize", resize);

    const collectTargets = (): DOMRect[] => {
      const els: Element[] = [];
      const seen = new Set<Element>();
      for (const el of document.querySelectorAll(
        "[data-attention-target], .attention-ring",
      )) {
        if (seen.has(el)) continue;
        seen.add(el);
        els.push(el);
        if (els.length >= MAX_TARGETS) break;
      }
      return els
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (!mouse.has || document.hidden) return;

      const rects = collectTargets();
      rects.forEach((rect, i) => {
        const ax = rect.left + rect.width / 2;
        const ay = rect.top + rect.height / 2;
        const dx = ax - mouse.x;
        const dy = ay - mouse.y;
        const dist = Math.hypot(dx, dy);
        if (dist < NEAR_PX) return;

        // Quadratic bezier from cursor to target, bowed perpendicular to the
        // straight line; the bow sways slowly so the path feels alive.
        const px = -dy / dist;
        const py = dx / dist;
        const bow =
          Math.min(dist * 0.22, 120) * Math.sin(now / 1700 + i * 1.9);
        const cx = (mouse.x + ax) / 2 + px * bow;
        const cy = (mouse.y + ay) / 2 + py * bow;
        const q = (t: number) => {
          const u = 1 - t;
          return {
            x: u * u * mouse.x + 2 * u * t * cx + t * t * ax,
            y: u * u * mouse.y + 2 * u * t * cy + t * t * ay,
          };
        };

        // Guide stroke: wide soft halo + thin core, brightening toward the
        // target and faded at both ends.
        const grad = ctx.createLinearGradient(mouse.x, mouse.y, ax, ay);
        grad.addColorStop(0, "rgba(56, 189, 248, 0)");
        grad.addColorStop(0.18, "rgba(56, 189, 248, 0.10)");
        grad.addColorStop(0.55, "rgba(56, 189, 248, 0.22)");
        grad.addColorStop(0.92, "rgba(56, 189, 248, 0.34)");
        grad.addColorStop(1, "rgba(56, 189, 248, 0)");
        ctx.lineCap = "round";
        ctx.strokeStyle = grad;
        for (const [width, alpha] of [
          [5, 0.35],
          [1.25, 1],
        ] as const) {
          ctx.beginPath();
          ctx.moveTo(mouse.x, mouse.y);
          ctx.quadraticCurveTo(cx, cy, ax, ay);
          ctx.globalAlpha = alpha;
          ctx.lineWidth = width;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Particles drifting cursor → target, tapering in/out at the ends.
        const pool = pools.get(i) ?? [];
        while (pool.length < PARTICLES_PER_TARGET) pool.push(spawn());
        pools.set(i, pool);
        for (const p of pool) {
          p.t += p.speed * dt;
          if (p.t >= 1) Object.assign(p, spawn(), { t: 0 });
          const pos = q(p.t);
          const taper = Math.sin(Math.PI * p.t);
          const wobble =
            Math.sin(p.t * p.wobbleFreq + p.phase + now / 900) *
            p.wobbleAmp *
            taper;
          const alpha = 0.12 + 0.55 * taper;
          ctx.beginPath();
          ctx.arc(
            pos.x + px * wobble,
            pos.y + py * wobble,
            p.size * (0.6 + 0.6 * taper),
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = `rgba(165, 224, 252, ${alpha.toFixed(3)})`;
          ctx.shadowColor = "rgba(56, 189, 248, 0.8)";
          ctx.shadowBlur = 10;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      });
      for (const k of [...pools.keys()]) {
        if (k >= rects.length) pools.delete(k);
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="attention-flow" />;
}
