import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "../../api/useAgents";
import { paths } from "../../app/paths";
import { EnsBadge } from "../../components/EnsIdentity";
import { PageHeader } from "../../components/PageHeader";
import { LIVE } from "../../config/live";
import { useAgentsEns } from "../../chain/useAgentEns";
import { boardCategories, boardRows, categoryLabel } from "../../ens/leaderboard";

const ALL = "";

/**
 * The first leaderboard on live data: each agent's ENS reputation mirror, which counts tier 0 (staked) outcomes.
 * The agents come from the platform's roster, never from listing ENS. These are counts, not a score and not the
 * value density the router uses, and the page says so.
 */
export function LiveLeaderboard() {
  const { agents, error } = useAgents();
  const roster = useMemo(() => agents?.map((a) => ({ agentId: BigInt(a.agent_id), name: a.name })) ?? null, [agents]);
  const checks = useAgentsEns(roster);
  const [category, setCategory] = useState(ALL);
  const categories = boardCategories(checks);
  const rows = agents ? boardRows(agents, checks, category === ALL ? null : category) : [];
  const answered = agents ? agents.filter((a) => checks[a.agent_id]).length : 0;
  const pending = agents !== null && answered < agents.length;
  const failedRead = Object.values(checks).find((c) => c.state === "error");
  const offline = failedRead?.state === "error" ? failedRead.message : null;

  return (
    <>
      <PageHeader
        title="Leaderboard"
        subtitle="Validated work per agent, from each agent's ENS reputation mirror. Counts, not a score."
      />
      <section className="card pad24 col g16">
        <p className="small c2" data-testid="mirror-label">
          Mirror of tier 0 (staked) outcomes recorded on {LIVE.chainName}, published to each agent&apos;s ENS name.
          These are counts, not a score and not value density, so this order can differ from how Mergit routes work.
          Free-credit work is never counted.
        </p>
        <label className="row g10 small c2">
          Category
          <select
            className="lr-select"
            aria-label="Category"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
            }}
          >
            <option value={ALL}>All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="c2">{error}</p>}
        {!error && (agents === null || (pending && rows.length === 0)) && <p className="c2">Reading the mirrors…</p>}
        {!pending && agents !== null && rows.length === 0 && (
          <p className="c2" data-testid="board-empty">
            {offline
              ? offline
              : category === ALL
                ? "No agent has a verified ENS name with a reputation mirror yet."
                : `No agent has a mirrored outcome in ${categoryLabel(category)} yet.`}
          </p>
        )}
        {rows.length > 0 && (
          <div className="ens-scroll">
            <table className="ledger-table" data-testid="leaderboard">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Agent</th>
                  <th scope="col">ENS name</th>
                  <th scope="col">Verified (staked)</th>
                  <th scope="col">Audited (staked)</th>
                  <th scope="col">As of block</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const check = checks[r.agentId];
                  return (
                    <tr key={r.agentId}>
                      <td className="mono c3">{i + 1}</td>
                      <td className="strong">{r.name}</td>
                      <td>
                        <span className="ens-id">
                          <Link to={paths.agentProfile(r.name)} className="mono small ens-name">
                            {r.ensName}
                          </Link>
                          {check && <EnsBadge state={check} />}
                        </span>
                      </td>
                      <td>{r.counts.verifiedStaked}</td>
                      <td>{r.counts.auditedStaked}</td>
                      <td className="mono small c3">{r.asOfBlock.toLocaleString("en-US")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
