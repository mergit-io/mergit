import { useLayoutEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { paths } from "../../app/paths";
import { useAuth } from "../../auth/context";
import { MergitLogo } from "../../components/MergitLogo";
import symbolColour from "./assets/symbol-colour.svg?raw";
import { storyCopy as c } from "./copy";
import { anchorPx, anchorsFor, variantTrack, type Variant } from "./storyConfig";
import { mountStory } from "./timeline";

const Mask = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className="mask">
    <span className={className}>{children}</span>
  </span>
);

const Iso = ({ id, left, top }: { id: string; left: number; top: number }) => (
  <svg id={id} className="iso-svg" style={{ left, top }} width="1" height="1" aria-hidden="true" />
);

function Stepper({
  id,
  rail,
  stat,
  side,
  steps,
  children,
}: {
  id: string;
  rail: readonly string[];
  stat: readonly [string, string];
  side: readonly [string, string];
  steps: readonly (readonly [string, string])[];
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="rail" id={`${id}-rail`}>
        <div className="rail-hl" />
        <ol className="rail-list">
          {rail.map((r, i) => (
            <li key={r} className="ri">
              [0{i + 1} // {r}]
            </li>
          ))}
        </ol>
        <div className="rail-side">
          <span className="lbl dim">{side[0]}</span>
          <p>{side[1]}</p>
        </div>
      </div>
      {children}
      <div className="panel" id={`${id}-panel`}>
        <div className="panel-n">
          <span className="pn">01</span>
          <span className="lbl dim"> / 0{steps.length}</span>
        </div>
        <div className="panel-stat lbl dim">
          <span>{stat[0]}</span>
          <i />
          <span>{stat[1]}</span>
        </div>
        <div className="panel-card">
          {steps.map(([h, p]) => (
            <div key={h} className="pt">
              <i className="sq" />
              <h3>{h}</h3>
              <p>{p}</p>
            </div>
          ))}
        </div>
        <div className="flow-ctl">
          <button type="button" data-flow-act="toggle" aria-label="Pause the animation">
            Pause
          </button>
          <button type="button" data-flow-act="replay" aria-label="Replay from the start">
            Replay
          </button>
        </div>
      </div>
    </>
  );
}

export function StoryStage({ variant }: { variant: Variant }) {
  const root = useRef<HTMLDivElement>(null);
  const art = useRef<SVGSVGElement>(null);
  const track = variantTrack(variant);
  // Someone already signed in goes straight to the dashboard, as the nav's "Open dashboard" does.
  const { session } = useAuth();
  const getStarted = session ? paths.app : paths.signIn;

  useLayoutEffect(() => {
    if (!root.current || !art.current) return;
    return mountStory(root.current, art.current, variant);
  }, [variant]);

  // The demo is its own page (/demo, sample data, no sign-in); the sign-in button sits beside it.
  const demo = (
    <a href={paths.demo} className="sbtn primary">
      View demo
    </a>
  );

  return (
    <div className="story" ref={root} data-variant={variant} style={{ height: `calc(${track.total}px + 100vh)` }}>
      {anchorsFor(variant).map((a) => (
        <span key={a[0]} id={a[0]} className="story-anchor" style={{ top: anchorPx(track, variant, a) }} />
      ))}
      <div className="story-pin">
        <div className="story-bg" aria-hidden="true">
          <div className="story-bg-inner">
            <div className="blob" id="b1" />
            <div className="blob" id="b2" />
            <div className="blob" id="b3" />
            <svg id="ribbons" width="1920" height="1080">
              <defs>
                <linearGradient id="hlg" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="var(--mg-azure)" stopOpacity=".1" />
                  <stop offset="1" stopColor="var(--mg-mint)" stopOpacity=".7" />
                </linearGradient>
                <radialGradient id="glowm">
                  <stop offset="0" stopColor="var(--mg-mint)" stopOpacity=".55" />
                  <stop offset="1" stopColor="var(--mg-mint)" stopOpacity="0" />
                </radialGradient>
                <linearGradient id="rg1" x1="0" x2="1">
                  <stop offset="0" stopColor="var(--mg-mint)" stopOpacity="0" />
                  <stop offset=".3" stopColor="var(--mg-mint)" />
                  <stop offset=".7" stopColor="var(--mg-azure)" />
                  <stop offset="1" stopColor="var(--mg-lavender)" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="rg2" x1="0" x2="1">
                  <stop offset="0" stopColor="var(--mg-lavender)" stopOpacity="0" />
                  <stop offset=".4" stopColor="var(--mg-lavender)" />
                  <stop offset=".8" stopColor="var(--mg-mint)" />
                  <stop offset="1" stopColor="var(--mg-mint)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[
                ["rg1", "M-80 820C380 560 640 980 1060 700S1660 360 2000 520"],
                ["rg2", "M-80 300C300 420 560 140 980 300S1560 760 2000 640"],
                ["rg1", "M-80 1000C420 900 780 1060 1200 900S1700 860 2000 960"],
              ].map(([g, d]) => (
                <g key={d}>
                  <path className="glow" stroke={`url(#${g ?? ""})`} d={d} />
                  <path className="core" stroke={`url(#${g ?? ""})`} d={d} />
                </g>
              ))}
              <g id="pulses" />
            </svg>
          </div>
          <div className="grain" />
        </div>

        {/* Intro: the logo assembles (brand film), the two agents wake up, the name, then a loading bar. */}
        <div className="splash" aria-hidden="true">
          <div className="splash-mark">
            <video className="splash-video" src="/brand/mergit-intro.mp4" muted playsInline autoPlay preload="auto" />
            <div className="splash-sym" dangerouslySetInnerHTML={{ __html: symbolColour }} />
          </div>
          <MergitLogo title="" mono variant="wordmark" className="splash-word" />
          <div className="splash-load">
            <i />
          </div>
        </div>
        <div className="story-stage">
          {/* S1 hero: the message, then a person delegating work to an agent that returns a verified receipt */}
          <section className="scene" id="s1" aria-labelledby="story-h1">
            <div id="h-halo" />
            <div className="hero-c hero-eyebrow">
              <span id="h-eye" className="lbl glass chip-eye">
                {c.hero.eyebrow}
              </span>
            </div>
            <h1 className="h hero-c" id="story-h1" style={{ top: 168 }}>
              <Mask>
                {c.hero.title} <span className="grad">{c.hero.accent}</span>
              </Mask>
            </h1>
            <p id="h-sub" className="hero-c" style={{ top: 320 }}>
              {c.hero.lede[0]} {c.hero.lede[1]}
            </p>
            <div id="h-btns" className="hero-c row-c" style={{ top: 384 }}>
              {demo}
              <Link to={getStarted} className="sbtn glass">
                Get started →
              </Link>
            </div>
            <svg id="h-art" ref={art} aria-hidden="true" />
          </section>

          {/* problem */}
          <section className="scene" id="sp" aria-label={c.problem.eyebrow}>
            <div className="lbl eyebrow">
              <i className="sq" />
              {c.problem.eyebrow}
            </div>
            <h2 className="h h2" style={{ fontSize: 88 }}>
              <Mask>{c.problem.title[0]}</Mask>
              <Mask className="g">{c.problem.title[1]}</Mask>
            </h2>
            <div className="card pcard" id="pa">
              <div className="lbl dim card-head">{c.problem.today}</div>
              {c.problem.meters.map((m) => (
                <div key={m} className="meter">
                  <span className="lbl">{m}</span>
                  <div className="track">
                    <div className="fill" />
                  </div>
                </div>
              ))}
              <div className="meter">
                <span className="lbl strong">Task done?</span>
                <span className="none">{c.problem.notMetered}</span>
              </div>
            </div>
            <div className="card pcard ok" id="pb">
              <div className="card-head row-between">
                <span className="lbl dim">Mergit</span>
                <span className="chip ok" id="pb-chip">
                  {c.problem.chip}
                </span>
              </div>
              {c.problem.meters.map((m) => (
                <div key={m} className="meter">
                  <span className="lbl">{m}</span>
                  <div className="track">
                    <div className="fill soft" />
                  </div>
                </div>
              ))}
              <div className="meter">
                <span className="lbl mint">Verified</span>
                <div className="track">
                  <div className="fill m" />
                </div>
              </div>
            </div>
          </section>

          <Iso id="stack" left={960} top={1500} />

          {/* how it works */}
          <section className="scene" id="s2" aria-label={c.how.eyebrow}>
            <div className="lbl eyebrow">
              <i className="sq" />
              {c.how.eyebrow}
            </div>
            <h2 className="h h2">
              <Mask>{c.how.title[0]}</Mask>
              <Mask className="g">{c.how.title[1]}</Mask>
            </h2>
            {c.how.steps.map(([t, p], i) => (
              <div key={t} className={i % 2 ? "lead-r" : "lead-l"} id={`ll${i}`}>
                <div className="lbl">{t}</div>
                <p>{p}</p>
              </div>
            ))}
            <svg id="leaders" width="1920" height="1080" aria-hidden="true" />
          </section>

          {/* team */}
          <section className="scene" id="s3" aria-label="The team">
            <div className="glowbg g1" />
            <div className="glowbg g2" />
            <Stepper id="s3" rail={c.team.rail} stat={c.team.stat} side={c.team.side} steps={c.team.steps}>
              <Iso id="team" left={920} top={560} />
            </Stepper>
          </section>

          {/* settlement */}
          <section className="scene" id="ss" aria-label="Settlement">
            <Stepper id="ss" rail={c.settle.rail} stat={c.settle.stat} side={c.settle.side} steps={c.settle.steps}>
              <div id="mech">
                <Iso id="m-dio" left={530} top={600} />
                <span id="m-held" className="chip lav" style={{ left: 600, top: 250 }}>
                  {c.settle.chips.held}
                </span>
                <span id="m-rec" className="chip" style={{ left: 780, top: 430 }}>
                  {c.settle.chips.receipt}
                </span>
                <span id="m-ok" className="chip ok" style={{ left: 780, top: 430 }}>
                  {c.settle.chips.checked}
                </span>
                <span id="m-paid" className="chip ok" style={{ left: 760, top: 860 }}>
                  {c.settle.chips.paid}
                </span>
                <span id="m-ref" className="chip red" style={{ left: 60, top: 860 }}>
                  {c.settle.chips.refunded}
                </span>
              </div>
            </Stepper>
          </section>

          {/* integrations */}
          <section className="scene" id="s4" aria-label={c.apps.eyebrow}>
            <div className="lbl eyebrow">
              <i className="sq" />
              {c.apps.eyebrow}
            </div>
            <h2 className="h h2">
              <Mask>{c.apps.title[0]}</Mask>
              <Mask className="g">{c.apps.title[1]}</Mask>
            </h2>
            <Iso id="apps" left={1210} top={620} />
            <ul id="app-caps">
              {c.apps.list.map(([a, b]) => (
                <li key={a} className="cap">
                  <b>{a}</b>
                  <span className="lbl">{b}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* credentials */}
          <section className="scene" id="s5" aria-label={c.cred.eyebrow}>
            <div className="lbl eyebrow">
              <i className="sq" />
              {c.cred.eyebrow}
            </div>
            <h2 className="h h2">
              <Mask>{c.cred.title[0]}</Mask>
              <Mask className="g">{c.cred.title[1]}</Mask>
            </h2>
            <Iso id="cred" left={1080} top={690} />
            <div id="cred-note" className="lbl">
              <i className="sq" />
              {c.cred.note}
            </div>
          </section>

          {/* closer */}
          <section className="scene" id="s7" aria-label={c.closer.eyebrow}>
            <div className="glowbg g3" />
            <div className="glowbg g4" />
            <div className="glowbg g5" />
            <Iso id="z-dio" left={1440} top={600} />
            <div className="lbl eyebrow" style={{ top: 220 }}>
              <i className="sq" />
              {c.closer.eyebrow}
            </div>
            <h2 className="h" id="z-h">
              <Mask>{c.closer.title[0]}</Mask>
              <Mask>{c.closer.title[1]}</Mask>
              <Mask className="mint">{c.closer.accent}</Mask>
            </h2>
            <p id="z-sub">{c.closer.lede}</p>
            <div id="z-btns" className="row">
              {demo}
              <Link to={getStarted} className="sbtn outline">
                Get started →
              </Link>
            </div>
            <div id="z-foot">
              <MergitLogo title="Mergit" mono className="z-logo" />
              <span className="lbl">{c.closer.note}</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
