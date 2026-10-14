import { useEffect, useState } from "react";
import { Switch } from "../../components/Switch";
import { approval } from "../content";
import { LIcon } from "../LIcon";
import { prefersReducedMotion, useInView, useTypewriter } from "../motion";

type Decision = "none" | "approved" | "denied";

/** The signed or denied chip, typed out fresh for each decision. */
function Result({ approved, text }: { approved: boolean; text: string }) {
  const [typed] = useTypewriter(text, true, 18);
  return (
    <span className={`l-pill ${approved ? "green" : "rose"} approval-result`} aria-hidden="true">
      {approved && <LIcon name="check" size={12} stroke={2.6} />} {typed}
    </span>
  );
}

/** Live approval card: the switches turn on when the card arrives, and Approve signs. */
export function Approval() {
  const [ref, inView] = useInView<HTMLElement>(0.3);
  const [asks, setAsks] = useState(approval.asks.map(() => false));
  const [decision, setDecision] = useState<Decision>("none");
  const [round, setRound] = useState(0);
  const message = decision === "approved" ? approval.signed : decision === "denied" ? approval.denied : "";

  useEffect(() => {
    if (!inView) return;
    const timer = window.setTimeout(
      () => {
        setAsks(approval.asks.map(() => true));
      },
      prefersReducedMotion() ? 0 : 900,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [inView]);

  const decide = (next: Decision) => {
    setDecision(next);
    setRound((r) => r + 1);
  };

  return (
    <section ref={ref} className={`l-section l-gray${inView ? " in" : ""}`} aria-labelledby="approval-title">
      <div className="l-container approval-grid">
        <div>
          <span className="l-eyebrow l-reveal">{approval.eyebrow}</span>
          <h2 id="approval-title" className="l-h2 l-reveal" style={{ transitionDelay: "80ms" }}>
            {approval.title}
          </h2>
          <p className="l-lede l-reveal" style={{ transitionDelay: "180ms" }}>
            {approval.lede}
          </p>
          <ul className="approval-points">
            {approval.points.map((point, i) => (
              <li key={point} className="l-reveal" style={{ transitionDelay: `${String(320 + i * 120)}ms` }}>
                <LIcon name="check" size={16} stroke={2.2} /> {point}
              </li>
            ))}
          </ul>
        </div>

        <div className="l-card approval-card l-reveal" style={{ transitionDelay: "160ms" }}>
          <div className="row between">
            <h3>Needs your approval</h3>
            <span className="l-pill gray">Demo</span>
          </div>
          <div className="approval-action">
            <span className="l-mono muted">{approval.tool}</span>
            <span className="approval-title">{approval.action}</span>
            <span className="l-mono muted">{approval.target}</span>
            <span className="approval-tags">
              {approval.tags.map((tag, i) => (
                <span key={tag} className="l-pill green pop" style={{ animationDelay: `${String(700 + i * 150)}ms` }}>
                  {tag}
                </span>
              ))}
            </span>
          </div>
          <div className="approval-buttons">
            <button
              type="button"
              className="l-btn"
              aria-pressed={decision === "approved"}
              onClick={() => {
                decide("approved");
              }}
            >
              Approve action <LIcon name="arrowUpRight" size={14} stroke={2} />
            </button>
            <button
              type="button"
              className="l-btn-ghost"
              aria-pressed={decision === "denied"}
              onClick={() => {
                decide("denied");
              }}
            >
              Deny <LIcon name="arrowUpRight" size={14} stroke={2} />
            </button>
            <span className="sr-only" role="status">
              {message}
            </span>
            {decision !== "none" && <Result key={round} approved={decision === "approved"} text={message} />}
          </div>
          <div className="approval-asks">
            <h4>Ask me before</h4>
            {approval.asks.map((ask, i) => (
              <div key={ask} className="row between">
                <span>{ask}</span>
                <Switch
                  checked={asks[i] ?? false}
                  label={ask}
                  onChange={(on) => {
                    setAsks((list) => list.map((v, j) => (j === i ? on : v)));
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
