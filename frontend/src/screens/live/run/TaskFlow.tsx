import { Link } from "react-router-dom";
import { agentName } from "../../../api/useAgents";
import type { AgentInfo, PlanDetail } from "../../../api/types";
import { StatusIcon } from "../../../components/StatusIcon";
import { useWidth } from "../../../hooks/useWidth";
import { stagger } from "../../../lib/stagger";
import type { Status } from "../../../mock/data";
import { layoutFlow } from "./flow";
import { attemptsOf, taskProgress, type TaskProgress } from "./progress";
import "../../../styles/screens/run.css";
import "../../../styles/screens/ledger.css";
import "../../../styles/screens/live-charts.css";

const NODE_W = 232;
const NODE_H = 58;
const GAP_X = 32;
const ROW_H = 92;
const TOP = 20;
const SIDE = 20;

const STATUS: Record<TaskProgress["kind"], [Status, string]> = {
  waiting: ["Neutral", "Waiting"],
  running: ["Running", "Running"],
  passed: ["Completed", "Passed"],
  retrying: ["Waiting", "Retrying"],
  stuck: ["Failed", "Needs you"],
};

type Placed = { x: number; y: number };

function place(rows: number[][], width: number): Map<number, Placed> {
  const at = new Map<number, Placed>();
  rows.forEach((row, r) => {
    row.forEach((index, j) => {
      const offset = (j - (row.length - 1) / 2) * (NODE_W + GAP_X);
      at.set(index, { x: width / 2 + offset - NODE_W / 2, y: TOP + r * ROW_H });
    });
  });
  return at;
}

function edgePath(a: Placed, b: Placed) {
  const x1 = a.x + NODE_W / 2;
  const y1 = a.y + NODE_H;
  const x2 = b.x + NODE_W / 2;
  const my = (y1 + b.y) / 2;
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} C${x1.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${b.y.toFixed(1)}`;
}

/**
 * A plan's tasks as a graph, each under the tasks it waits on, with its live state. Selecting a node calls
 * `onSelect`; with `linkTo` instead, every node opens that page (the overview uses this to open the run).
 */
export function TaskFlow({
  detail,
  agents,
  selected,
  onSelect,
  linkTo,
}: {
  detail: PlanDetail;
  agents: AgentInfo[] | null;
  selected?: number;
  onSelect?: (index: number) => void;
  linkTo?: string;
}) {
  const [ref, measured] = useWidth<HTMLDivElement>(900);
  const { rows, edges } = layoutFlow(detail.tasks);
  const widest = Math.max(1, ...rows.map((r) => r.length));
  const width = Math.max(measured, widest * (NODE_W + GAP_X) - GAP_X + 2 * SIDE);
  const height = TOP * 2 + Math.max(1, rows.length) * ROW_H - (ROW_H - NODE_H);
  const at = place(rows, width);
  const progress = new Map(detail.tasks.map((t) => [t.index, taskProgress(t, detail.attempts)]));
  const draft = detail.state === "draft";

  // The graph repeats the task list beside it, so assistive tech gets one summary instead of every node again.
  const summary = detail.tasks
    .map((t) => {
      const kind = progress.get(t.index)?.kind ?? "waiting";
      const after = t.depends_on.length > 0 ? `, after ${t.depends_on.map((d) => String(d + 1)).join(" and ")}` : "";
      return `task ${String(t.index + 1)} ${t.title}: ${draft ? "draft" : STATUS[kind][1].toLowerCase()}${after}`;
    })
    .join("; ");

  return (
    <div
      className="dots lc-flow"
      ref={ref}
      role="img"
      aria-label={`Flow of ${String(detail.tasks.length)} tasks. ${summary}.`}
    >
      <div className="lc-flow-stage" style={{ width, height }} aria-hidden="true">
        <svg width={width} height={height} className="rw-edges" aria-hidden="true">
          {edges.map(([from, to], i) => {
            const a = at.get(from);
            const b = at.get(to);
            if (!a || !b) return null;
            const kind = progress.get(to)?.kind;
            const d = edgePath(a, b);
            return (
              <g key={`${String(from)}-${String(to)}`}>
                <path d={d} pathLength={1} style={{ animationDelay: `${String(200 + i * 80)}ms` }} />
                {kind === "running" && <path d={d} pathLength={1} className="lc-edge-live" />}
              </g>
            );
          })}
        </svg>
        {detail.tasks.map((task, i) => {
          const pos = at.get(task.index);
          if (!pos) return null;
          const p = progress.get(task.index) ?? { kind: "waiting" as const };
          const [status, label] = STATUS[p.kind];
          const latest = attemptsOf(task.index, detail.attempts).at(-1);
          const agentId = latest?.agent_id ?? task.agents?.[0];
          const sub = draft
            ? "Draft, not approved yet"
            : `${agentId ? agentName(agents, agentId) : "No agent yet"} · ${label}`;
          const className = `dnode rise lc-node${task.index === selected ? " sel" : ""}${p.kind === "running" ? " running" : ""}`;
          const style = stagger(i, { left: pos.x, top: pos.y, animationDelay: `${String(i * 90)}ms` });
          const body = (
            <>
              <span className="lc-node-n mono-s">{task.index + 1}</span>
              <span className="col grow min0">
                <span className="strong ellipsis">{task.title}</span>
                <span className="small c3 ellipsis">{sub}</span>
              </span>
              <span className="col dnode-meta">
                <StatusIcon status={status} />
                <span className="mono-s c3">{latest ? `try ${String(latest.attempt)}` : ""}</span>
              </span>
            </>
          );
          return linkTo ? (
            <Link key={task.index} to={linkTo} className={className} style={style} title={task.title} tabIndex={-1}>
              {body}
            </Link>
          ) : (
            <button
              key={task.index}
              type="button"
              className={className}
              style={style}
              title={task.title}
              tabIndex={-1}
              onClick={() => onSelect?.(task.index)}
            >
              {body}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The graph's frame before there is any plan: placeholder nodes shimmer under a note. No task is invented. */
export function TaskFlowEmpty({ note }: { note: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(900);
  const rows = [[0], [1, 2], [3]];
  const at = place(rows, Math.max(width, 2 * NODE_W + GAP_X + 2 * SIDE));
  const edges: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
  ];
  const height = TOP * 2 + 3 * ROW_H - (ROW_H - NODE_H);
  return (
    <div className="dots lc-flow lc-flow-empty" ref={ref}>
      <div className="lc-flow-stage" style={{ height }} aria-hidden="true">
        <svg width={width} height={height} className="rw-edges">
          {edges.map(([from, to], i) => {
            const a = at.get(from);
            const b = at.get(to);
            return a && b ? (
              <path
                key={`${String(from)}-${String(to)}`}
                d={edgePath(a, b)}
                pathLength={1}
                style={{ animationDelay: `${String(i * 120)}ms` }}
              />
            ) : null;
          })}
        </svg>
        {[0, 1, 2, 3].map((index, i) => {
          const pos = at.get(index);
          return pos ? (
            <span
              key={index}
              className="dnode rise lc-node lc-ghost"
              style={{ left: pos.x, top: pos.y, animationDelay: `${String(i * 120)}ms` }}
            >
              <i className="lc-ghost-dot" />
              <span className="col grow g6">
                <i className="lc-ghost-line" />
                <i className="lc-ghost-line short" />
              </span>
            </span>
          ) : null;
        })}
      </div>
      <p className="lc-empty small c2">{note}</p>
    </div>
  );
}
