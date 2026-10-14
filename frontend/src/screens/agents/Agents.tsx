import { useMemo, useRef, useState } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { PageHeader } from "../../components/PageHeader";
import { Segmented } from "../../components/Segmented";
import { Switch } from "../../components/Switch";
import { stagger } from "../../lib/stagger";
import { CHAIN_LABEL } from "../../mock/data";
import {
  REGISTRY_CATEGORIES,
  registry,
  TEAM_SLOTS,
  type RegistryAgent,
  type RegistryCategory,
} from "../../mock/registry";
import { useTeam } from "../../state/team";
import { useToast } from "../../toast/context";
import { AddAgentDrawer } from "./AddAgentDrawer";
import { AgentMark } from "./AgentMark";
import "../../styles/screens/agents.css";

const identityLabel = (n: number) => `#${String(n).padStart(4, "0")}`;

export function Agents() {
  const { team, added, add } = useTeam();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<RegistryCategory>("All");
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  /** The agent being added, and the identity number it was offered when the drawer opened. */
  const [adding, setAdding] = useState<{ agent: RegistryAgent; identity: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nextIdentity = Math.max(...team.map((m) => m.identity)) + 1;

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return registry.filter(
      (a) =>
        (category === "All" || a.category === category) &&
        (!verifiedOnly || a.verified) &&
        (!q || `${a.name} ${a.description} ${a.label}`.toLowerCase().includes(q)),
    );
  }, [query, category, verifiedOnly]);

  const focusSearch = () => {
    searchRef.current?.focus();
  };
  const openSlots = Math.max(0, TEAM_SLOTS - team.length);

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle={`Build your own team. Add any agent from the registry. Each one gets an ERC-8004 identity on the ${CHAIN_LABEL}.`}
        actions={
          <>
            <label className="input ag-search">
              <Icon name="search" size={16} />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                placeholder="Search registry…"
                aria-label="Search registry"
              />
            </label>
            <Button variant="primary" icon="plus" onClick={focusSearch}>
              Add agent
            </Button>
          </>
        }
      />

      <section className="card ag-team" aria-labelledby="team-title">
        <div className="row between">
          <h2 id="team-title" className="title">
            Your team
          </h2>
          <span className="small c2">
            {team.length} agents · identities on the {CHAIN_LABEL}
          </span>
        </div>
        <ul className="ag-team-row">
          {team.map((m) => (
            <li key={m.identity} className={`ag-member${m.isNew ? " new" : ""}`}>
              <AgentMark agent={m} size={34} />
              <span className="col min0">
                <span className="strong ellipsis">{m.name}</span>
                <span className="mono-s ag-member-id">
                  ID {identityLabel(m.identity)} · {m.isNew ? "new" : `D ${m.density}`}
                </span>
              </span>
            </li>
          ))}
          {Array.from({ length: openSlots }, (_, i) => (
            <li key={`slot-${String(i)}`}>
              <button
                type="button"
                className="ag-slot"
                aria-label="Add an agent from the registry"
                onClick={focusSearch}
              >
                <Icon name="plus" size={16} />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="ag-registry" aria-labelledby="registry-title">
        <div className="row g16 ag-registry-head">
          <h2 id="registry-title" className="title ag-registry-title">
            Agent registry
          </h2>
          <Segmented options={REGISTRY_CATEGORIES} value={category} onChange={setCategory} label="Registry category" />
          <span className="grow" />
          <span className="row g10 small c2">
            Verified only
            <Switch checked={verifiedOnly} label="Verified only" onChange={setVerifiedOnly} />
          </span>
        </div>

        <ul className="ag-grid">
          {list.map((agent, i) => {
            const isAdded = added.has(agent.id);
            return (
              <li key={agent.id} className="card ag-card rise" style={stagger(i)}>
                <div className="row g12">
                  <AgentMark agent={agent} size={48} />
                  <div className="col grow min0">
                    <h3 className="title">{agent.name}</h3>
                    <span className="small c2">
                      by {agent.publisher} · {agent.version} · {agent.label}
                    </span>
                  </div>
                  {agent.verified ? <Badge status="Verified" /> : <Badge status="Neutral" label="Unverified" />}
                </div>
                <p className="c2 ag-desc">{agent.description}</p>
                <div className="row between">
                  <span className="mono c2">
                    {agent.proofs} proofs · D {agent.density}
                  </span>
                  {isAdded ? (
                    <span className="btn compact ag-added" role="status">
                      <Icon name="tick" size={14} stroke={2.4} /> Added
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn primary compact"
                      aria-label={`Add ${agent.name}`}
                      onClick={() => {
                        if (team.length >= TEAM_SLOTS) toast("Your team is full");
                        else setAdding({ agent, identity: nextIdentity });
                      }}
                    >
                      <Icon name="plus" size={14} /> Add
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {list.length === 0 && <p className="c3 empty">No agents match these filters.</p>}
      </section>

      {adding && (
        <AddAgentDrawer
          key={adding.agent.id}
          agent={adding.agent}
          identity={adding.identity}
          onMinted={() => {
            add(adding.agent, adding.identity);
          }}
          onClose={() => {
            setAdding(null);
          }}
        />
      )}
    </>
  );
}
