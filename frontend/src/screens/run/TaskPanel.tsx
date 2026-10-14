import { useState } from "react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { AppTile } from "../../components/AppTile";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { useTypewriter } from "../../hooks/useTypewriter";
import { stagger } from "../../lib/stagger";
import type { LogEntry, RunTask } from "../../mock/data";

const PANES = ["Details", "Input", "Output", "Logs"] as const;
type Pane = (typeof PANES)[number];

/** Side panel for the selected task. Mount with `key={task.key}` so the tab resets per task. */
/** The summary types itself out once the task has finished, as in the design video. */
function Summary({ text, ready }: { text: string; ready: boolean }) {
  const [shown, finished] = useTypewriter(text, ready, 14);
  if (!ready) return <p className="c3">Working on it…</p>;
  return (
    <p className="c2" aria-label={text}>
      <span aria-hidden="true">
        {shown}
        {!finished && <i className="caret" />}
      </span>
    </p>
  );
}

export function TaskPanel({ task, log }: { task: RunTask; log: LogEntry[] }) {
  const [pane, setPane] = useState<Pane>("Details");
  // Tools, stats and the result appear once the task has finished, as in the design video.
  const done = task.status === "Completed";
  const taskLog = log.filter((l) => l.agent === task.agent);

  return (
    <aside className="card pad col g16 rw-panel" aria-label={`${task.title} details`}>
      <div className="row g12 page-enter">
        <AgentAvatar kind={task.agent} size={44} />
        <div className="col g4">
          <h2 className="title">{task.title}</h2>
          <div className="row g8">
            {task.status === "Running" ? <Badge status="Running" label="Running…" /> : <Badge status={task.status} />}
            {task.status === "Completed" && <span className="mono-s c3">{task.duration}</span>}
          </div>
        </div>
      </div>
      <Segmented options={PANES} value={pane} onChange={setPane} label="Task detail" className="self-start" />

      {pane === "Details" && (
        <>
          <div className="col g6">
            <span className="cap c3">Summary</span>
            <Summary text={task.summary} ready={task.status === "Completed"} />
          </div>
          {done && (
            <div className="col g10">
              <span className="cap c3">Tools used</span>
              {task.tools.map((tool, i) => (
                <div
                  key={tool.name}
                  className="row g12 rise"
                  style={stagger(i, { animationDelay: `${String(300 + i * 250)}ms` })}
                >
                  <AppTile icon={tool.icon} size={34} />
                  <div className="col">
                    <span className="strong">{tool.name}</span>
                    <span className="small c3">{tool.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {done && (
            <div className="rw-meta rise" style={{ animationDelay: "1000ms" }}>
              {task.meta.map(([label, value]) => (
                <div key={label} className="inner pad-sm col">
                  <span className="small c3">{label}</span>
                  <span className="strong small">{value}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {pane === "Input" && <pre className="inner code rw-pre">{task.input}</pre>}
      {pane === "Output" && (
        <pre className="inner code rw-pre">
          {done
            ? `result: ${task.result}\nduration: ${task.duration}\nstatus: completed`
            : "Still running. The output appears when the task finishes."}
        </pre>
      )}
      {pane === "Logs" && (
        <pre className="inner code rw-pre">
          {taskLog.length > 0
            ? taskLog.map((l) => `${l.t}  ${l.tool}  ${l.detail}`).join("\n")
            : "No tool calls for this task."}
        </pre>
      )}

      {done && (
        <div className="inner pad-lg col g8 mt-auto rise" style={{ animationDelay: "1200ms" }}>
          <span className="cap c3">Result</span>
          <div className="row g8">
            <Icon name="check" size={16} color="var(--mint)" stroke={2} />
            <span className="strong">{task.result}</span>
          </div>
          <span className="self-start">
            <Button
              variant="link"
              icon="arrowRight"
              onClick={() => {
                setPane("Output");
              }}
            >
              View output
            </Button>
          </span>
        </div>
      )}
    </aside>
  );
}
