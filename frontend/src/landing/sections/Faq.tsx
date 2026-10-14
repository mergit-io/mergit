import { faq } from "../content";
import { useInView } from "../motion";

export function Faq() {
  const [ref, inView] = useInView<HTMLElement>(0.2);
  return (
    <section id="faq" ref={ref} className={`l-section l-gray${inView ? " in" : ""}`} aria-labelledby="faq-title">
      <div className="l-container faq-grid">
        <div>
          <span className="l-eyebrow l-reveal">{faq.eyebrow}</span>
          <h2 id="faq-title" className="l-h2 l-reveal" style={{ transitionDelay: "80ms" }}>
            {faq.title}
          </h2>
          <p className="l-lede l-reveal" style={{ transitionDelay: "180ms" }}>
            {faq.lede}
          </p>
        </div>
        <div className="faq-list">
          {faq.items.map((item, i) => (
            <details
              key={item.q}
              open
              className="faq-item l-reveal"
              style={{ transitionDelay: `${String(200 + i * 110)}ms` }}
            >
              <summary>
                {item.q}
                <span className="faq-sign" aria-hidden="true" />
              </summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
