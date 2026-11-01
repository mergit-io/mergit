import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/caveat/500.css";
import "@fontsource/onest/500.css";
import "@fontsource/onest/600.css";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import "@fontsource/onest/700.css";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "../styles/landing/tokens.css";
import "../styles/landing/base.css";
import "../styles/landing/hero.css";
import "../styles/landing/sections.css";
import "../styles/landing/story.css";
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
import { navFor, storyVariant } from "./story/storyConfig";
import { StoryStage } from "./story/StoryStage";

const INTRO_KEY = "mergit-intro-seen";

/*
 * The scroll story needs a landscape screen and motion. Phones, small tablets
 * and reduced-motion visitors get the classic, fully static-friendly page.
 */
const STORY_QUERY = "(min-width: 1024px) and (min-height: 600px) and (prefers-reduced-motion: no-preference)";
function useStoryMode() {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(STORY_QUERY);
      mq.addEventListener("change", cb);
      return () => {
        mq.removeEventListener("change", cb);
      };
    },
    () => window.matchMedia(STORY_QUERY).matches,
  );
}

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
  const story = useStoryMode();
  return story ? <StoryLanding /> : <ClassicLanding />;
}

function StoryLanding() {
  // `/?story=flows` and `/?story=full` are the earlier, longer stories, kept to compare with the lean default.
  const [variant] = useState(() => storyVariant(window.location.search));
  return (
    <div className="landing story-mode">
      <div className="landing-page">
        <LandingNav links={navFor(variant)} />
        <main>
          <StoryStage variant={variant} />
          <Faq />
        </main>
        <Footer />
      </div>
    </div>
  );
}

function ClassicLanding() {
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
