import { useEffect, useRef, useState } from "react";
import { FIRST_BLOCK, CHAIN, intro } from "./content";
import { Globe } from "./Globe";

const CAPTION_AT = 900;
const LEAVE_AT = 3400;
const LEAVE_MS = 950;

/**
 * Opening sequence: points gather into a globe, a caption settles, then the
 * globe flies to its place in the hero while the page fades in behind it.
 * `heroGlobe` is the element the globe lands on.
 */
export function Intro({
  heroGlobe,
  onLeave,
  onDone,
}: {
  heroGlobe: () => HTMLElement | null;
  onLeave: () => void;
  onDone: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"gather" | "caption" | "leave">("gather");
  const [block, setBlock] = useState(FIRST_BLOCK);
  const leaving = useRef(false);

  useEffect(() => {
    const leave = () => {
      if (leaving.current) return;
      leaving.current = true;
      setPhase("leave");
      onLeave();
      const from = globeRef.current?.getBoundingClientRect();
      const to = heroGlobe()?.getBoundingClientRect();
      if (globeRef.current && from && to && to.width > 0) {
        const dx = to.left + to.width / 2 - (from.left + from.width / 2);
        const dy = to.top + to.height / 2 - (from.top + from.height / 2);
        globeRef.current.animate(
          [
            { transform: "none" },
            { transform: `translate(${String(dx)}px, ${String(dy)}px) scale(${String(to.width / from.width)})` },
          ],
          { duration: LEAVE_MS, easing: "cubic-bezier(0.6, 0, 0.2, 1)", fill: "forwards" },
        );
      }
      rootRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: LEAVE_MS * 0.6,
        delay: LEAVE_MS * 0.55,
        easing: "ease",
        fill: "forwards",
      });
      window.setTimeout(onDone, LEAVE_MS * 1.15);
    };

    const captionTimer = window.setTimeout(() => {
      setPhase((p) => (p === "gather" ? "caption" : p));
    }, CAPTION_AT);
    const leaveTimer = window.setTimeout(leave, LEAVE_AT);
    const blockTimer = window.setInterval(() => {
      setBlock((b) => b + 1);
    }, 420);
    const skip = () => {
      leave();
    };
    window.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);
    return () => {
      window.clearTimeout(captionTimer);
      window.clearTimeout(leaveTimer);
      window.clearInterval(blockTimer);
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
    };
  }, [heroGlobe, onLeave, onDone]);

  return (
    <div ref={rootRef} className={`intro is-${phase}`} aria-hidden="true">
      <div className="intro-progress" />
      <div ref={globeRef} className="intro-globe">
        <Globe assemble labels={intro.hashes} label="" />
      </div>
      <div className="intro-caption">
        <span className="l-eyebrow">{intro.eyebrow}</span>
        <p className="intro-title">
          {intro.lead}
          <span className="l-gradient-text">{intro.accent}</span>
        </p>
        <span className="intro-block">
          {CHAIN} · block {block.toLocaleString("en-US")}
        </span>
      </div>
    </div>
  );
}
