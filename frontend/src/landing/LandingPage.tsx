import { useCallback, useRef, useState } from "react";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/caveat/500.css";
import "../styles/landing/tokens.css";
import "../styles/landing/base.css";
import "../styles/landing/hero.css";
import "../styles/landing/sections.css";
import { Intro } from "./Intro";
import { prefersReducedMotion } from "./motion";
import { Approval } from "./sections/Approval";
import { Connected } from "./sections/Connected";
import { Credentials } from "./sections/Credentials";
import { Cta, Footer } from "./sections/Cta";
import { Faq } from "./sections/Faq";
import { Hero } from "./sections/Hero";
import { HowItWorks } from "./sections/HowItWorks";
import { LandingNav } from "./sections/LandingNav";
import { ProofOfWork } from "./sections/ProofOfWork";
import { Team } from "./sections/Team";

const INTRO_KEY = "mergit-intro-seen";

/** The intro plays once per browser session, and never with reduced motion. */
function shouldPlayIntro() {
  if (prefersReducedMotion()) return false;
  try {
    return sessionStorage.getItem(INTRO_KEY) === null;
  } catch {
    return false;
  }
}

export function LandingPage() {
  const [intro, setIntro] = useState<"playing" | "leaving" | "done">(() => (shouldPlayIntro() ? "playing" : "done"));
  const globeRef = useRef<HTMLDivElement>(null);
  const heroGlobe = useCallback(() => globeRef.current, []);
  const onLeave = useCallback(() => {
    setIntro("leaving");
  }, []);
  const onDone = useCallback(() => {
    try {
      sessionStorage.setItem(INTRO_KEY, "1");
    } catch {
      // Private mode: the intro may play again next visit.
    }
    setIntro("done");
  }, []);

  return (
    <div className={`landing intro-${intro}`}>
      {intro !== "done" && <Intro heroGlobe={heroGlobe} onLeave={onLeave} onDone={onDone} />}
      <div className="landing-page">
        <LandingNav />
        <main>
          <Hero ready={intro !== "playing"} globeRef={globeRef} />
          <HowItWorks />
          <Team />
          <Connected />
          <Approval />
          <Credentials />
          <ProofOfWork />
          <Faq />
          <Cta />
        </main>
        <Footer />
      </div>
    </div>
  );
}
