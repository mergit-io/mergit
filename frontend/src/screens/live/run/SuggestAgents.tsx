import { useState } from "react";
import { errorMessage, getArkivSuggestions, getSuggestions } from "../../../api/client";
import { percent, usdc } from "../../../api/reputation";
import type { ArkivDecision, ArkivSuggestions, Suggestions, TaskSuggestion } from "../../../api/types";

/** Does what Arkiv has for this task match the picks Postgres just answered with — proof the mirror
 * carries what the product actually ranked, not just a write nobody checks against anything. */
function picksMatch(task: TaskSuggestion | undefined, decision: ArkivDecision | undefined): boolean | undefined {
  if (!task || !decision) return undefined;
  const postgres = task.picks.map((p) => p.agent_id);
  const arkiv = decision.picks.map((p) => p.agent_id);
  return postgres.length === arkiv.length && postgres.every((id, i) => id === arkiv[i]);
}

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
  const [arkivBusy, setArkivBusy] = useState(false);
  const [arkivError, setArkivError] = useState<string>();
  const [arkiv, setArkiv] = useState<ArkivSuggestions>();

  const ask = () => {
    setBusy(true);
    setError(undefined);
    setArkiv(undefined);
    setArkivError(undefined);
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

  /** An exploring answer (and only that: greedy writes nothing) is mirrored onto Arkiv's Rabdi testnet
   * (ETHGlobal Mumbai's "Build on Arkiv" track); this reads it back from there, not from this plan's own
   * database, to show the mirror is actually read somewhere a user sees. */
  const viewOnArkiv = () => {
    setArkivBusy(true);
    setArkivError(undefined);
    getArkivSuggestions(planUuid).then(
      (a) => {
        setArkiv(a);
        setArkivBusy(false);
      },
      (e: unknown) => {
        setArkivError(errorMessage(e));
        setArkivBusy(false);
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
          {got.mode === "explore" && (
            <div className="col g4">
              <button type="button" className="btn ghost block" disabled={arkivBusy} onClick={viewOnArkiv}>
                {arkivBusy ? "Checking Arkiv…" : "View on Arkiv"}
              </button>
              {arkivError && (
                <span className="small ca" role="alert">
                  {arkivError}
                </span>
              )}
              {arkiv && !arkiv.enabled && <span className="small c3">Arkiv mirroring is off on this deployment.</span>}
              {arkiv?.enabled && arkiv.error && (
                <span className="small ca" role="alert">
                  Arkiv's testnet could not be reached just now; try again shortly.
                </span>
              )}
              {arkiv?.enabled && !arkiv.error && (
                <div className="col g4" data-testid="arkiv-suggestions">
                  <span className="small c3">
                    {arkiv.decisions.length === 0
                      ? "Not found on Arkiv yet; the mirror write may still be in flight or failed silently."
                      : `${String(arkiv.decisions.length)} decision${arkiv.decisions.length === 1 ? "" : "s"} read back from Arkiv's Rabdi testnet, not this app's own database:`}
                  </span>
                  {arkiv.decisions.map((d) => {
                    const matches = picksMatch(got.tasks[d.task_index], d);
                    return (
                      <div key={d.entity_key} className="row g8">
                        <a
                          className="small mono"
                          href={`https://rabdi.explorer.arkiv.network/entity/${d.entity_key}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Task {String(d.task_index + 1)} · {d.entity_key}
                        </a>
                        {matches !== undefined && (
                          <span className={`small ${matches ? "c3" : "ca"}`}>
                            {matches ? "matches ✓" : "does not match the picks above"}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
