import { AgentAvatar } from "../components/AgentAvatar";
import { Badge } from "../components/Badge";
import { BrandMark, Icon } from "../components/Icon";
import { Button } from "../components/Button";
import { PageHeader } from "../components/PageHeader";
import { Spark } from "../components/Spark";
import { stagger } from "../lib/stagger";
import { me, wallet } from "../mock/data";
import { useCopy } from "../hooks/useCopy";
import { useNotWired } from "../hooks/useNotWired";
import { useWidth } from "../hooks/useWidth";
import "../styles/screens/wallet.css";

/** Fits the 380px outbox card at its 20px padding; wider when the card stretches. */
const LAG_CHART = { width: 338, height: 52 };

export function Wallet() {
  const copy = useCopy();
  const notWired = useNotWired();
  const [lagRef, lagWidth] = useWidth<HTMLDivElement>(LAG_CHART.width);

  return (
    <>
      <PageHeader
        title="Wallet and identity"
        subtitle="The key that signs receipts, where they settle, and the identity each agent carries."
        actions={
          <>
            <Button icon="link">Switch chain</Button>
            <Button variant="primary" icon="plus">
              Fund wallet
            </Button>
          </>
        }
      />

      <section className="wl-top">
        <div className="wl-card">
          <div className="row between">
            <div className="row g8">
              <BrandMark size={28} />
              <span className="strong">Signing wallet</span>
            </div>
            <Badge status="Completed" label="Connected" className="glass" />
          </div>
          <div className="col g4">
            <span className="small c2">Balance</span>
            <span className="wl-balance">
              {wallet.balance} <span className="wl-unit">{wallet.unit}</span>
            </span>
          </div>
          <div className="row between">
            <span className="mono wl-address">{me.addressLong}</span>
            <button
              type="button"
              className="row g6 small c2 wl-copy"
              onClick={() => {
                copy(me.addressFull, "Address copied");
              }}
            >
              <Icon name="copy" size={14} />
              Copy
            </button>
          </div>
        </div>

        <div className="card pad24 col g16">
          <div className="row between">
            <h2 className="title">Agent identity</h2>
            <Badge status="Verified" label="ERC-8004" />
          </div>
          <div className="row g16">
            <AgentAvatar kind={wallet.identity.avatar} size={56} />
            <div className="col g4 grow">
              <span className="heading wl-team">{wallet.identity.name}</span>
              <span className="mono-s c3">{wallet.identity.did}</span>
            </div>
          </div>
          <dl className="wl-stats">
            {wallet.identity.stats.map(([label, value]) => (
              <div key={label} className="inner pad-md col">
                <dt className="small c3">{label}</dt>
                <dd className="stat wl-stat">{value}</dd>
              </div>
            ))}
          </dl>
          <span className="small c3">{wallet.identity.note}</span>
        </div>
      </section>

      <section className="wl-bottom fill">
        <div className="card col min0">
          <div className="hd">
            <h2 className="title">Proof outbox</h2>
            <span className="small c3">retries every {wallet.outboxRetry}</span>
          </div>
          <div className="row g12 wl-outbox">
            {wallet.outbox.map((item) => (
              <div key={item.label} className="inner col wl-outbox-cell">
                <span className="small c3">{item.label}</span>
                <span className={`title wl-outbox-value ${item.tone}`}>{item.value}</span>
              </div>
            ))}
          </div>
          {wallet.contracts.map(([name, address]) => (
            <button key={name} type="button" className="tr short" onClick={notWired}>
              <span className="strong grow">{name}</span>
              <span className="mono c2">{address}</span>
              <Icon name="external" size={14} color="var(--ink3)" />
            </button>
          ))}
          <div className="col g6 mt-auto wl-lag-wrap">
            <div className="row between">
              <span className="small c3">Settlement lag, today</span>
              <span className="mono-s">median {wallet.lagMedian}</span>
            </div>
            <div className="wl-lag" ref={lagRef}>
              <Spark points={wallet.lag} color="var(--mint)" width={lagWidth} height={LAG_CHART.height} />
            </div>
          </div>
        </div>

        <div className="card col min0">
          <div className="hd">
            <h2 className="title">Recent settlements</h2>
            <Button variant="link" compact>
              All proofs
            </Button>
          </div>
          <div className="tbl-h">
            <span className="grow">Task</span>
            <span className="w-100 hide-md">Block</span>
            <span className="w-110 hide-sm">Transaction</span>
            <span className="w-120">Status</span>
            <span className="w-60 text-right hide-sm">When</span>
          </div>
          <div className="scroll">
            {wallet.settlements.map((s, i) => (
              <div key={s.tx} className="tr rise wl-row" style={stagger(i)}>
                <div className="row g10 grow">
                  <AgentAvatar kind={s.agent} size={26} labelled />
                  <span className="strong ellipsis">{s.task}</span>
                </div>
                <span className="mono c2 w-100 hide-md">{s.block}</span>
                <span className={`mono w-110 hide-sm ${s.settled ? "cz" : "c3"}`}>{s.tx}</span>
                <span className="w-120">
                  {s.settled ? (
                    <Badge status="Verified" label="Settled" />
                  ) : (
                    <Badge status="Running" label="Awaiting chain" />
                  )}
                </span>
                <span className="small c3 w-60 text-right hide-sm">{s.when} ago</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
