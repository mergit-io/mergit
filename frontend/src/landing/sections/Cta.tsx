import { Link } from "react-router-dom";
import { paths } from "../../app/paths";
import { useAuth } from "../../auth/context";
import { BrandMark } from "../../components/Icon";
import { cta, footer } from "../content";
import { LIcon } from "../LIcon";
import { useInView } from "../motion";

export function Cta() {
  const [ref, inView] = useInView<HTMLElement>(0.3);
  const { openConnect } = useAuth();
  return (
    <section ref={ref} className={`l-cta${inView ? " in" : ""}`} aria-labelledby="cta-title">
      <div className="l-container cta-inner">
        <span className="l-eyebrow l-reveal">{cta.eyebrow}</span>
        <h2 id="cta-title" className="cta-title l-reveal" style={{ transitionDelay: "80ms" }}>
          {cta.title[0]}
          <br />
          {cta.title[1]}
        </h2>
        <p className="l-lede l-reveal" style={{ transitionDelay: "180ms" }}>
          {cta.lede}
        </p>
        <button
          type="button"
          className="l-btn l-btn-lg l-reveal"
          style={{ transitionDelay: "280ms" }}
          onClick={() => {
            openConnect();
          }}
        >
          Try the demo <LIcon name="arrowUpRight" size={16} stroke={2} />
        </button>
        <span className="l-mono muted l-reveal" style={{ transitionDelay: "360ms" }}>
          {cta.note}
        </span>
      </div>
    </section>
  );
}

export function Footer() {
  const { openConnect } = useAuth();
  return (
    <footer className="l-footer">
      <div className="l-container">
        <div className="footer-top">
          <div className="col g12">
            <Link to={paths.landing} className="l-brand" aria-label="Mergit home">
              <BrandMark size={48} />
              <span>Mergit</span>
            </Link>
            <p className="muted">{footer.tagline}</p>
          </div>
          <nav className="footer-cols" aria-label="Footer">
            {footer.columns.map((col) => (
              <div key={col.title}>
                <span className="l-eyebrow small">{col.title}</span>
                <ul>
                  {col.links.map(([label, href]) => (
                    <li key={label}>
                      <a href={href}>{label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div>
              <span className="l-eyebrow small">Get started</span>
              <ul>
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      openConnect();
                    }}
                  >
                    Try the demo
                  </button>
                </li>
                <li>
                  <Link to={paths.signIn}>Sign in</Link>
                </li>
              </ul>
            </div>
          </nav>
        </div>
        <div className="footer-bottom">
          <span className="muted">© {new Date().getFullYear()} Mergit</span>
          <span className="l-mono muted">{footer.settle}</span>
        </div>
      </div>
    </footer>
  );
}
