import { paths } from "../../app/paths";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { PageHeader } from "../../components/PageHeader";
import { Segmented } from "../../components/Segmented";
import { stagger } from "../../lib/stagger";
import { changedFiles, findRun, runDetail, type RunTask, type TaskKey } from "../../mock/data";
import { useCopy } from "../../hooks/useCopy";
import { NotFound } from "../NotFound";
import { FlowGraph } from "./FlowGraph";
import { TaskPanel } from "./TaskPanel";
import "../../styles/screens/run.css";

const VIEWS = ["Flow", "Timeline", "Files", "Proofs"] as const;
type View = (typeof VIEWS)[number];

const percent = (seconds: number) => `${((seconds / runDetail.seconds) * 100).toFixed(1)}%`;

export function RunWorkspace() {
  const { runId = "" } = useParams();
  const run = findRun(runId);
  const copy = useCopy();

  if (!run) return <NotFound />;

  const header = (
    <PageHeader
      title={run.title}
      crumb={{ label: "Runs", id: run.id }}
      badge={<Badge status={run.status} />}
      subtitle={run.id === runDetail.id ? runDetail.summary : `Started ${run.started} from ${run.source}.`}
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
          {run.id === runDetail.id && <Button icon="external">Open {runDetail.pr}</Button>}
          <Button variant="primary" icon="rerun" to={paths.newRun}>
            Rerun
          </Button>
        </>
      }
    />
  );

  // Only RUN-2048 carries a full demo trace. Other runs show their list entry
  // rather than borrowing another run's graph.
  if (run.id !== runDetail.id) {
    return (
      <>
        {header}
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

  return (
    <>
      {header}
      <RunTrace />
    </>
  );
}

function RunTrace() {
  const [view, setView] = useState<View>("Flow");
  const [selected, setSelected] = useState<TaskKey>("research");
  const tasks: RunTask[] = runDetail.tasks;
  const task = tasks.find((t) => t.key === selected);

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
              <span className="chip">
                {tasks.length} of {tasks.length} proofs settled
              </span>
            </div>
          </div>

          {view === "Flow" && (
            <FlowGraph tasks={tasks} edges={runDetail.edges} selected={selected} onSelect={setSelected} />
          )}

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
                    <i style={{ width: percent(t.seconds), marginLeft: percent(t.start) }} />
                  </span>
                  <span className="mono-s c3 w-56 text-right">{t.duration}</span>
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
                  <Badge status="Verified" label="Settled" />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card col rw-log">
          <div className="hd rw-log-head">
            <h2 className="title">Live log</h2>
            <span className="small c3">{runDetail.eventCount} events, streamed</span>
          </div>
          <ol className="scroll rw-log-list">
            {runDetail.log.map((l, i) => (
              <li key={l.t} className="row g12 rise" style={stagger(i)}>
                <span className="mono-s c3 w-36">{l.t}</span>
                <AgentAvatar kind={l.agent} size={20} labelled />
                <span className="mono w-150">{l.tool}</span>
                <span className="small c2">{l.detail}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {task && <TaskPanel key={task.key} task={task} log={runDetail.log} />}
    </section>
  );
}
