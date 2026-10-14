/**
 * Small trend line. The dashboard cards draw it with a soft fill and an end
 * dot; `plain` gives the bare line used on the proof ledger.
 */
export function Spark({
  points,
  color = "var(--azure)",
  width = 96,
  height = 36,
  plain = false,
}: {
  points: number[];
  color?: string;
  width?: number;
  height?: number;
  plain?: boolean;
}) {
  if (points.length === 0) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  // With one point there is no span to divide by; draw it at the right edge.
  const span = points.length - 1;
  const xy = points.map((p, i): [x: number, y: number] => [
    span ? (i / span) * width : width,
    height - 3 - ((p - min) / (max - min || 1)) * (height - 8),
  ]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const end = xy.at(-1);
  if (!end) return null;
  const [endX, endY] = end;
  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden="true"
    >
      {!plain && <path d={`${d} L${width} ${height} L0 ${height} Z`} fill={color} fillOpacity={0.08} />}
      <path d={d} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {!plain && <circle cx={endX - 2} cy={endY} r={3} fill={color} stroke="var(--surface)" strokeWidth={2} />}
    </svg>
  );
}
