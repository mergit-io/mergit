import type { AgentInfo, Candidate } from "../../../api/types";
import { AgentPicks, type RoutingChoice } from "./AgentPicks";
import type { TaskForm } from "./draft";
import { TextAreaField, TextField } from "./fields";

/** One drafted task, editable: what the agent is told, the check that decides it is done, its budget. */
export function TaskDraftCard({
  form,
  agents,
  candidates,
  candidatesError,
  onChange,
}: {
  form: TaskForm;
  agents: AgentInfo[];
  /** This task's ranked candidates, once `/candidates` has answered. Undefined while it's still loading. */
  candidates: Candidate[] | undefined;
  candidatesError?: string;
  onChange: (form: TaskForm) => void;
}) {
  const name = `Task ${String(form.index + 1)}`;
  const set =
    <K extends keyof TaskForm>(key: K) =>
    (value: TaskForm[K]) => {
      onChange({ ...form, [key]: value });
    };

  return (
    <fieldset className="card pad24 col g16 lr-task">
      <legend className="sr-only">{name}</legend>
      <div className="row between">
        <span className="mono-s c3">{name}</span>
        {form.dependsOn.length > 0 && (
          <span className="small c3">After task {form.dependsOn.map((d) => String(d + 1)).join(", ")}</span>
        )}
      </div>
      <TextField label="Title" value={form.title} onChange={set("title")} />
      <TextAreaField label="Instructions for the agent" value={form.instructions} onChange={set("instructions")} />
      <TextAreaField label="Check (Φ)" value={form.phiText} onChange={set("phiText")} mono />
      <span className="small c3">
        The platform runs this command after the agent stops. The task only counts as done if it exits as expected and
        the agent touched nothing outside the allowed paths.
      </span>
      <div className="lr-task-foot">
        <TextField label="Budget (USDC)" value={form.budget} onChange={set("budget")} inputMode="decimal" />
        <AgentPicks
          task={name}
          agents={agents}
          picks={form.agents}
          onPicksChange={set("agents")}
          routing={{ routing: form.routing, explore: form.explore, retryTolerant: form.retryTolerant }}
          onRoutingChange={(r: RoutingChoice) => {
            onChange({ ...form, routing: r.routing, explore: r.explore, retryTolerant: r.retryTolerant });
          }}
          candidates={candidates}
          candidatesError={candidatesError}
        />
      </div>
    </fieldset>
  );
}
