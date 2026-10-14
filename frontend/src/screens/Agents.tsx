import { useMemo, useState } from "react";
import { AgentAvatar } from "../components/AgentAvatar";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { stagger } from "../lib/stagger";
import { countPhrase } from "../lib/words";
import { CATEGORY_FILTERS, agents, type Agent, type CategoryFilter } from "../mock/data";
import "../styles/screens/agents.css";

const SORTS = {
  success: { label: "success", compare: (a: Agent, b: Agent) => b.success - a.success },
  tasks: { label: "tasks", compare: (a: Agent, b: Agent) => b.tasks - a.tasks },
  name: { label: "name", compare: (a: Agent, b: Agent) => a.name.localeCompare(b.name) },
};
type SortKey = keyof typeof SORTS;
const isSortKey = (value: string): value is SortKey => value in SORTS;

export function Agents() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("All");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("success");

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents
      .filter(
        (a) =>
          (category === "All" || a.category === category) &&
          (!verifiedOnly || a.verified) &&
          (!q || `${a.name} ${a.description} ${a.tags.join(" ")}`.toLowerCase().includes(q)),
      )
      .sort(SORTS[sort].compare);
  }, [query, category, verifiedOnly, sort]);

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle={`${countPhrase(agents.length, "specialist")}, each with a model you choose and an ERC-8004 identity on chain.`}
        actions={
          <Button variant="primary" icon="plus">
            Create agent
          </Button>
        }
      />
      <div className="row g12 ag-tools">
        <label className="input ag-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            placeholder="Search agents"
            aria-label="Search agents"
          />
        </label>
        <Segmented options={CATEGORY_FILTERS} value={category} onChange={setCategory} label="Category" />
        <span className="grow" />
        <button
          type="button"
          className={`chipo${verifiedOnly ? " on" : ""}`}
          aria-pressed={verifiedOnly}
          onClick={() => {
            setVerifiedOnly((v) => !v);
          }}
        >
          <Icon name="proofs" size={14} color="var(--mint)" stroke={2} />
          Verified only
        </button>
        <label className="chipo select-chip">
          <span className="sr-only">Sort agents</span>
          <select
            value={sort}
            onChange={(e) => {
              if (isSortKey(e.target.value)) setSort(e.target.value);
            }}
          >
            {Object.entries(SORTS).map(([key, { label }]) => (
              <option key={key} value={key}>
                Sort by {label}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={14} />
        </label>
      </div>

      <section className="ag-grid fill">
        {list.map((a, i) => (
          <article key={a.name} className="card pad24 col g16 rise ag-card" style={stagger(i)}>
            <div className="row g12">
              <AgentAvatar kind={a.kind} size={48} />
              <div className="col grow">
                <h2 className="title">{a.name}</h2>
                <span className="small c3">{a.tasks} tasks settled</span>
              </div>
              {a.verified ? <Badge status="Verified" /> : <Badge status="Neutral" label="Unverified" />}
            </div>
            <p className="c2">{a.description}</p>
            <div className="row g6">
              {a.tags.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </div>
            <div className="inner cells mt-auto">
              <div>
                <span className="small c3">Success</span>
                <span className="strong">{a.success}%</span>
              </div>
              <div>
                <span className="small c3">Median</span>
                <span className="strong">{a.median}</span>
              </div>
              <div className="wide">
                <span className="small c3">Model</span>
                <span className="strong ellipsis">{a.model}</span>
              </div>
            </div>
            <div className="row between">
              <span className="mono-s c3">{a.address}</span>
              <Button variant="link" compact icon="arrowRight">
                View identity
              </Button>
            </div>
          </article>
        ))}
        {list.length === 0 && <p className="c3">No agents match these filters.</p>}
      </section>
    </>
  );
}
