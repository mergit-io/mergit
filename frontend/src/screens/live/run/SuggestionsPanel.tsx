import type { SuggestionsResponse } from "../../../api/types";
import { Switch } from "../../../components/Switch";

/**
 * What the suggestions under each task are, said once for the whole plan, with the one switch between the
 * ranking and a random draw. A draw is one call for every task (one seed), so the switch lives here rather
 * than on each task. `noteId` labels the answer's own note, which the Unproven badges point to.
 */
export function SuggestionsPanel({
  suggestions,
  error,
  loading,
  stale,
  noteId,
  onExplore,
}: {
  suggestions: SuggestionsResponse | null;
  error?: string;
  loading: boolean;
  /** A budget has an unsaved edit, so the suggestions are for a budget that is no longer on screen. */
  stale: boolean;
  noteId: string;
  onExplore: (explore: boolean) => void;
}) {
  if (!suggestions) {
    // Manual picking is the whole task here; a missing suggestion is a footnote, not an error.
    return error ? <p className="small c3">Suggestions are unavailable right now. Pick the agents yourself.</p> : null;
  }
  const exploring = suggestions.mode === "explore";
  return (
    <section className="card pad24 col g8" aria-label="Suggested agents">
      <div className="row between g12">
        <span className="cap">Suggested agents</span>
        <span className="row g8">
          <span className="small c2">Try a random draw</span>
          <Switch
            checked={exploring}
            label="Try a random draw"
            disabled={loading}
            onChange={(on) => {
              onExplore(on);
            }}
          />
        </span>
      </div>
      <p className="small c3">
        {loading
          ? "Updating…"
          : exploring
            ? "Random draw: each agent's place and numbers come from one draw over its record, so a less-tried agent can come first, and the order and numbers change with every draw. Turn it off for the ranking."
            : "Ranked by expected success per dollar. A random draw gives less-tried agents a chance; each draw counts toward an hourly limit."}
      </p>
      <p className="small c3" id={noteId}>
        {suggestions.note}
      </p>
      {stale && <p className="small c3">These are for the saved budgets. Save your changes to update them.</p>}
      {error && (
        <p className="small c3" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
