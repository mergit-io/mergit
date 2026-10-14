import { credentials } from "../content";
import { LIcon } from "../LIcon";
import { useInView, useTypewriter } from "../motion";

export function Credentials() {
  const [ref, inView] = useInView<HTMLElement>(0.3);
  const [dots] = useTypewriter("•••• •••• ••••", inView, 70, 500);
  return (
    <section id="security" ref={ref} className={`l-band${inView ? " in" : ""}`} aria-labelledby="cred-title">
      <div className="l-container band-grid">
        <div>
          <span className="l-eyebrow l-reveal">{credentials.eyebrow}</span>
          <h2 id="cred-title" className="band-title l-reveal" style={{ transitionDelay: "80ms" }}>
            {credentials.title.map((line, i) => (
              <span key={line} className="band-line">
                {i > 0 && " "}
                {line}
              </span>
            ))}
          </h2>
          <p className="band-lede l-reveal" style={{ transitionDelay: "180ms" }}>
            {credentials.lede}
          </p>
        </div>
        <div className="band-flow">
          <div className="band-cards">
            <div className="band-card l-reveal" style={{ transitionDelay: "260ms" }}>
              <LIcon name="lock" size={24} />
              <span className="band-card-title">{credentials.sealed}</span>
              <span className="band-dots" aria-label="Sealed credential">
                {dots}
              </span>
            </div>
            <span className="band-arrow l-reveal" aria-hidden="true" style={{ transitionDelay: "380ms" }}>
              →
            </span>
            <div className="band-card l-reveal" style={{ transitionDelay: "460ms" }}>
              <LIcon name="plug" size={24} />
              <span className="band-card-title">{credentials.tools}</span>
              <span className="l-mono band-muted">{credentials.scope}</span>
            </div>
          </div>
          <p className="band-note l-reveal" style={{ transitionDelay: "600ms" }}>
            <LIcon name="shield" size={14} /> {credentials.note}
          </p>
        </div>
      </div>
    </section>
  );
}
