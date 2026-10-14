import { useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { paths } from "../../app/paths";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { PageHeader } from "../../components/PageHeader";
import { Segmented } from "../../components/Segmented";
import { useCopy } from "../../hooks/useCopy";
import { stagger } from "../../lib/stagger";
import { changedFiles, findRun, runDetail, type RunTask, type Status, type TaskKey } from "../../mock/data";
import { NotFound } from "../NotFound";
import { FlowGraph } from "./FlowGraph";
import { TaskPanel } from "./TaskPanel";
import { clock, logSeconds, statusAt, usePlayback } from "./usePlayback";
import "../../styles/screens/run.css";

const VIEWS = ["Flow", "Timeline", "Files", "Proofs"] as const;
type View = (typeof VIEWS)[number];

const percent = (seconds: number) => `${((seconds / runDetail.seconds) * 100).toFixed(1)}%`;

function RunHeader({
  title,
  id,
  status,
  subtitle,
  showPr,
}: {
  title: string;
  id: string;
  status: Status;
  subtitle: ReactNode;
  showPr: boolean;
}) {
  const copy = useCopy();
  return (
    <PageHeader
      title={title}
      crumb={{ label: "Runs", id }}
      badge={status === "Running" ? <Badge status="Running" label="Running…" /> : <Badge status={status} />}
      subtitle={subtitle}
      actions={
        <>
          <Button
            icon="share"
            onClick={() => {
              copy(window.location.href, "Run link copied");
            }}
          >
            Share
          </Button>
          {showPr && <Button icon="external">Open {runDetail.pr}</Button>}
          <Button variant="primary" icon="rerun" to={paths.newRun}>
            Rerun
          </Button>
        </>
      }
    />
  );
}

export function RunWorkspace() {
  const { runId = "" } = useParams();
  const run = findRun(runId);

  if (!run) return <NotFound />;

  // Only RUN-2048 carries a full demo trace. Other runs show their list entry
  // rather than borrowing another run's graph.
  if (run.id !== runDetail.id) {
    return (
      <>
        <RunHeader
          title={run.title}
          id={run.id}
          status={run.status}
          subtitle={`Started ${run.started} from ${run.source}.`}
          showPr={false}
        />
        <section className="card col g12 rw-empty">
          <Icon name="runs" size={20} color="var(--ink3)" />
          <h2 className="title">No trace in the demo data</h2>
          <p className="c2">
            The task graph, live log and receipts for {run.id} load from the runtime API, which is not connected yet.
          </p>
          <Button to={paths.run(runDetail.id)}>Open the {runDetail.id} demo trace</Button>
        </section>
      </>
    );
  }

  // Keyed on the id so opening the run again replays it from the start.
  return <DemoRun key={run.id} />;
}

/** The demo run, replayed from start to finish when it opens. */
function DemoRun() {
  const elapsed = usePlayback(runDetail.seconds);
  const done = elapsed >= runDetail.seconds;
  const tasks: RunTask[] = runDetail.tasks.map((t) => ({ ...t, status: statusAt(t, elapsed) }));

  return (
    <>
      <RunHeader
        title={runDetail.title}
        id={runDetail.id}
        status={done ? "Completed" : "Running"}
        subtitle={
          <>
            {runDetail.summaryLead}, <span className="rw-clock">{clock(elapsed)}</span>.
          </>
        }
        showPr
      />
      <RunTrace tasks={tasks} elapsed={elapsed} />
    </>
  );
}

/**
 * Receipts are committed by the settle step, so none count as settled until it
 * starts; they then land steadily until the run ends.
 */
function settledAt(elapsed: number, count: number) {
  const settle = runDetail.tasks.find((t) => t.key === "settle");
  if (!settle || elapsed < settle.start) return 0;
  const progress = (elapsed - settle.start) / (runDetail.seconds - settle.start);
  return Math.min(count, Math.floor(progress * count));
}

function RunTrace({ tasks, elapsed }: { tasks: RunTask[]; elapsed: number }) {
  const [view, setView] = useState<View>("Flow");
  const [selected, setSelected] = useState<TaskKey>("research");
  const task = tasks.find((t) => t.key === selected);
  const started = tasks.filter((t) => t.status !== "Neutral");
  const settled = settledAt(elapsed, tasks.length);
  const log = runDetail.log.filter((l) => logSeconds(l) <= elapsed);
  const events = Math.round(runDetail.eventCount * Math.min(1, elapsed / runDetail.seconds));
  const visibleKeys = new Set(started.map((t) => t.key));
  const edges = runDetail.edges.filter(([a, b]) => visibleKeys.has(a) && visibleKeys.has(b));

  return (
    <section className="rw-grid fill">
      <div className="col g16 min0">
        <div className="card rw-canvas">
          <div className="rw-canvas-top">
            <Segmented options={VIEWS} value={view} onChange={setView} label="Run view" />
            <div className="row g8 hide-sm">
              <span className="chip">
                <Icon name="sparkle" size={12} />
                Planned in {runDetail.plannedIn}
              </span>
              <span className="chip" aria-live="polite">
                {settled} of {tasks.length} proofs settled
              </span>
            </div>
          </div>

          {view === "Flow" && <FlowGraph tasks={started} edges={edges} selected={selected} onSelect={setSelected} />}

          {view === "Timeline" && (
            <div className="rw-alt col">
              {tasks.map((t, i) => (
                <button
                  key={t.key}
                  type="button"
                  className="tr rw-row rise"
                  style={stagger(i)}
                  aria-pressed={t.key === selected}
                  onClick={() => {
                    setSelected(t.key);
                  }}
                >
                  <AgentAvatar kind={t.agent} size={26} />
                  <span className="strong w-110">{t.name}</span>
                  <span className="bar grow rw-track">
                    <i
                      style={{
                        width: percent(Math.max(0, Math.min(t.seconds, elapsed - t.start))),
                        marginLeft: percent(t.start),
                      }}
                    />
                  </span>
                  <span className="mono-s c3 w-56 text-right">{t.status === "Completed" ? t.duration : "—"}</span>
                </button>
              ))}
            </div>
          )}

          {view === "Files" && (
            <div className="rw-alt col">
              {changedFiles.map((f, i) => (
                <div key={f.path} className="tr rw-row rise" style={stagger(i)}>
                  <Icon name="file" size={16} color="var(--ink3)" />
                  <span className="mono grow">{f.path}</span>
                  <span className="mono-s c3">
                    +{f.added}
                    {f.removed > 0 ? ` −${f.removed}` : ""}
                    {f.isNew ? ", new file" : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {view === "Proofs" && (
            <div className="rw-alt col">
              {tasks.map((t, i) => (
                <div key={t.key} className="tr rw-row rise" style={stagger(i)}>
                  <AgentAvatar kind={t.agent} size={26} />
                  <span className="strong grow">{t.name} receipt</span>
                  {t.status === "Completed" ? (
                    <Badge status="Verified" label="Settled" />
                  ) : (
                    <Badge status="Neutral" label="Waiting" />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card col rw-log">
          <div className="hd rw-log-head">
            <h2 className="title">Live log</h2>
            <span className="small c3">{events} events, streamed</span>
          </div>
          <ol className="scroll rw-log-list" aria-live="polite">
            {log.map((l) => (
              <li key={l.t} className="row g12 rw-log-in">
                <span className="mono-s c3 w-36">{l.t}</span>
                <AgentAvatar kind={l.agent} size={20} labelled />
                <span className="mono w-150">{l.tool}</span>
                <span className="small c2">{l.detail}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {task && <TaskPanel key={task.key} task={task} log={log} />}
    </section>
  );
}
