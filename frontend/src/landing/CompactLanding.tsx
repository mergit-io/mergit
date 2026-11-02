import { Link } from "react-router-dom";
import { paths } from "../app/paths";
import { useAuth } from "../auth/context";
import { LIcon } from "./LIcon";
import { LandingNav } from "./sections/LandingNav";
import { Faq } from "./sections/Faq";
import { Footer } from "./sections/Cta";
import { footerFor, navFor } from "./story/storyConfig";
import { storyCopy as c } from "./story/copy";
import "../styles/landing/compact.css";

/** How full each bar is, as a share of its track. The same example numbers the story's problem scene draws. */
const METER_FILL = [92, 70, 81] as const;

/**
 * The landing page for every screen the pinned scroll story does not fit (phones, tablets, short windows) and for
 * people who ask for less motion. The same four parts as the story, in the same words, laid out as ordinary sections
 * that reflow at any width: hero, the problem, how a plan settles, and the call to action. Nothing here is pinned,
 * scaled from a fixed artboard or scroll-driven.
 */
export function CompactLanding() {
  const { openConnect } = useAuth();
  return (
    <div className="landing compact-mode">
      <div className="landing-page">
        <LandingNav links={navFor("lean")} />
        <main>
          <section className="cp-hero" aria-labelledby="cp-title">
            <div className="l-container cp-hero-inner">
              <span className="cp-pill">{c.hero.eyebrow}</span>
              <h1 id="cp-title" className="cp-display">
                {c.hero.title} <em>{c.hero.accent}</em>
              </h1>
              <p className="cp-lede">{c.hero.lede.join(" ")}</p>
              <div className="cp-actions">
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
              </div>
            </div>
          </section>

          <section id="problem" className="cp-section" aria-labelledby="cp-problem">
            <div className="l-container">
              <span className="l-eyebrow">{c.problem.eyebrow}</span>
              <h2 id="cp-problem" className="cp-h2">
                {c.problem.title[0]} <em>{c.problem.title[1]}</em>
              </h2>
              <div className="cp-cards">
                <article className="cp-card" aria-label={c.problem.today}>
                  <h3 className="cp-card-title">{c.problem.today}</h3>
                  <ul className="cp-meters">
                    {c.problem.meters.map((m, i) => (
                      <li key={m}>
                        <span>{m}</span>
                        <i className="cp-track" aria-hidden="true">
                          <b style={{ width: `${String(METER_FILL[i] ?? 80)}%` }} />
                        </i>
                      </li>
                    ))}
                    <li className="cp-none">
                      <span>Task done?</span>
                      <strong>{c.problem.notMetered}</strong>
                    </li>
                  </ul>
                </article>
                <article className="cp-card cp-card-good" aria-label="Mergit">
                  <h3 className="cp-card-title">
                    Mergit <span className="cp-chip">{c.problem.chip}</span>
                  </h3>
                  <ul className="cp-meters cp-faded">
                    {c.problem.meters.map((m, i) => (
                      <li key={m}>
                        <span>{m}</span>
                        <i className="cp-track" aria-hidden="true">
                          <b style={{ width: `${String(METER_FILL[i] ?? 80)}%` }} />
                        </i>
                      </li>
                    ))}
                    <li className="cp-ok">
                      <span>Verified</span>
                      <i className="cp-track" aria-hidden="true">
                        <b style={{ width: "100%" }} />
                      </i>
                    </li>
                  </ul>
                </article>
              </div>
            </div>
          </section>

          <section id="how-it-works" className="cp-section cp-alt" aria-labelledby="cp-settle">
            <div className="l-container">
              <span className="l-eyebrow">{c.settle.side[0]}</span>
              <h2 id="cp-settle" className="cp-h2">
                How a plan <em>settles.</em>
              </h2>
              <p className="cp-lede">{c.settle.side[1]}</p>
              <ol className="cp-steps">
                {c.settle.steps.map(([title, body], i) => (
                  <li key={title} className="cp-step">
                    <span className="cp-num" aria-hidden="true">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <span className="cp-rail">{c.settle.rail[i]}</span>
                      <h3>{title}</h3>
                      <p>{body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <section className="cp-section cp-close" aria-labelledby="cp-close">
            <div className="l-container cp-close-inner">
              <span className="l-eyebrow">{c.closer.eyebrow}</span>
              <h2 id="cp-close" className="cp-display cp-display-sm">
                {c.closer.title[0]} {c.closer.title[1]} <em>{c.closer.accent}</em>
              </h2>
              <p className="cp-lede">{c.closer.lede}</p>
              <div className="cp-actions">
                <button
                  type="button"
                  className="l-btn l-btn-lg"
                  onClick={() => {
                    openConnect();
                  }}
                >
                  Get started <LIcon name="arrowUpRight" size={16} stroke={2} />
                </button>
                <Link to={paths.signIn} className="l-btn-ghost l-btn-lg">
                  Sign in
                </Link>
              </div>
              <span className="l-mono muted">{c.closer.note}</span>
            </div>
          </section>

          <Faq />
        </main>
        <Footer columns={footerFor("lean")} />
      </div>
    </div>
  );
}
