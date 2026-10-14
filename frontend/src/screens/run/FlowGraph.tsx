import { useLayoutEffect, useRef, useState } from "react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { StatusIcon } from "../../components/StatusIcon";
import { stagger } from "../../lib/stagger";
import type { RunTask, TaskKey } from "../../mock/data";

const NODE_W = 232;
const NODE_H = 58;
const COLUMN_GAP = 40;
/** Top of each graph row, in px. */
const ROW_Y = [22, 114, 206, 298] as const;
const STAGE_H = 420;
const MIN_STAGE_W = 3 * NODE_W + 2 * COLUMN_GAP + 20;
const ZOOM = { min: 0.6, max: 1.4, step: 0.1 };

/** Grid slot of each task, as drawn in the design: planner, three workers, reviewer, proof. */
const SLOT: Record<TaskKey, { col: -1 | 0 | 1; row: 0 | 1 | 2 | 3 }> = {
  plan: { col: 0, row: 0 },
  research: { col: -1, row: 1 },
  code: { col: 0, row: 1 },
  test: { col: 1, row: 1 },
  review: { col: 0, row: 2 },
  settle: { col: 0, row: 3 },
};

function position(key: TaskKey, width: number) {
  const { col, row } = SLOT[key];
  return { x: (width - NODE_W) / 2 + col * (NODE_W + COLUMN_GAP), y: ROW_Y[row] };
}

function edgePath(from: TaskKey, to: TaskKey, width: number) {
  const a = position(from, width);
  const b = position(to, width);
  const x1 = a.x + NODE_W / 2;
  const y1 = a.y + NODE_H;
  const x2 = b.x + NODE_W / 2;
  const my = (y1 + b.y) / 2;
  return `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${b.y}`;
}

const clampZoom = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(z * 10) / 10));

export function FlowGraph({
  tasks,
  edges,
  selected,
  onSelect,
}: {
  tasks: RunTask[];
  edges: [TaskKey, TaskKey][];
  selected: TaskKey;
  onSelect: (key: TaskKey) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(942);
  const [zoom, setZoom] = useState(1);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let first = true;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = Math.max(entry.contentRect.width, MIN_STAGE_W);
      setWidth(next);
      // On a narrow screen the graph is wider than the card: start centred, then leave scrolling to the user.
      if (first) el.scrollLeft = (next - entry.contentRect.width) / 2;
      first = false;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  return (
    <>
      <div className="dots rw-stage" ref={stageRef}>
        <div className="rw-zoom" style={{ transform: `scale(${zoom})`, width }}>
          <svg width={width} height={STAGE_H} className="rw-edges" aria-hidden="true">
            {edges.map(([from, to], i) => (
              <path
                key={`${from}-${to}`}
                d={edgePath(from, to, width)}
                pathLength={1}
                style={{ animationDelay: `${i * 60}ms` }}
              />
            ))}
          </svg>
          {tasks.map((task, i) => {
            const { x, y } = position(task.key, width);
            return (
              <button
                key={task.key}
                type="button"
                className={`dnode rise${task.key === selected ? " sel" : ""}${task.status === "Running" ? " running" : ""}`}
                style={stagger(i, { left: x, top: y })}
                aria-pressed={task.key === selected}
                onClick={() => {
                  onSelect(task.key);
                }}
              >
                <AgentAvatar kind={task.agent} size={32} />
                <span className="col grow">
                  <span className="strong">{task.name}</span>
                  <span className="small c3 ellipsis">{task.sub}</span>
                </span>
                <span className="col dnode-meta">
                  <StatusIcon status={task.status} />
                  <span className="mono-s c3">{task.duration}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="rw-zoom-ctl">
        <button
          type="button"
          className="small c2"
          aria-label="Zoom out"
          disabled={zoom <= ZOOM.min}
          onClick={() => {
            setZoom((z) => clampZoom(z - ZOOM.step));
          }}
        >
          −
        </button>
        <button
          type="button"
          className="small c2"
          aria-label="Reset zoom"
          onClick={() => {
            setZoom(1);
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="small c2"
          aria-label="Zoom in"
          disabled={zoom >= ZOOM.max}
          onClick={() => {
            setZoom((z) => clampZoom(z + ZOOM.step));
          }}
        >
          +
        </button>
      </div>
    </>
  );
}
