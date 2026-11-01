import { Link } from "react-router-dom";
import { paths } from "../app/paths";
import { useAuth } from "../auth/context";
import { Icon } from "../components/Icon";
import { MergitLogo } from "../components/MergitLogo";
import { PlanCards } from "../components/PlanCards";
import { ThemeToggle } from "../components/ThemeToggle";
import { COMPARISON, PLANS, type Cell } from "../pricing/plans";
import "../styles/screens/pricing.css";

function CellView({ cell }: { cell: Cell }) {
  if ("yes" in cell)
    return (
      <span className="pr-yes">
        <Icon name="tick" size={16} stroke={2.4} />
        <span className="sr-only">Yes</span>
      </span>
    );
  if ("no" in cell)
    return (
      <span className="pr-no">
        –<span className="sr-only">No</span>
      </span>
    );
  if ("soon" in cell) return <span className="plan-soon">Soon</span>;
  return <span>{cell.text}</span>;
}

/**
 * The public pricing page. Its actions use the same paths the dialog does: Free signs in (or opens the dashboard,
 * where the plan choice starts the trial), Pay as you go opens the wallet connect, Premium is not built yet.
 */
export function Pricing() {
  const { session, openConnect } = useAuth();

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

      <main className="pr-main">
        <div className="col g12 pr-head page-enter">
          <h1 className="pr-title">Pricing</h1>
          <p className="c2 pr-lede">
            Start free with 5 USDC of test credits, no wallet needed. Connect a wallet when you want to fund your own
            work. Every plan settles the same way: escrow first, release after verification.
          </p>
          <ul className="pr-assure small">
            {["Escrow before work starts", "Paid only after verification", "A receipt on chain for every task"].map(
              (t) => (
                <li key={t}>
                  <Icon name="tick" size={14} stroke={2.6} />
                  {t}
                </li>
              ),
            )}
          </ul>
        </div>

        <PlanCards
          action={(plan) => {
            if (plan.soon)
              return (
                <button type="button" className="btn secondary block" disabled>
                  Coming soon
                </button>
              );
            if (plan.id === "free")
              return (
                <Link to={session ? paths.app : paths.signIn} className="btn primary block">
                  {session ? "Open dashboard" : "Start free"}
                </Link>
              );
            return (
              <button
                type="button"
                className="btn secondary block"
                onClick={() => {
                  openConnect();
                }}
              >
                <Icon name="wallet" size={16} />
                Connect a wallet
              </button>
            );
          }}
        />

        <h2 className="pr-sub" id="compare">
          Compare plans
        </h2>
        <div className="pr-table-wrap">
          <table className="pr-table">
            <caption className="sr-only">What each plan includes</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Feature</span>
                </th>
                {PLANS.map((plan) => (
                  <th key={plan.id} scope="col">
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            {COMPARISON.map((group) => (
              <tbody key={group.title}>
                <tr className="pr-group">
                  <th scope="colgroup" colSpan={PLANS.length + 1}>
                    {group.title}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">
                      {row.label}
                      {row.hint && <span className="pr-hint">{row.hint}</span>}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td key={PLANS[i]?.id}>
                        <CellView cell={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>

        <section className="pr-cta" aria-labelledby="pr-cta-title">
          <h2 id="pr-cta-title" className="pr-cta-title">
            Start free. Pay when you are ready.
          </h2>
          <p className="c2">5 USDC of test credits, no wallet, and every task leaves a receipt you can check.</p>
          <div className="row g12 pr-cta-actions">
            <Link to={session ? paths.app : paths.signIn} className="btn primary">
              {session ? "Open dashboard" : "Get 5 USDC free"}
            </Link>
            <a href="#compare" className="btn secondary">
              Compare plans
            </a>
          </div>
        </section>

        <p className="small c3 pr-foot">
          Mergit runs on the Base Sepolia testnet. Test funds only: nothing here is real money. The free-trial limits
          are the current settings and can change. Premium credit packs are not available yet.
        </p>
      </main>
    </div>
  );
}
