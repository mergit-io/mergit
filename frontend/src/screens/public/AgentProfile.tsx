import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type { Address } from "viem";
import { useAgents } from "../../api/useAgents";
import { paths } from "../../app/paths";
import { useAuth } from "../../auth/context";
import type { AgentEns } from "../../chain/ens/agentEns.ts";
import { PARENT_NAME, ensNameOf, labelForAgent } from "../../chain/ens/names.ts";
import { useAgentEns } from "../../chain/useAgentEns";
import { recordKeys, useRecordWriters, type Writers } from "../../chain/useRecordWriters";
import { EnsBadge } from "../../components/EnsIdentity";
import { MergitLoader } from "../../components/MergitLoader";
import { MergitLogo } from "../../components/MergitLogo";
import { ThemeToggle } from "../../components/ThemeToggle";
import { LIVE } from "../../config/live";
import { ensBadgeView } from "../../ens/badgeView";
import { categoryLabel } from "../../ens/leaderboard";
import "../../styles/screens/agent-profile.css";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const EXPLORER: Record<number, string> = { 84532: "https://sepolia.basescan.org" };
const ETHERSCAN = "https://etherscan.io";

function AddressOn({ address, explorer }: { address: Address | null; explorer: string | undefined }) {
  if (!address) return <span className="c3">Not known</span>;
  return explorer ? (
    <a className="mono" href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">
      {short(address)}
    </a>
  ) : (
    <span className="mono">{short(address)}</span>
  );
}

function Owners({ ens }: { ens: AgentEns }) {
  const rows: [string, Address | null, string | undefined][] = [
    [`Owner of agent ${String(ens.agentId)} on ${LIVE.chainName}`, ens.operator.onBase, EXPLORER[LIVE.chainId]],
    ["Operator recorded on ENS", ens.operator.onEns, EXPLORER[LIVE.chainId]],
    [`Owner of ${PARENT_NAME}`, ens.parentOwner, ETHERSCAN],
  ];
  return (
    <section className="card pad24 col g12" aria-labelledby="ap-owners">
      <h2 id="ap-owners" className="title">
        Owners
      </h2>
      <dl className="ap-owners">
        {rows.map(([label, address, explorer]) => (
          <div key={label} className="col g4">
            <dt className="small c3">{label}</dt>
            <dd>
              <AddressOn address={address} explorer={explorer} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="small c3">
        Agent names are records under {PARENT_NAME}, so its owner controls them. The tick needs the operator recorded on
        ENS to be the agent&apos;s owner on {LIVE.chainName} now.
      </p>
    </section>
  );
}

/** `agent-registration[0x…][2]` as its name and its parameters, so the long address can wrap on its own line. */
function splitKey(key: string): [name: string, params: string] {
  const at = key.indexOf("[");
  // A short parameter such as `[web]` reads best on the name's own line; only a long one moves below it.
  return at < 0 || key.length - at <= 16 ? [key, ""] : [key.slice(0, at), key.slice(at)];
}

const notSet = <span className="c3">Not set</span>;

function mirrorSummary(m: AgentEns["mirror"]): ReactNode {
  if (m.status === "absent") return notSet;
  if (m.status === "unavailable") return <span className="c3">Could not be read</span>;
  if (m.status === "malformed") return <span className="c3">Not in the publisher&apos;s format: {m.detail}</span>;
  return `Mirror at block ${m.mirror.asOfBlock.toLocaleString("en-US")}: ${String(m.mirror.auditedStaked)} audited, ${String(m.mirror.verifiedStaked)} verified (track record below)`;
}

function Writer({ writers, recordKey }: { writers: Writers; recordKey: string }) {
  if (writers.state === "loading") return <span className="c3">…</span>;
  const w = writers.state === "ready" ? writers.byKey[recordKey] : null;
  return w ? <AddressOn address={w.account} explorer={ETHERSCAN} /> : <span className="c3">Not known</span>;
}

function Records({ ens }: { ens: AgentEns }) {
  const writers = useRecordWriters(ens);
  const [registrationKey = "", ...rest] = recordKeys(ens.agentId);
  const values: Record<string, ReactNode> = {
    [registrationKey]: ens.records.registration ?? notSet,
    "agent-context": ens.records.context ?? notSet,
    "agent-endpoint[web]": ens.records.endpointWeb ? (
      <a href={ens.records.endpointWeb} target="_blank" rel="noreferrer">
        {ens.records.endpointWeb}
      </a>
    ) : (
      notSet
    ),
    "mergit.operator": ens.operator.onEns ?? notSet,
    "mergit.reputation": mirrorSummary(ens.mirror),
  };
  return (
    <section className="card pad24 col g12" aria-labelledby="ap-records">
      <h2 id="ap-records" className="title">
        ENS records
      </h2>
      <table className="ledger-table ap-records">
        <colgroup>
          <col className="ap-col-key" />
          <col />
          <col className="ap-col-writer" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Record</th>
            <th scope="col">Value</th>
            <th scope="col">Written by</th>
          </tr>
        </thead>
        <tbody>
          {[registrationKey, ...rest].map((key) => {
            const [name, params] = splitKey(key);
            return (
              <tr key={key}>
                <td data-label="Record">
                  <span className="mono small strong">{name}</span>
                  {params && <span className="mono-s c3 ap-params">{params}</span>}
                </td>
                <td data-label="Value" className="small ap-value">
                  {values[key]}
                </td>
                <td data-label="Written by" className="ap-writer">
                  <Writer writers={writers} recordKey={key} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small c3">
        &quot;Written by&quot; is read from the resolver&apos;s logs in recent blocks; an older write shows as not
        known.
      </p>
    </section>
  );
}

function TrackRecord({ mirror }: { mirror: AgentEns["mirror"] }) {
  return (
    <section className="card pad24 col g12" aria-labelledby="ap-track">
      <h2 id="ap-track" className="title">
        Track record
      </h2>
      {mirror.status === "absent" && <p className="c2">No reputation mirror has been written for this name yet.</p>}
      {mirror.status === "unavailable" && <p className="c2">The reputation record could not be read this time.</p>}
      {mirror.status === "malformed" && (
        <p className="c2">The mergit.reputation record is not in the documented shape, so no counts are shown.</p>
      )}
      {mirror.status === "ok" && (
        <>
          <div className="ens-scroll">
            <table className="ledger-table" data-testid="track-record">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col">Audited (staked)</th>
                  <th scope="col">Verified (staked)</th>
                </tr>
              </thead>
              <tbody>
                {mirror.mirror.byCategory.map((c) => (
                  <tr key={c.category}>
                    <td className="mono">{categoryLabel(c.category)}</td>
                    <td>{c.auditedStaked}</td>
                    <td>{c.verifiedStaked}</td>
                  </tr>
                ))}
                <tr>
                  <td className="strong">All categories</td>
                  <td className="strong">{mirror.mirror.auditedStaked}</td>
                  <td className="strong">{mirror.mirror.verifiedStaked}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small c3" data-testid="mirror-note">
            Mirror of tier 0 (staked) outcomes recorded on {LIVE.chainName}, as of block{" "}
            {mirror.mirror.asOfBlock.toLocaleString("en-US")}. Counts, not a score. The chain is the source of truth.
          </p>
        </>
      )}
    </section>
  );
}

const Loading = ({ text }: { text: string }) => (
  <div className="c2 row g12 loading-row">
    <MergitLoader size={28} label={text} />
    <span>{text}</span>
  </div>
);

/**
 * An agent's public page: anyone can open it, signed in or not, and it is the URL the agent's ENS
 * `agent-endpoint[web]` record names. The label in the address is the agent's name on the platform; the platform's
 * public agent list says which Identity agent that is, and everything else is read live from mainnet and Base.
 */
export function AgentProfile() {
  const { label = "" } = useParams();
  const { session } = useAuth();
  const valid = labelForAgent(label);
  const { agents, error } = useAgents();
  const agent = valid && agents ? (agents.find((a) => a.name === valid) ?? null) : null;
  const state = useAgentEns(agent ? { agentId: BigInt(agent.agent_id), name: agent.name } : null);
  const ens = state.state === "ready" ? state.value : null;
  const view = ensBadgeView(state);
  const title = valid ? ensNameOf(valid) : label;

  let body: ReactNode;
  if (!valid) body = <p className="c2">&quot;{label}&quot; is not a valid agent name.</p>;
  else if (error) body = <p className="c2">{error}</p>;
  else if (agents === null) body = <Loading text="Finding the agent…" />;
  else if (!agent)
    body = (
      <p className="c2" data-testid="no-such-agent">
        No agent is named {title}.
      </p>
    );
  else if (state.state === "loading") body = <Loading text="Checking the name on ENS…" />;
  else if (state.state === "error") body = <p className="c2">{state.message}</p>;
  else if (ens)
    body = (
      <>
        <Owners ens={ens} />
        <Records ens={ens} />
        <TrackRecord mirror={ens.mirror} />
        {ens.unreadable.length > 0 && (
          <p className="small c3">Could not be read this time: {ens.unreadable.join(", ")}.</p>
        )}
      </>
    );

  return (
    <div className="ap">
      <header className="ap-bar">
        <Link to={paths.landing} className="row" aria-label="Mergit home">
          <MergitLogo height={30} title="" />
        </Link>
        <div className="row g12">
          <ThemeToggle />
          <Link to={session ? paths.liveApp : paths.signIn} className="btn secondary compact">
            {session ? "Open dashboard" : "Sign in"}
          </Link>
        </div>
      </header>
      <main className="ap-main col g16">
        <div className="col g8">
          <span className="cap c3">Agent</span>
          <h1 className="ap-title mono">{title}</h1>
          {agent && (
            <div className="row g8 ap-badges">
              <EnsBadge state={state} />
              <span className="small c2">
                Agent {agent.agent_id} on {LIVE.chainName}
              </span>
            </div>
          )}
          {agent && view.reason && state.state === "ready" && (
            <p className="small c2" data-testid="ens-reason">
              {view.reason}
              {ens?.verification.status === "failed" ? ` ${ens.verification.detail}` : ""}
            </p>
          )}
        </div>
        {body}
        <p className="small c3">
          Agents, payments and receipts are on {LIVE.chainName}. Names are on Ethereum mainnet. &quot;Two-way
          verified&quot; means the name attests to the agent, the agent&apos;s registration file names this name, and
          the operator recorded on ENS is the agent&apos;s owner now.
        </p>
      </main>
    </div>
  );
}
