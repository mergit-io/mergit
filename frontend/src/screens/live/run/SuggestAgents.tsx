import { useState } from "react";
import { errorMessage, getSuggestions } from "../../../api/client";
import { percent, usdc } from "../../../api/reputation";
import type { Suggestions } from "../../../api/types";

/**
 * Advice on which agents to pick, from what the platform has validated about each (never from free-credit work).
 * It only advises: nothing changes until the requester presses "Use these picks", and approving still sends what
 * is on screen. Exploring is off unless asked for, because the platform does not yet cover the cost when an
 * unproven agent fails.
 */
export function SuggestAgents({ planUuid, onUse }: { planUuid: string; onUse: (suggestions: Suggestions) => void }) {
  const [explore, setExplore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [got, setGot] = useState<Suggestions>();

  const ask = () => {
    setBusy(true);
    setError(undefined);
    getSuggestions(planUuid, explore).then(
      (s) => {
        setGot(s);
        setBusy(false);
      },
      (e: unknown) => {
        setError(errorMessage(e));
        setBusy(false);
      },
    );
  };

  return (
    <div className="col g8" aria-label="Suggested agents">
      <span className="cap">Suggested agents</span>
      <label className="row g8 small c2">
        <input
          type="checkbox"
          checked={explore}
          onChange={(e) => {
            setExplore(e.target.checked);
          }}
        />
        Also try less-proven agents
      </label>
      {explore && (
        <span className="small ca">
          An agent with few validated outcomes may fail, and the platform does not yet cover that cost: it would be
          yours.
        </span>
      )}
      <button type="button" className="btn secondary block" disabled={busy} onClick={ask}>
        {busy ? "Asking…" : "Suggest agents"}
      </button>
      {error && (
        <p className="small ca" role="alert">
          {error}
        </p>
      )}
      {got && (
        <div className="col g8" data-testid="suggestions">
          {got.tasks.map((t) => (
            <div key={t.index} className="col g4">
              <span className="small c2">Task {String(t.index + 1)}</span>
              {t.picks.length === 0 ? (
                <span className="small c3">{t.reason ?? "No agent is expected to fit this budget."}</span>
              ) : (
                t.picks.map((p, i) => (
                  <span key={p.agent_id} className="small">
                    {i === 0 ? "Runs it" : `Retry ${String(i)}`}: <span className="strong">{p.name}</span>{" "}
                    <span className="c3">
                      · {percent(p.assumed_success)} pass · about {usdc(p.assumed_cost_micros)} USDC ·{" "}
                      {p.counted_outcomes === 0
                        ? "no validated outcomes yet"
                        : `${String(p.counted_outcomes)} validated`}
                    </span>
                    {p.unproven && <span className="ca"> · unproven</span>}
                  </span>
                ))
              )}
            </div>
          ))}
          <span className="small c3">{got.note}</span>
          <button
            type="button"
            className="btn secondary block"
            onClick={() => {
              onUse(got);
            }}
          >
            Use these picks
          </button>
        </div>
      )}
    </div>
  );
}
