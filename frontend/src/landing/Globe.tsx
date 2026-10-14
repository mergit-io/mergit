import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "./motion";

const POINTS = 760;
const TILT = -0.38;
/** Radians per millisecond. One clock for every globe, so the intro hands off seamlessly. */
const SPIN = 0.00011;
const ASSEMBLE_MS = 1700;
const ARC_STEPS = 28;
/** Radians. Pairs further apart than this get no arc. */
const MAX_ARC = 1.7;
const GREEN = "36, 135, 95";
const PURPLE = "124, 107, 235";

type Vec = [x: number, y: number, z: number];

/** Evenly spread points on a unit sphere (Fibonacci lattice). */
const sphere: Vec[] = Array.from({ length: POINTS }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / POINTS;
  const r = Math.sqrt(1 - y * y);
  const theta = i * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(theta) * r, y, Math.sin(theta) * r];
});

/** Glowing nodes, alternating green and purple, a few of them labelled with a hash. */
const nodes = [11, 58, 97, 143, 188, 231, 274, 322, 367, 409, 455, 498, 541, 590].map((index, k) => ({
  index,
  color: k % 2 ? PURPLE : GREEN,
}));
const arcs: [number, number][] = [
  [0, 2],
  [2, 5],
  [5, 9],
  [9, 12],
  [3, 7],
  [7, 10],
  [1, 4],
  [4, 8],
  [8, 11],
  [6, 13],
  [11, 13],
];

function project([x, y, z]: Vec, angle: number): Vec {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x1 = x * cos + z * sin;
  const z1 = -x * sin + z * cos;
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);
  return [x1, y * cosT - z1 * sinT, y * sinT + z1 * cosT];
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function frontmost(screen: { z: number }[], ...candidates: ((typeof nodes)[number] | undefined)[]) {
  let best: (typeof nodes)[number] | undefined;
  for (const c of candidates) {
    if (c && (!best || (screen[c.index]?.z ?? -1) > (screen[best.index]?.z ?? -1))) best = c;
  }
  return best;
}

export function Globe({
  className,
  assemble = false,
  labels = [],
  label,
}: {
  className?: string;
  /** Fly the points in from a scatter before spinning (intro). */
  assemble?: boolean;
  /** Hash labels that pop in next to the first few nodes. */
  labels?: readonly string[];
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = prefersReducedMotion();
    const scatter = sphere.map(() => [Math.random() * 2 - 1, Math.random() * 2 - 1] as const);
    const born = performance.now();
    let width = 0;
    let height = 0;
    let dot = "60, 52, 120";
    let mono = "monospace";
    let raf = 0;
    let visible = true;

    const readStyle = () => {
      const style = getComputedStyle(canvas);
      dot = style.getPropertyValue("--l-dot").trim() || dot;
      mono = style.getPropertyValue("--l-mono").trim() || mono;
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (now: number) => {
      const t = reduced ? 1 : assemble ? Math.min(1, (now - born) / ASSEMBLE_MS) : 1;
      const k = easeOut(t);
      const angle = reduced ? 0.6 : now * SPIN;
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * 0.46;
      ctx.clearRect(0, 0, width, height);

      const screen = sphere.map((p, i) => {
        const [x, y, z] = project(p, angle);
        const s = scatter[i] ?? [0, 0];
        return {
          x: cx + (x * radius * k + s[0] * width * 0.55 * (1 - k)),
          y: cy + (y * radius * k + s[1] * height * 0.55 * (1 - k)),
          z,
        };
      });

      // Arcs between glowing nodes: great circles lifted a little off the surface,
      // so they hug the sphere's edge as it turns. Only the front half is drawn.
      if (k > 0.85) {
        const fade = Math.min(1, (k - 0.85) * 6.6);
        ctx.lineWidth = 1;
        for (const [a, b] of arcs) {
          const na = nodes[a];
          const nb = nodes[b];
          const pa = na ? sphere[na.index] : undefined;
          const pb = nb ? sphere[nb.index] : undefined;
          if (!pa || !pb) continue;
          const dot3 = Math.max(-1, Math.min(1, pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2]));
          const omega = Math.acos(dot3);
          // Skip near-identical and very distant pairs; long arcs would leave the sphere.
          if (omega < 1e-3 || omega > MAX_ARC) continue;
          ctx.beginPath();
          let drawing = false;
          for (let step = 0; step <= ARC_STEPS; step++) {
            const t = step / ARC_STEPS;
            const wa = Math.sin((1 - t) * omega) / Math.sin(omega);
            const wb = Math.sin(t * omega) / Math.sin(omega);
            const lift = 1 + 0.05 * Math.sin(Math.PI * t);
            const [x, y, z] = project(
              [(pa[0] * wa + pb[0] * wb) * lift, (pa[1] * wa + pb[1] * wb) * lift, (pa[2] * wa + pb[2] * wb) * lift],
              angle,
            );
            const sx = cx + x * radius;
            const sy = cy + y * radius;
            if (z < -0.05) {
              drawing = false;
              continue;
            }
            if (drawing) ctx.lineTo(sx, sy);
            else ctx.moveTo(sx, sy);
            drawing = true;
          }
          ctx.strokeStyle = `rgba(${PURPLE}, ${String(0.32 * fade)})`;
          ctx.stroke();
        }
      }

      for (const p of screen) {
        const depth = (p.z + 1) / 2;
        ctx.fillStyle = `rgba(${dot}, ${String((0.34 + 0.66 * depth) * Math.min(1, k * 1.4))})`;
        const size = 1.3 + depth * 1.4;
        ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      }

      nodes.forEach((n, i) => {
        const p = screen[n.index];
        if (!p || p.z < -0.35) return;
        const depth = (p.z + 1) / 2;
        const pulse = reduced ? 1 : 0.75 + 0.25 * Math.sin(now / 600 + i);
        ctx.fillStyle = `rgba(${n.color}, ${String(0.26 * depth * pulse * k)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 9 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(${n.color}, ${String((0.45 + 0.5 * depth) * k)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2);
        ctx.fill();
      });

      // Hash labels: each shows for a while, on a stagger, when its node faces us.
      labels.forEach((text, i) => {
        // Each label rides on two nodes on opposite sides; it sits on whichever faces us.
        const n = frontmost(screen, nodes[i * 2], nodes[i * 2 + 7]);
        const p = n ? screen[n.index] : undefined;
        if (!p || p.z < 0.1 || k < 1) return;
        const phase = reduced ? 1 : ((now - born) / 1000 + i * 1.3) % 5.2;
        const alpha = phase < 0.4 ? phase / 0.4 : phase < 3.6 ? 1 : Math.max(0, 1 - (phase - 3.6) / 0.4);
        if (alpha <= 0) return;
        ctx.font = `500 11px ${mono}`;
        ctx.fillStyle = `rgba(${dot}, ${String(0.85 * alpha)})`;
        ctx.fillText(text, p.x + 9, p.y - 6);
      });
    };

    const loop = (now: number) => {
      if (visible && !document.hidden) draw(now);
      if (!reduced) raf = requestAnimationFrame(loop);
    };

    readStyle();
    resize();
    draw(performance.now());
    if (!reduced) raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    io.observe(canvas);
    // Dot colour follows the theme.
    const mo = new MutationObserver(() => {
      readStyle();
      draw(performance.now());
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
    };
  }, [assemble, labels]);

  return <canvas ref={canvasRef} className={className} role="img" aria-label={label} />;
}
