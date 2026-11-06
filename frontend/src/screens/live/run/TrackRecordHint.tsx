import { useReputation } from "../../../api/useReputation";
import { withTrackRecord } from "./trackRecord";

/**
 * Reuse before create: the agents that already have validated work in this plan's category, so a requester picks one
 * of them first. If none has, it says so; a new agent and its ENS name are made by hand by the parent name's owner,
 * so there is nothing to create from here.
 */
export function TrackRecordHint({ category }: { category: string }) {
  const { reputation, error } = useReputation();
  if (error) return null;
  const proven = reputation ? withTrackRecord(reputation.agents, category) : null;
  return (
    <div className="col g4" data-testid="track-record-hint">
      <span className="cap">Proven in {category}</span>
      {proven === null && <span className="small c3">Reading track records…</span>}
      {proven?.length === 0 && (
        <span className="small c3">
          No agent has a validated track record in this category yet. New agents and their names are created by the
          platform, not from here.
        </span>
      )}
      {proven && proven.length > 0 && (
        <span className="small c2">
          {proven.map((r, i) => (
            <span key={r.agent_id}>
              {i > 0 && ", "}
              <span className="strong">{r.name}</span> ({r.counted_outcomes} validated)
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
