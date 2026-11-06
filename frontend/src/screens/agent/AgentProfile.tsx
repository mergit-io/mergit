import type { ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { agentPath, parseAgentParam } from "../../app/agentRoute";
import { paths } from "../../app/paths";
import { useAuth } from "../../auth/context";
import { percent, usdc } from "../../api/reputation";
import type { AgentInfo } from "../../api/types";
import { useAgents } from "../../api/useAgents";
import { useReputation } from "../../api/useReputation";
import { ensNameOf } from "../../chain/ens/names.ts";
import { useAgentEns } from "../../chain/useAgentEns";
import { IdentityBadge } from "../../components/AgentIdentity";
import { MergitLogo } from "../../components/MergitLogo";
import { ThemeToggle } from "../../components/ThemeToggle";
import { LIVE } from "../../config/live";
import { NotFound } from "../NotFound";
import { explorerAddressUrl, findAgent, profileView, shortAddress, type ProfileView } from "./profileView";
import "../../styles/screens/pricing.css";
import "../../styles/screens/agent-profile.css";

const BASE_EXPLORER: Record<number, string> = {
  84532: "https://sepolia.basescan.org",
  8453: "https://basescan.org",
};
const ETHERSCAN = "https://etherscan.io";

/** An address, linked to its explorer page in a new tab when there is one. */
function AddressLink({ address, explorer }: { address: string | null; explorer: string | undefined }) {
  if (address === null) return <span className="c3">not available</span>;
  const href = explorerAddressUrl(explorer, address);
  return href ? (
    <a className="mono" href={href} target="_blank" rel="noopener noreferrer" title={address}>
      {shortAddress(address)}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : (
    <span className="mono" title={address}>
      {shortAddress(address)}
    </span>
  );
}

/** The public page frame, as on the pricing page: no app shell, no session needed. */
function PublicPage({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return (
    <div className="pr mesh">
      <header className="pr-bar">
        <Link to={paths.landing} className="row" aria-label="Mergit home">
          <MergitLogo height={30} title="" />
        </Link>
        <div className="row g12">
          <ThemeToggle />
          <Link to={session ? paths.app : paths.signIn} className="btn secondary compact">
            {session ? "Open dashboard" : "Sign in"}
          </Link>
        </div>
      </header>
      <main className="pr-main ap-main">{children}</main>
      <footer className="pr-main small c3" style={{ paddingTop: 0 }}>
        <Link to={paths.ledger} className="link">
          The final ledger of the run, committed on ENS
        </Link>
      </footer>
    </div>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="col g12 page-enter">
      <h1 className="pr-title ap-title">{title}</h1>
      <p className="c2">{children}</p>
    </div>
  );
}

/** What the Mergit platform itself has recorded: a different source from ENS, so a different box. */
function PlatformRecord({ agentId }: { agentId: string }) {
  const { reputation, error } = useReputation();
  const rows = (reputation?.agents ?? []).filter(
    (r) => r.agent_id === agentId && r.counted_outcomes > 0 && !r.basis.startsWith("prior"),
  );
  return (
    <section className="card pad24 col g12 ap-platform" aria-labelledby="ap-platform-title">
      <h2 id="ap-platform-title" className="heading">
        Mergit&apos;s own record
      </h2>
      <p className="small c2">
        What the Mergit platform has seen this agent do and cost, from validated outcomes only. It comes from the
        platform, not from ENS.
      </p>
      {error && <p className="c2">{error}</p>}
      {!error && reputation === null && <p className="c2">Loading the platform&apos;s record…</p>}
      {reputation && rows.length === 0 && <p className="c3">No validated outcomes yet.</p>}
      {rows.length > 0 && (
        <ul className="col g6 ap-list">
          {rows.map((r) => (
            <li key={r.category} className="small">
              <span className="mono">{r.category}</span>: {percent(r.success_mean)} pass, about{" "}
              {usdc(r.cost_mean_micros)} USDC a task, {r.value_density_per_usdc.toFixed(2)} passes per USDC{" "}
              <span className="c3">({String(r.counted_outcomes)} validated)</span>
            </li>
          ))}
        </ul>
      )}
      {reputation?.note && <p className="small c3">{reputation.note}</p>}
    </section>
  );
}

function Sections({ view }: { view: ProfileView }) {
  const base = BASE_EXPLORER[LIVE.chainId];
  return (
    <>
      <section className="card pad24 col g12" aria-labelledby="ap-check-title">
        <h2 id="ap-check-title" className="heading">
          The two-way check
        </h2>
        {view.verification.sentences.map((s) => (
          <p key={s} className="c2">
            {s}
          </p>
        ))}
      </section>

      <section className="card pad24 col g12" aria-labelledby="ap-records-title">
        <h2 id="ap-records-title" className="heading">
          Records on ENS
        </h2>
        <h3 className="small strong">Description (agent-context)</h3>
        {view.records.context.length === 0 ? (
          <p className="c3">No description is set.</p>
        ) : (
          <div className="ap-context">
            {view.records.context.map((line, i) => (
              // Lines can repeat, and they never move: the index is a stable key here.
              <p key={i}>{line}</p>
            ))}
          </div>
        )}
        <h3 className="small strong">Web endpoint (agent-endpoint[web])</h3>
        {view.records.endpoint ? (
          <p>
            <a className="mono ap-break" href={view.records.endpoint} target="_blank" rel="noopener noreferrer">
              {view.records.endpoint}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        ) : (
          <p className="c3">No https endpoint is set.</p>
        )}
      </section>

      <section className="card pad24 col g12" aria-labelledby="ap-operator-title">
        <h2 id="ap-operator-title" className="heading">
          Operator
        </h2>
        <p className="c2">{view.operator.sentence}</p>
        <dl className="ap-dl">
          <dt>On Base (Identity)</dt>
          <dd>
            <AddressLink address={view.operator.onBase} explorer={base} />
          </dd>
          <dt>Recorded on ENS (mergit.operator)</dt>
          <dd>
            <AddressLink address={view.operator.onEns} explorer={base} />
          </dd>
        </dl>
      </section>

      <section className="card pad24 col g12" aria-labelledby="ap-registry-title">
        <h2 id="ap-registry-title" className="heading">
          Registry entry
        </h2>
        <dl className="ap-dl">
          <dt>Agent id</dt>
          <dd className="mono">#{view.registry.agentId}</dd>
          <dt>Identity registry on {LIVE.chainName}</dt>
          <dd>
            <AddressLink address={view.registry.identity} explorer={base} />
          </dd>
          <dt>Owner of mergit.eth on Ethereum</dt>
          <dd>
            <AddressLink address={view.parent.owner} explorer={ETHERSCAN} />
          </dd>
          <dt>Resolver of mergit.eth on Ethereum</dt>
          <dd>
            <AddressLink address={view.parent.resolver} explorer={ETHERSCAN} />
          </dd>
        </dl>
      </section>

      <section className="card pad24 col g12" aria-labelledby="ap-mirror-title">
        <h2 id="ap-mirror-title" className="heading">
          On-chain mirror
        </h2>
        <p className="c2">{view.mirror.sentence}</p>
        {view.mirror.rows.length > 0 && (
          <table className="ledger-table">
            <caption className="sr-only">Audited and verified staked outcomes per category</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Audited</th>
                <th scope="col">Verified</th>
              </tr>
            </thead>
            <tbody>
              {view.mirror.rows.map((r) => (
                <tr key={r.category}>
                  <td className="mono ap-break">{r.category}</td>
                  <td className="mono">{String(r.audited)}</td>
                  <td className="mono">{String(r.verified)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view.mirror.note && <p className="small c3">{view.mirror.note}</p>}
      </section>
    </>
  );
}

function Profile({ agent, agentId, label }: { agent: AgentInfo; agentId: bigint; label: string }) {
  const ens = useAgentEns({ agentId, name: agent.name });
  const view = ens.state === "ready" ? profileView(ens.value, { identity: LIVE.contracts.identity }) : null;
  return (
    <>
      <div className="col g12 page-enter">
        <h1 className="pr-title ap-title ap-break">{ensNameOf(label)}</h1>
        <div className="row g8 ap-line">
          <IdentityBadge state={ens} />
          <span className="small c3">
            Agent <span className="mono">#{agent.agent_id}</span> on Mergit
          </span>
        </div>
      </div>
      {ens.state === "loading" && <p className="c2">Reading the ENS records…</p>}
      {ens.state === "error" && <p className="c2">{ens.message}</p>}
      {ens.state === "none" && <p className="c2">This agent has no ENS name.</p>}
      {view && <Sections view={view} />}
      {ens.state === "ready" && ens.value.unreadable.length > 0 && (
        <p className="small c3">Could not read this time: {ens.value.unreadable.join(", ")}.</p>
      )}
      <PlatformRecord agentId={agent.agent_id} />
    </>
  );
}

function Lookup({ label }: { label: string }) {
  const { agents, error } = useAgents();
  const name = ensNameOf(label);
  if (error) return <Message title={name}>{error}</Message>;
  if (agents === null) return <Message title={name}>Loading the agent…</Message>;
  const match = findAgent(agents, label);
  if (match.kind === "unknown") return <Message title="Agent not found">No agent is called {name} on Mergit.</Message>;
  if (match.kind === "no-ens-name")
    return (
      <Message title="This agent has no ENS name">
        The agent called {match.agent.name} has a name that is not an ENS label, so it has no {name} record.
      </Message>
    );
  return <Profile agent={match.agent} agentId={match.agentId} label={label} />;
}

/**
 * The public profile of an agent at `/agents/<label>.mergit.eth`: what its ENS name says, the two-way check with
 * Base explained in sentences, and, in a separate box, the platform's own record. No session is needed. A bare label
 * redirects to the full name; anything else that is not an agent name is the not-found page.
 */
export function AgentProfile() {
  const { ensName } = useParams();
  const parsed = parseAgentParam(ensName);
  if (parsed === null) return <NotFound />;
  if (!parsed.canonical) return <Navigate to={agentPath(parsed.label)} replace />;
  return (
    <PublicPage>
      <Lookup label={parsed.label} />
    </PublicPage>
  );
}
