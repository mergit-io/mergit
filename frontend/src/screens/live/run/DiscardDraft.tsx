import { useState } from "react";
import { discardPlan } from "../../../api/client";
import { Problems } from "./Problems";
import { useSubmit } from "./useSubmit";

/**
 * Throws a draft away. Asks once more in place, as closing a plan does; unlike closing, nothing was paid, so there
 * is nothing to return, only the draft and its tasks to lose.
 */
export function DiscardDraft({ planUuid, onDiscarded }: { planUuid: string; onDiscarded: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const { busy, problems, submit } = useSubmit();

  const discard = () => {
    void submit(async () => {
      await discardPlan(planUuid);
      onDiscarded();
    });
  };

  if (!confirming) {
    return (
      <button
        type="button"
        className="btn secondary compact self-start"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Discard draft
      </button>
    );
  }
  return (
    <div className="col g8">
      <span className="small c2">Discard this draft? Its tasks are deleted. Nothing has been paid.</span>
      <div className="row g8">
        <button type="button" className="btn primary compact" disabled={busy} onClick={discard}>
          {busy ? "Discarding…" : "Yes, discard it"}
        </button>
        <button
          type="button"
          className="btn secondary compact"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
          }}
        >
          Keep it
        </button>
      </div>
      <Problems items={problems} />
    </div>
  );
}
