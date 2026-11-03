import { useId, useState } from "react";
import { useCountUp } from "../../hooks/useCountUp";
import { useWidth } from "../../hooks/useWidth";
import { niceMax } from "./analytics";
import "../../styles/screens/overview.css";
import "../../styles/screens/ledger.css";
import "../../styles/screens/live-charts.css";

/**
 * Charts for the live dashboard. They take real series only and always draw their frame (grid, axes, empty bars,
 * the ring's track), so an account with nothing yet still sees what each chart will show, and every chart animates
 * in either way. Styles are the proof ledger's (ledger.css) plus a few `lc-` rules in live-charts.css.
 */

type Pt = readonly [x: number, y: number];
const line = (pts: readonly Pt[]) =>
  pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

export type Series = { name: string; values: number[]; color: string };

const PAD = { left: 28, right: 6, top: 8, bottom: 22 };

/** Two or more series over the same labels, with a hover crosshair. Redraws at its real width. */
export function AreaTrend({
  labels,
  series,
  height = 220,
  label,
  empty,
}: {
  labels: string[];
  series: Series[];
  height?: number;
  label: string;
  /** Shown over the flat lines while every value is zero. */
  empty: string;
}) {
  const id = useId();
  const [ref, W] = useWidth<HTMLDivElement>(640);
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const n = labels.length;
  const step = (W - PAD.left - PAD.right) / Math.max(1, n - 1);
  const yOf = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  const pts = (values: number[]) => values.map((v, i): Pt => [PAD.left + i * step, yOf(v)]);
  const base = H - PAD.bottom;
  const area = (p: readonly Pt[]) =>
    `${line(p)} L${(PAD.left + (n - 1) * step).toFixed(1)} ${String(base)} L${String(PAD.left)} ${String(base)} Z`;
  const ticks = [0, 1, 2, 3, 4].map((k) => (max / 4) * k);
  // Label every day on a wide chart, fewer as it narrows, always including the last.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 70))));
  const isEmpty = series.every((s) => s.values.every((v) => v === 0));
  const hx = hover === null ? 0 : PAD.left + hover * step;

  return (
    <div className="pl-chart lc-area" ref={ref}>
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        height={H}
        role="img"
        aria-label={`${label}. ${series
          .map((s) => `${s.name}: ${String(s.values.reduce((a, b) => a + b, 0))} in total`)
          .join(", ")}.`}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * W;
          setHover(Math.max(0, Math.min(n - 1, Math.round((x - PAD.left) / step))));
        }}
        onPointerLeave={() => {
          setHover(null);
        }}
      >
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.name} id={`${id}-g${String(i)}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity="0.2" />
              <stop offset="1" stopColor={s.color} stopOpacity="0.02" />
            </linearGradient>
          ))}
          <clipPath id={`${id}-reveal`}>
            <rect className="pl-reveal" x="0" y="0" width={W} height={H} />
          </clipPath>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={yOf(t)} y2={yOf(t)} className="pl-grid" />
            <text x={0} y={yOf(t) + 4} className="pl-axis">
              {Number.isInteger(t) ? t : t.toFixed(1)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          (n - 1 - i) % every === 0 ? (
            <text key={`${l}-${String(i)}`} x={PAD.left + i * step} y={H - 4} className="pl-axis" textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
        <g clipPath={`url(#${id}-reveal)`}>
          {series.map((s, i) => (
            <path key={`a-${s.name}`} d={area(pts(s.values))} fill={`url(#${id}-g${String(i)})`} />
          ))}
          {series.map((s) => (
            <path key={`l-${s.name}`} d={line(pts(s.values))} className="pl-line" stroke={s.color} />
          ))}
        </g>
        {hover !== null && (
          <g>
            <line x1={hx} x2={hx} y1={PAD.top} y2={base} className="pl-cross" />
            {series.map((s) => (
              <circle key={s.name} cx={hx} cy={yOf(s.values[hover] ?? 0)} r={5} className="pl-dot" stroke={s.color} />
            ))}
          </g>
        )}
      </svg>
      {isEmpty && <p className="lc-empty small c3">{empty}</p>}
      {hover !== null && (
        <div
          className="pl-tip"
          role="status"
          style={{
            left: `${String((hx / W) * 100)}%`,
            transform: `translateX(${hover > n / 2 ? "calc(-100% - 12px)" : "12px"})`,
          }}
        >
          <span className="pl-tip-time">{labels[hover]}</span>
          {series.map((s) => (
            <span key={s.name}>
              {s.name} {s.values[hover] ?? 0}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export type Bar = { name: string; color: string };

/**
 * Grouped bars per day, like the design's task activity chart. A zero still draws a faint stub, so an empty week
 * shows its seven days rather than a blank box.
 */
export function DayBars({
  days,
  bars,
  values,
  caption,
  empty,
}: {
  days: { day: string; date: string }[];
  bars: Bar[];
  /** `values[day][bar]`. */
  values: number[][];
  caption: string;
  /** Shown over the stubs while every value is zero. */
  empty?: string;
}) {
  const max = Math.max(1, ...values.flat());
  const isEmpty = values.every((row) => row.every((v) => v === 0));
  return (
    <>
      <div className="ov-chart lc-days">
        {days.map((d, i) => (
          <div key={d.date} className="ov-bar-group" aria-hidden="true">
            {bars.map((b, j) => {
              const v = values[i]?.[j] ?? 0;
              return (
                <i
                  key={b.name}
                  className={`ov-bar${v === 0 ? " lc-stub" : ""}`}
                  title={`${d.date}: ${String(v)} ${b.name.toLowerCase()}`}
                  style={{
                    background: b.color,
                    height: v === 0 ? 3 : `${String(Math.max(6, (v / max) * 100))}%`,
                    animationDelay: `${String(i * 70 + j * 30)}ms`,
                  }}
                />
              );
            })}
          </div>
        ))}
        {isEmpty && empty && <p className="lc-empty small c3">{empty}</p>}
      </div>
      <div className="row between small c3 ov-days" aria-hidden="true">
        {days.map((d) => (
          <span key={d.date}>{d.day}</span>
        ))}
      </div>
      {/* The wrapper takes the 1px box: a table grows to fit its rows and would add scroll. */}
      <div className="sr-only">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {bars.map((b) => (
                <th key={b.name} scope="col">
                  {b.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d.date}>
                <th scope="row">{d.date}</th>
                {bars.map((b, j) => (
                  <td key={b.name}>{values[i]?.[j] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** A ring of shares with the total counting up in its centre. With a zero total only the track draws. */
export function ShareRing({ parts, unit }: { parts: { name: string; count: number; color: string }[]; unit: string }) {
  const total = parts.reduce((sum, p) => sum + p.count, 0);
  const count = useCountUp(total, 1600);
  const r = 88;
  const c = 2 * Math.PI * r;
  const lens = parts.map((p) => (total === 0 ? 0 : (p.count / total) * c));
  const starts = lens.map((_, i) => lens.slice(0, i).reduce((a, b) => a + b, 0));
  return (
    <div className="pl-ring-wrap">
      <svg
        viewBox="0 0 220 220"
        className="pl-ring"
        role="img"
        aria-label={total === 0 ? `No ${unit} yet` : parts.map((p) => `${p.name} ${String(p.count)}`).join(", ")}
      >
        <circle cx="110" cy="110" r={r} className="pl-ring-track lc-track" pathLength={1} />
        {parts.map((p, i) => {
          const len = lens[i] ?? 0;
          if (len === 0) return null;
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
              style={{ animationDelay: `${String(400 + i * 220)}ms` }}
            />
          );
        })}
      </svg>
      <div className="pl-ring-center" aria-hidden="true">
        <span className="pl-ring-count">{Math.round(count).toLocaleString("en-US")}</span>
        <span className="small c3">{unit}</span>
      </div>
    </div>
  );
}

/** The legend beside a ring: name, count and share of each part. */
export function ShareLegend({ parts }: { parts: { name: string; count: number; color: string }[] }) {
  const total = parts.reduce((sum, p) => sum + p.count, 0);
  return (
    <ul className="pl-legend">
      {parts.map((p, i) => (
        <li key={p.name} className="rise" style={{ animationDelay: `${String(500 + i * 120)}ms` }}>
          <i className="pl-key" style={{ background: p.color }} />
          <span className="grow ellipsis">{p.name}</span>
          <span className="mono-s c3">{p.count}</span>
          <span className="strong lc-share">
            {total === 0 ? "0%" : `${String(Math.round((p.count / total) * 100))}%`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Receipts in each block that has any, as the design's proofs-per-block bars. With none yet, a row of faint
 * placeholder bars breathes so the card reads as waiting rather than broken.
 */
export function BlockBars({ blocks, slots = 24 }: { blocks: { block: bigint; receipts: number }[]; slots?: number }) {
  const max = Math.max(1, ...blocks.map((b) => b.receipts));
  if (blocks.length === 0) {
    return (
      <div className="pl-bars lc-waiting" role="img" aria-label="No receipts committed yet">
        {Array.from({ length: slots }, (_, i) => (
          <i key={i} style={{ height: `${String(14 + ((i * 37) % 5) * 4)}%`, animationDelay: `${String(i * 40)}ms` }} />
        ))}
      </div>
    );
  }
  return (
    <div
      className="pl-bars lc-blocks"
      role="img"
      aria-label={`Receipts in each of the last ${String(blocks.length)} blocks that have any: ${blocks
        .map((b) => `block ${b.block.toString()}, ${String(b.receipts)}`)
        .join("; ")}`}
    >
      {blocks.map((b, i) => (
        <i
          key={b.block.toString()}
          className={i === blocks.length - 1 ? "now" : ""}
          title={`Block ${b.block.toString()}: ${String(b.receipts)} receipt${b.receipts === 1 ? "" : "s"}`}
          style={{
            height: `${String(Math.max(8, (b.receipts / max) * 100))}%`,
            animationDelay: `${String(300 + i * 50)}ms`,
          }}
        />
      ))}
    </div>
  );
}

/** Seven days by 24 hours, each cell shaded by its level (0 to 4). */
export function HourHeatmap({ levels, days, label }: { levels: number[][]; days: string[]; label: string }) {
  return (
    <div className="lc-heat">
      <div className="lc-heat-days small c3" aria-hidden="true">
        {days.map((d, i) => (
          <span key={`${d}-${String(i)}`}>{d}</span>
        ))}
      </div>
      <div className="pl-heat" role="img" aria-label={label}>
        {levels.flatMap((row, r) =>
          row.map((level, c) => (
            <i
              key={`${String(r)}-${String(c)}`}
              className={`l${String(level)}`}
              style={{ animationDelay: `${String(200 + c * 30 + r * 20)}ms` }}
            />
          )),
        )}
      </div>
      <div className="lc-heat-hours mono-s c3" aria-hidden="true">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
    </div>
  );
}

/** A thin bar that fills to `share` (0 to 1) when it mounts. */
export function Meter({ share, color = "var(--azure)", label }: { share: number; color?: string; label: string }) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  return (
    <div
      className="lc-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <i style={{ width: `${String(pct)}%`, background: color }} />
    </div>
  );
}
