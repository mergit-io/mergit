import { Icon } from "../../components/Icon";
import { connected } from "../content";
import { useInView } from "../motion";
import { SectionHead } from "./SectionHead";

export function Connected() {
  const [ref, inView] = useInView<HTMLElement>();
  return (
    <section
      id="integrations"
      ref={ref}
      className={`l-section l-white${inView ? " in" : ""}`}
      aria-labelledby="connected-title"
    >
      <div className="l-container">
        <SectionHead id="connected-title" eyebrow={connected.eyebrow} title={connected.title} lede={connected.lede} />
        <ul className="connected-grid">
          {connected.apps.map((app, i) => (
            <li
              key={app.app}
              className="connected-card l-reveal"
              style={{ transitionDelay: `${String(220 + i * 90)}ms` }}
            >
              <div className="row between">
                <span className="connected-mark">
                  {app.mark === "GH" ? <Icon name="github" size={30} /> : app.mark}
                </span>
                <span className="connected-app">{app.app}</span>
              </div>
              <h3>{app.title}</h3>
              <p>{app.body}</p>
              <span className="connected-trace">{app.trace}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
