/*
 * Plays once on load, independent of scroll: the Mergit logo, then the hero
 * message, then the delegate -> agent works -> verified receipt -> paid story.
 */
import gsap from "gsap";
import type { HeroArt } from "./heroArt";

const INTRO_KEY = "mergit-intro-seen";

/** The logo film plays once per browser session; later loads go straight to the hero. */
function introSeen() {
  try {
    return sessionStorage.getItem(INTRO_KEY) !== null;
  } catch {
    return false;
  }
}

export function playHeroIntro(root: HTMLElement, A: HeroArt) {
  const q = (s: string) => root.querySelector(s);
  const qa = (s: string) => Array.from(root.querySelectorAll(s));
  const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

  // the hero is the first thing on screen; the nav waits for the logo to clear
  const nav = root.closest(".landing")?.querySelector(".l-nav") ?? [];
  tl.fromTo(nav, { autoAlpha: 0, y: -20 }, { autoAlpha: 1, y: 0, duration: 0.6 }, 4.6);

  // intro: the brand film assembles the logo, the agents wake up on it, then the name and a loading bar
  const video = q(".splash-video");
  if (video instanceof HTMLVideoElement) void video.play().catch(() => undefined);
  tl.set(q(".splash-sym .faces"), { opacity: 0 }, 0);
  tl.fromTo(q(".splash-mark"), { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.5 }, 0);
  tl.fromTo(q(".splash-sym"), { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "none" }, 1.9);
  tl.to(q(".splash-video"), { opacity: 0, duration: 0.45, ease: "none" }, 2.0);
  tl.fromTo(
    q(".splash-sym .faces"),
    { opacity: 0, scale: 0.6, svgOrigin: "128 128" },
    { opacity: 1, scale: 1, duration: 0.6, ease: "back.out(2)" },
    2.3,
  );
  tl.fromTo(q(".splash-word"), { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.6 }, 2.6);
  tl.fromTo(q(".splash-load"), { opacity: 0 }, { opacity: 1, duration: 0.3 }, 2.9);
  tl.fromTo(q(".splash-load i"), { scaleX: 0 }, { scaleX: 1, duration: 1.1, ease: "power2.inOut" }, 2.95);
  tl.to(q(".splash"), { yPercent: -100, duration: 0.9, ease: "power4.inOut" }, 4.2);
  tl.set(q(".splash"), { display: "none" }, 5.1);
  tl.call(
    () => {
      try {
        sessionStorage.setItem(INTRO_KEY, "1");
      } catch {
        // Private mode: the film may play again next visit.
      }
    },
    [],
    5.1,
  );
  if (introSeen()) {
    tl.set(q(".splash"), { display: "none" }, 0);
    tl.seek(3.8);
  }

  // message
  tl.fromTo(q("#h-eye"), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.6 }, 4.4);
  tl.fromTo(
    qa("#story-h1 .mask>span"),
    { yPercent: 110 },
    { yPercent: 0, duration: 1, stagger: 0.12, ease: "power4.out" },
    4.5,
  );
  tl.fromTo(q("#h-sub"), { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.7 }, 5);
  tl.fromTo(q("#h-btns"), { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.7 }, 5.2);

  // the scene arrives
  tl.fromTo(
    A.blob,
    { opacity: 0, scale: 0.85, transformOrigin: "650px 330px" },
    { opacity: 1, scale: 1, duration: 1.2 },
    4.6,
  );
  tl.fromTo(A.ground, { opacity: 0 }, { opacity: 1, duration: 0.8 }, 4.8);
  tl.fromTo(A.phone, { opacity: 0, y: 80 }, { opacity: 1, y: 0, duration: 1 }, 4.9);
  tl.fromTo(A.person, { opacity: 0, x: -80 }, { opacity: 1, x: 0, duration: 1 }, 5.1);
  tl.fromTo(A.robot, { opacity: 0, x: 80 }, { opacity: 1, x: 0, duration: 1 }, 5.2);
  tl.fromTo(
    A.gears.map((g) => g.parentNode),
    { opacity: 0 },
    { opacity: 1, duration: 0.8 },
    5.4,
  );
  tl.set([A.ask, A.work, A.reply, A.receipt, A.askBubble], { opacity: 0 }, 0);

  // 1. the person asks
  tl.fromTo(
    A.askBubble,
    { opacity: 0, scale: 0.6, transformOrigin: "200px 296px" },
    { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(2)" },
    5.8,
  );
  tl.fromTo(A.ask, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, ease: "back.out(1.6)" }, 6.2);
  // 2. the agent spins up the work
  tl.call(
    () => {
      A.status.textContent = "● Planning · coding · testing";
    },
    [],
    6.8,
  );
  tl.fromTo(A.work, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5 }, 6.8);
  tl.fromTo(
    A.shimmer,
    { scaleX: 0.2, transformOrigin: "524px 0px" },
    { scaleX: 1, duration: 0.6, yoyo: true, repeat: 3, ease: "sine.inOut", stagger: 0.15 },
    6.9,
  );
  tl.to(A.robot, { y: -10, duration: 0.25, yoyo: true, repeat: 5, ease: "sine.inOut" }, 6.9);
  // 3. the result comes back with a receipt
  tl.to(A.work, { opacity: 0, duration: 0.2 }, 8.6);
  tl.fromTo(A.reply, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5 }, 8.6);
  tl.fromTo(A.receipt, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.6, ease: "back.out(1.4)" }, 9.1);
  tl.fromTo(
    A.ok,
    { opacity: 0, scale: 0.6, transformOrigin: "592px 466px" },
    { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2.4)" },
    9.7,
  );
  // 4. proven, then paid
  tl.call(
    () => {
      A.pillText.textContent = "Proven · agent paid";
      A.status.textContent = "● Work verified";
    },
    [],
    10.2,
  );
  tl.fromTo(A.pill, { attr: { class: "art-pill" } }, { attr: { class: "art-pill paid" }, duration: 0.01 }, 10.2);
  tl.fromTo(A.badge, { attr: { class: "robot-badge" } }, { attr: { class: "robot-badge on" }, duration: 0.01 }, 10.2);
  tl.fromTo(A.eyes, { attr: { class: "robot-eye" } }, { attr: { class: "robot-eye on" }, duration: 0.01 }, 10.2);

  // idle life: gears turn, the robot and the thought bubble float
  const idle = [
    gsap.to(A.gears[0] ?? [], { rotation: 360, svgOrigin: "0 0", duration: 14, repeat: -1, ease: "none" }),
    gsap.to(A.gears[1] ?? [], { rotation: -360, svgOrigin: "0 0", duration: 9, repeat: -1, ease: "none" }),
    gsap.to(A.askBubble, { y: -10, duration: 2.4, repeat: -1, yoyo: true, ease: "sine.inOut", delay: 6.6 }),
    gsap.to(A.robot, { y: -8, duration: 2.8, repeat: -1, yoyo: true, ease: "sine.inOut", delay: 10.6 }),
  ];
  return () => {
    tl.kill();
    idle.forEach((t) => {
      t.kill();
    });
  };
}
