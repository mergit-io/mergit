import { proofOfWork } from "../content";
import { LIcon } from "../LIcon";
import { useInView, useStepper } from "../motion";
import { SectionHead } from "./SectionHead";

export function ProofOfWork() {
  const [ref, inView] = useInView<HTMLElement>(0.2);
  const { receipt, identity } = proofOfWork;
  const reached = useStepper(receipt.steps.length, inView, 550, 700);

  return (
    <section id="proofs" ref={ref} className={`l-section l-white${inView ? " in" : ""}`} aria-labelledby="proof-title">
      <div className="l-container">
        <SectionHead
          id="proof-title"
          split
          eyebrow={proofOfWork.eyebrow}
          title={
            <>
              {proofOfWork.title[0]}
              <br />
              {proofOfWork.title[1]}
            </>
          }
          lede={proofOfWork.lede}
        />
        <div className="proof-grid">
          <article className="receipt l-reveal" style={{ transitionDelay: "220ms" }}>
            <div className="row between g12">
              <h3 className="row g12">
                <LIcon name="checkCircle" size={30} stroke={1.8} /> {receipt.title}
              </h3>
              <span className="l-pill green">{receipt.badge}</span>
            </div>
            <div className="receipt-hash">
              <span className="l-eyebrow small">{receipt.hashLabel}</span>
              <span className="l-mono receipt-hash-value">{receipt.hash}</span>
              <span className="receipt-hash-note">{receipt.hashNote}</span>
            </div>
            <dl className="receipt-facts">
              {receipt.facts.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <ol className="receipt-steps" aria-label={`Settlement: ${receipt.steps.join(", ")}`}>
              {receipt.steps.map((step, i) => (
                <li
                  key={step}
                  className={`${reached > i ? "on" : ""}${reached === receipt.steps.length && i === receipt.steps.length - 1 ? " final" : ""}`}
                >
                  <span className="receipt-dot" />
                  <span className="l-mono">{step}</span>
                </li>
              ))}
            </ol>
          </article>

          <article className="identity l-reveal" style={{ transitionDelay: "320ms" }}>
            <div className="row between">
              <span className="identity-icon">
                <LIcon name="fingerprint" size={40} stroke={1.6} />
              </span>
              <span className="l-pill white">{identity.badge}</span>
            </div>
            <h3>{identity.title}</h3>
            <p>{identity.body}</p>
            <div className="identity-note">
              <span className="l-mono green">{identity.label}</span>
              <span>{identity.detail}</span>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
