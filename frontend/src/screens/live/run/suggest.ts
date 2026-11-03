import type { Suggestions } from "../../../api/types";
import { MAX_PICKS, type TaskForm } from "./draft";

/**
 * The picks a suggestion would set: each task's suggested agents, best first, at most MAX_PICKS. A task with no
 * suggestion keeps what the requester already chose, so applying never empties a task.
 */
export function applySuggestions(forms: TaskForm[], suggestions: Suggestions): TaskForm[] {
  const byIndex = new Map(suggestions.tasks.map((t) => [t.index, t.picks.map((p) => p.agent_id)]));
  return forms.map((f) => {
    const picked = byIndex.get(f.index) ?? [];
    return picked.length > 0 ? { ...f, agents: picked.slice(0, MAX_PICKS) } : f;
  });
}
