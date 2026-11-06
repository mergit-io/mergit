import { Link } from "react-router-dom";
import { paths } from "../../app/paths";
import { useAuth } from "../../auth/context";
import { useLedger } from "../../chain/useLedger";
import { Icon, type IconName } from "../../components/Icon";
import { MergitLogo } from "../../components/MergitLogo";
import { ThemeToggle } from "../../components/ThemeToggle";
import { LIVE } from "../../config/live";
import { ledgerView, type LedgerView } from "./ledgerView";
import "../../styles/screens/pricing.css";
import "../../styles/screens/agent-profile.css";

const TONE_ICON: Record<LedgerView["verdict"]["tone"], IconName | null> = {
  ok: "tick",
  bad: "fail",
  warn: "clock",
  none: null,
};

function Rows({ rows, caption }: { rows: { label: string; value: string }[]; caption: string }) {
  return (
    <dl className="ap-dl" aria-label={caption}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "contents" }}>
          <dt>{r.label}</dt>
          <dd className="mono ap-break">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Ledger({ view }: { view: LedgerView }) {
  const icon = TONE_ICON[view.verdict.tone];
  return (
    <>
      <div className="col g12 page-enter">
        <h1 className="pr-title ap-title">{view.title}</h1>
        <p className="row g8 strong ap-line" data-tone={view.verdict.tone} data-testid="ledger-verdict">
          {icon && <Icon name={icon} size={18} />}
          <span>{view.verdict.text}</span>
        </p>
        {view.sentences.map((s) => (
          <p key={s} className="c2 ap-break">
            {s}
          </p>
        ))}
        {view.commitment && <p className="small c3">{view.commitment}</p>}
      </div>

      {view.hashCheck && (
        <section className="card pad24 col g12" aria-labelledby="lg-hash-title">
          <h2 id="lg-hash-title" className="heading">
            Hash check
          </h2>
          <p className="c2" data-testid="ledger-hash-check">
            {view.hashCheck.sentence}
          </p>
          <Rows
            caption="Committed and computed hashes"
            rows={[
              { label: "Committed on ENS", value: view.hashCheck.committed },
              { label: "Computed from the file", value: view.hashCheck.computed },
            ]}
          />
        </section>
      )}

      {view.record.length > 0 && (
        <section className="card pad24 col g12" aria-labelledby="lg-record-title">
          <h2 id="lg-record-title" className="heading">
            The ENS record
          </h2>
          {view.range && <p className="c2">{view.range}</p>}
          <Rows caption="Fields of the mergit.ledger record" rows={view.record} />
          {view.note.length > 0 && (
            <div className="ap-context">
              {view.note.map((line, i) => (
                // Lines can repeat, and they never move: the index is a stable key here.
                <p key={i}>{line}</p>
              ))}
            </div>
          )}
          {view.fileUrl && (
            <p>
              <a className="mono ap-break" href={view.fileUrl} target="_blank" rel="noopener noreferrer">
                Open the snapshot file
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          )}
        </section>
      )}

      {view.totals.length > 0 && (
        <section className="card pad24 col g12" aria-labelledby="lg-totals-title">
          <h2 id="lg-totals-title" className="heading">
            Totals
          </h2>
          {view.createdAt && <p className="small c3">Snapshot taken {view.createdAt}.</p>}
          <Rows caption="Totals in the snapshot" rows={view.totals} />
        </section>
      )}

      {view.agents.length > 0 && (
        <section className="card pad24 col g12" aria-labelledby="lg-agents-title">
          <h2 id="lg-agents-title" className="heading">
            Agents
          </h2>
          <table className="ledger-table">
            <caption className="sr-only">Outcomes and staked counts per agent in the snapshot</caption>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Outcomes</th>
                <th scope="col">Passed</th>
                <th scope="col">Audited</th>
                <th scope="col">Verified</th>
              </tr>
            </thead>
            <tbody>
              {view.agents.map((a) => (
                <tr key={a.agentId}>
                  <td className="ap-break">
                    <span className="strong">{a.name}</span> <span className="mono c3">#{a.agentId}</span>
                  </td>
                  <td className="mono">{a.outcomes}</td>
                  <td className="mono">{a.passed}</td>
                  <td className="mono">{a.audited}</td>
                  <td className="mono">{a.verified}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

/**
 * The public final ledger at `/ledger`: the `mergit.ledger` record on `mergit.eth`, the snapshot file it commits to,
 * and whether the file's keccak256 matches. No session is needed. Everything is shown as text; the only link is the
 * https file the record names.
 */
export function LedgerPage() {
  const { session } = useAuth();
  const ledger = useLedger();
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
      <main className="pr-main ap-main">
        {ledger.state === "loading" && <p className="c2">Reading the final ledger from ENS…</p>}
        {ledger.state === "off" && <p className="c2">The final ledger is shown only on the live site.</p>}
        {ledger.state === "ready" && <Ledger view={ledgerView(ledger.value, { chainName: LIVE.chainName })} />}
      </main>
    </div>
  );
}
