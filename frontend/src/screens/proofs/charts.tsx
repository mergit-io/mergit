import { useId, useState } from "react";
import { useCountUp } from "../../hooks/useCountUp";
import { useWidth } from "../../hooks/useWidth";

/* ---------- Area chart: two series with a hover crosshair ---------- */

/**
 * The design's plot, scaled to fit its card. Below NARROW the scaled labels get
 * too small to read, so the chart redraws at its real width and PHONE_H tall.
 */
const DESIGN = { width: 1120, height: 228 };
const NARROW = 600;
const PHONE_H = 160;
const PAD = { left: 26, right: 0, top: 6, bottom: 22 };
const MAX = 120;

type Pt = readonly [x: number, y: number];
const line = (pts: readonly Pt[]) =>
  pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

export function RunsChart({ labels, runs, proofs }: { labels: string[]; runs: number[]; proofs: number[] }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [ref, measured] = useWidth<HTMLDivElement>(DESIGN.width);
  const narrow = measured < NARROW;
  const W = narrow ? measured : DESIGN.width;
  const H = narrow ? PHONE_H : DESIGN.height;
  const pathFor = (values: number[]) => {
    const gap = (W - PAD.left - PAD.right) / (values.length - 1);
    return values.map((v, i): Pt => [PAD.left + i * gap, PAD.top + (1 - v / MAX) * (H - PAD.top - PAD.bottom)]);
  };
  const area = (pts: readonly Pt[]) =>
    `${line(pts)} L${String(W - PAD.right)} ${String(H - PAD.bottom)} L${String(PAD.left)} ${String(H - PAD.bottom)} Z`;
  const a = pathFor(runs);
  const b = pathFor(proofs);
  const step = (W - PAD.left - PAD.right) / (runs.length - 1);
  const ticks = [0, 30, 60, 90, 120];

  const pick = (clientX: number, rect: DOMRect) => {
    const x = ((clientX - rect.left) / rect.width) * W;
    setHover(Math.max(0, Math.min(runs.length - 1, Math.round((x - PAD.left) / step))));
  };
  const hx = hover === null ? 0 : PAD.left + hover * step;
  const pa = hover === null ? undefined : a[hover];
  const pb = hover === null ? undefined : b[hover];

  return (
    <div className="pl-chart" ref={ref}>
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        role="img"
        aria-label={`Runs and settled proofs, hourly over the last 28 hours. Latest hour: ${String(runs.at(-1))} runs, ${String(proofs.at(-1))} proofs settled.`}
        onPointerMove={(e) => {
          pick(e.clientX, e.currentTarget.getBoundingClientRect());
        }}
        onPointerLeave={() => {
          setHover(null);
        }}
      >
        <defs>
          <linearGradient id={`${id}-a`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--chart-purple)" stopOpacity="0.2" />
            <stop offset="1" stopColor="var(--chart-purple)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={`${id}-b`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--chart-green)" stopOpacity="0.16" />
            <stop offset="1" stopColor="var(--chart-green)" stopOpacity="0.02" />
          </linearGradient>
          <clipPath id={`${id}-reveal`}>
            <rect className="pl-reveal" x="0" y="0" width={W} height={H} />
          </clipPath>
        </defs>
        {ticks.map((t) => {
          const y = PAD.top + (1 - t / MAX) * (H - PAD.top - PAD.bottom);
          return (
            <g key={t}>
              <line x1={PAD.left} x2={W} y1={y} y2={y} className="pl-grid" />
              <text x={0} y={y + 4} className="pl-axis">
                {t}
              </text>
            </g>
          );
        })}
        {[0, 4, 8, 12, 16, 20, 24].map((h) => (
          <text key={h} x={PAD.left + (h / 24) * (W - PAD.left)} y={H - 4} className="pl-axis" textAnchor="middle">
            {String(h).padStart(2, "0")}:00
          </text>
        ))}
        <g clipPath={`url(#${id}-reveal)`}>
          <path d={area(a)} fill={`url(#${id}-a)`} />
          <path d={area(b)} fill={`url(#${id}-b)`} />
          <path d={line(a)} className="pl-line" stroke="var(--chart-purple)" />
          <path d={line(b)} className="pl-line" stroke="var(--chart-green)" />
        </g>
        {pa && pb && (
          <g>
            <line x1={hx} x2={hx} y1={PAD.top} y2={H - PAD.bottom} className="pl-cross" />
            <circle cx={pa[0]} cy={pa[1]} r={6} className="pl-dot" stroke="var(--chart-purple)" />
            <circle cx={pb[0]} cy={pb[1]} r={6} className="pl-dot" stroke="var(--chart-green)" />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div
          className="pl-tip"
          role="status"
          style={{
            left: `${String((hx / W) * 100)}%`,
            transform: `translateX(${hover > runs.length / 2 ? "calc(-100% - 12px)" : "12px"})`,
          }}
        >
          <span className="pl-tip-time">Today {labels[hover]}</span>
          <span>Runs {runs[hover]}</span>
          <span className="pl-tip-proofs">Proofs settled {proofs[hover]}</span>
        </div>
      )}
    </div>
  );
}

/* ---------- Ring chart ---------- */

export function WorkRing({ parts, total }: { parts: { name: string; share: number; color: string }[]; total: number }) {
  const count = useCountUp(total, 2400);
  const r = 88;
  const c = 2 * Math.PI * r;
  // Each segment starts where the previous ones end.
  const starts = parts.map((_, i) => parts.slice(0, i).reduce((sum, q) => sum + (q.share / 100) * c, 0));
  return (
    <div className="pl-ring-wrap">
      <svg
        viewBox="0 0 220 220"
        className="pl-ring"
        role="img"
        aria-label={parts.map((p) => `${p.name} ${String(p.share)}%`).join(", ")}
      >
        <circle cx="110" cy="110" r={r} className="pl-ring-track" />
        {parts.map((p, i) => {
          const len = (p.share / 100) * c;
          return (
            <circle
              key={p.name}
              cx="110"
              cy="110"
              r={r}
              stroke={p.color}
              className="pl-ring-seg"
              strokeDasharray={`${String(len)} ${String(c - len)}`}
              strokeDashoffset={-(starts[i] ?? 0)}
              style={{ animationDelay: `${String(500 + i * 260)}ms` }}
            />
          );
        })}
      </svg>
      <div className="pl-ring-center" aria-hidden="true">
        <span className="pl-ring-count">{Math.round(count).toLocaleString("en-US")}</span>
        <span className="small c3">tasks</span>
      </div>
    </div>
  );
}
