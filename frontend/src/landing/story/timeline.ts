/*
 * Mounts the scroll story: builds the illustrations, one master timeline in
 * seconds, and scrubs it with page scroll. The stage is a fixed 1920x1080
 * artboard scaled to fit the viewport; the background is scaled to cover it.
 */
import gsap from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { beatsIntro } from "./beatsIntro";
import { beatsMid } from "./beatsMid";
import { beatsTail } from "./beatsTail";
import { heroArt } from "./heroArt";
import { playHeroIntro } from "./heroIntro";
import { helpers } from "./motion";
import { buildScenes } from "./scenes";
import { FLOW_RATE, flowsFor, snapPlan, STORY_START, STORY_T, variantTrack, type Variant } from "./storyConfig";
import { snapTarget } from "./track";

gsap.registerPlugin(ScrollTrigger, MotionPathPlugin);

export function mountStory(root: HTMLElement, artSvg: SVGSVGElement, variant: Variant) {
  const pin = root.querySelector<HTMLElement>(".story-pin");
  if (!pin) return undefined;

  // The floating nav takes the top band; the artboard fits the space under it.
  const NAV = 84;
  const fit = () => {
    const w = pin.clientWidth;
    const h = pin.clientHeight;
    pin.style.setProperty("--k", String(Math.min(w / 1920, (h - NAV) / 1080)));
    pin.style.setProperty("--kb", String(Math.max(w / 1920, h / 1080)));
    pin.style.setProperty("--top", `${String(NAV + (h - NAV) / 2)}px`);
  };
  fit();
  window.addEventListener("resize", fit);

  let stopIntro: (() => void) | undefined;
  const cleanups: (() => void)[] = [];
  const ctx = gsap.context(() => {
    const S = buildScenes(root);
    const tl = gsap.timeline({ defaults: { ease: "power3.out", lazy: false }, paused: true });
    const h = helpers(tl, root);
    beatsIntro(h, tl, S, STORY_T);
    const syncMid = beatsMid(h, tl, S);
    beatsTail(h, tl, S);
    tl.set({}, {}, STORY_T);

    tl.eventCallback("onUpdate", () => {
      const t = tl.time();
      h.syncScenes(t);
      syncMid(t);
    });

    // Render everything up to the start so later scenes sit in their resting state.
    tl.time(STORY_START);
    h.syncScenes(STORY_START);
    syncMid(STORY_START);

    // Scrolling drives a 0 to 1 progress through the track. Most of it scrubs the timeline; on the two flows (team and
    // settlement) the page rests while the flow plays by itself on its own clock, 2x the timeline's speed.
    const track = variantTrack(variant);
    const plan = snapPlan(variant, track);
    const flows = flowsFor(variant);
    const clocks = new Map<string, number>(flows.map((f) => [f.id, f.start]));
    const clockOf = (id: string) => clocks.get(id) ?? 0;
    let playing = true;

    const driver = { p: 0 };
    const pos = () => driver.p * track.total;
    const sync = () => {
      // A flow starts again whenever the page is above it. Scrolling back up into it from below leaves it at its end.
      for (const f of flows) if (pos() < track.flowSpan(f.id).from) clocks.set(f.id, f.start);
      tl.time(track.timeAt(pos(), clockOf));
    };

    const toggles = flows.length > 0 ? Array.from(root.querySelectorAll<HTMLElement>('[data-flow-act="toggle"]')) : [];
    const showControls = () => {
      for (const b of toggles) {
        b.textContent = playing ? "Pause" : "Play";
        b.setAttribute("aria-label", playing ? "Pause the animation" : "Play the animation");
      }
    };
    const restart = (id: string, at: number) => {
      clocks.set(id, at);
      playing = true;
      showControls();
      sync();
    };

    const off: (() => void)[] = [];
    const listen = (el: HTMLElement, type: string, fn: (e: Event) => void) => {
      el.addEventListener(type, fn);
      off.push(() => {
        el.removeEventListener(type, fn);
      });
    };
    for (const f of flows) {
      const scene = h.q(f.id);
      scene.querySelectorAll<HTMLElement>("[data-flow-act]").forEach((b) => {
        listen(b, "click", () => {
          if (b.dataset.flowAct === "replay" || clockOf(f.id) >= f.end) {
            restart(f.id, f.start); // "Play" after the end plays it again
            return;
          }
          playing = !playing;
          showControls();
        });
      });
      // Each step on the left jumps the flow to that step and carries on from there.
      h.qa(`${f.id} .ri`).forEach((li, i) => {
        li.setAttribute("role", "button");
        li.tabIndex = 0;
        const go = () => {
          restart(f.id, f.steps[i] ?? f.start);
        };
        listen(li, "click", go);
        listen(li, "keydown", (e) => {
          const k = (e as KeyboardEvent).key;
          if (k === "Enter" || k === " ") {
            e.preventDefault();
            go();
          }
        });
      });
    }
    showControls();

    const tick = (_time: number, deltaMs: number) => {
      if (!playing) return;
      const piece = track.locate(pos()).piece;
      if (piece.kind !== "play") return;
      const f = flows.find((x) => x.id === piece.flow);
      const c = f ? clockOf(f.id) : 0;
      if (!f || c >= f.end) return;
      clocks.set(f.id, Math.min(f.end, c + (Math.min(deltaMs, 100) / 1000) * FLOW_RATE));
      sync();
    };
    if (flows.length > 0) gsap.ticker.add(tick);
    off.push(() => {
      gsap.ticker.remove(tick);
    });
    cleanups.push(...off);

    const scrub = gsap.fromTo(driver, { p: 0 }, { p: 1, ease: "none", paused: true, onUpdate: sync });
    ScrollTrigger.create({
      trigger: root,
      start: "top top",
      end: "bottom bottom",
      scrub: variant === "full" ? 2 : 1,
      animation: scrub,
      snap: {
        snapTo: (value: number, self?: ScrollTrigger) => snapTarget(value, self?.direction ?? 1, plan.stops, plan.free),
        inertia: false,
        delay: variant === "full" ? 0.15 : 0.12,
        duration: variant === "full" ? { min: 1, max: 3.4 } : { min: 0.6, max: 2 },
        ease: "power2.inOut",
      },
    });
    stopIntro = playHeroIntro(root, heroArt(artSvg));
  }, root);

  return () => {
    window.removeEventListener("resize", fit);
    cleanups.forEach((fn) => {
      fn();
    });
    stopIntro?.();
    ctx.revert();
    artSvg.replaceChildren();
    // The illustrations are built imperatively; clear them so a remount starts clean.
    root.querySelectorAll(".iso-svg, #h-links, #leaders, #pulses").forEach((n) => {
      n.replaceChildren();
    });
  };
}
