import type { Ref } from "react";
import { paths } from "../../app/paths";
import { useAuth } from "../../auth/context";
import { Icon } from "../../components/Icon";
import { hero } from "../content";
import { Globe } from "../Globe";
import { LIcon, LinearMark } from "../LIcon";
import { AgentDemo } from "./AgentDemo";
import { ProofChain } from "./ProofChain";

const TOOL_ICON = {
  GitHub: <Icon name="github" size={18} />,
  Linear: <LinearMark size={18} />,
  Slack: <LIcon name="thread" size={18} />,
};

/**
 * `ready` starts the entrance choreography once the intro has handed over
 * (or straight away when it is skipped).
 */
export function Hero({ ready, globeRef }: { ready: boolean; globeRef: Ref<HTMLDivElement> }) {
  const { openConnect } = useAuth();
  return (
    <section className={`l-hero${ready ? " ready" : ""}`}>
      <div className="l-hero-globe" ref={globeRef}>
        <Globe label="Dotted globe of settled agent actions" />
      </div>
      <div className="l-container l-hero-grid">
        <div className="l-hero-copy">
          <span className="l-tag">
            <i className="live-dot" /> {hero.eyebrow}
          </span>
          <h1 className="l-hero-title">
            {hero.title.map((word, i) => (
              <span
                key={`${word}-${String(i)}`}
                className={`l-word${(hero.highlight as readonly number[]).includes(i) ? " hl" : ""}`}
                style={{ transitionDelay: `${String(120 + i * 70)}ms` }}
              >
                {word}{" "}
              </span>
            ))}
          </h1>
          <p className="l-hero-lede l-enter" style={{ transitionDelay: "820ms" }}>
            {hero.lede}
          </p>
          <div className="l-hero-actions l-enter" style={{ transitionDelay: "960ms" }}>
            <button
              type="button"
              className="l-btn l-btn-lg"
              onClick={() => {
                openConnect();
              }}
            >
              Get started <LIcon name="arrowUpRight" size={16} stroke={2} />
            </button>
            <a href={paths.demo} className="l-btn-ghost l-btn-lg">
              View demo <LIcon name="arrowUpRight" size={16} stroke={2} />
            </a>
            <a href="#how-it-works" className="l-btn-ghost l-btn-lg">
              See how it works <LIcon name="arrowUpRight" size={16} stroke={2} />
            </a>
          </div>
          <p className="l-hero-notes l-enter" style={{ transitionDelay: "1100ms" }}>
            <span>
              <LIcon name="home" size={14} /> {hero.notes[0]}
            </span>
            <span className="l-sep" aria-hidden="true" />
            <span>
              <LIcon name="link" size={14} /> {hero.notes[1]}
            </span>
          </p>
        </div>

        <div className="l-hero-stage l-enter" style={{ transitionDelay: "300ms" }}>
          <div className="l-ghost-card" aria-hidden="true" />
          <span className="l-float-tile t-github" aria-hidden="true">
            <Icon name="github" size={34} />
          </span>
          <span className="l-float-tile t-linear" aria-hidden="true">
            <LinearMark size={34} />
          </span>
          <span className="l-float-tile t-chain" aria-hidden="true">
            <LIcon name="diamond" size={30} stroke={1.6} />
          </span>
          <p className="l-handwriting" aria-hidden="true">
            {hero.handwriting.map((word, i) => (
              <span key={word} style={{ animationDelay: `${String(1500 + i * 260)}ms` }}>
                {word}
              </span>
            ))}
          </p>
          <AgentDemo start={ready} />
          <ProofChain start={ready} />
        </div>
      </div>

      <div className="l-tools l-enter" style={{ transitionDelay: "1250ms" }}>
        <span className="l-eyebrow">Works with your favorite tools</span>
        <ul>
          {hero.tools.map((tool) => (
            <li key={tool}>
              {TOOL_ICON[tool as keyof typeof TOOL_ICON]} {tool}
            </li>
          ))}
          <li className="more">+ More</li>
        </ul>
      </div>
    </section>
  );
}
