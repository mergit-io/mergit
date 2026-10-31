/* Beats 27-82 s: the team stepper (dark) and the settlement stepper. */
import { P } from "./iso";
import type { Helpers } from "./motion";
import type { Scenes } from "./scenes";

const LIT = { attr: { class: "stripe lit" } };
const UNLIT = { attr: { class: "stripe" } };
const ROLES = ["PLANNER", "RESEARCH", "CODE", "QA", "REVIEW", "DOCS"] as const;

export function beatsMid(h: Helpers, tl: gsap.core.Timeline, S: Scenes) {
  const { q, ft, sceneIn, sceneOut, draw, travel, stepper } = h;

  /* team 27-55 */
  sceneIn("#s3", 26.8);
  ft(q("#s3-rail"), { x: -380 }, { x: 0 }, 0.9, 26.9);
  ft(q("#s3-panel"), { x: 480 }, { x: 0 }, 0.9, 26.9);
  const Tm = S.team;
  const B = (n: (typeof ROLES)[number]) => {
    const b = Tm.boxes[n];
    if (!b) throw new Error(`story: ${n}`);
    return b;
  };
  tl.set([...Tm.hashes.map((x) => x.g), Tm.proof, ...Tm.ids, Tm.lockLine], { opacity: 0 }, 0);
  ROLES.forEach((n, i) => void ft(B(n).g, { y: -90, opacity: 0 }, { y: 0, opacity: 1 }, 0.9, 27.4 + i * 0.12));
  const syncTeam = stepper("#s3", [28.2, 33.6, 39, 44.4, 49.8], 55);
  const lit = (n: (typeof ROLES)[number], a: number) => {
    const s = B(n).stripe;
    if (s) ft(s, UNLIT, LIT, 0.01, a);
  };
  ft(Tm.glow, { opacity: 0 }, { opacity: 1, ease: "none" }, 0.6, 28.5);
  tl.to(B("PLANNER").g, { y: -40, duration: 0.8, ease: "back.out(1.6)" }, 29);
  lit("PLANNER", 29.1);
  tl.to(B("PLANNER").g, { y: 0, duration: 0.6 }, 32.8);
  tl.to(Tm.glow, { opacity: 0, duration: 0.5 }, 33.4);
  draw([Tm.wire], 33.8, 2);
  Tm.pkts.forEach((p, i) => {
    travel(p, Tm.wire, 34.4 + i * 0.6, 3);
  });
  ROLES.slice(1).forEach((n, i) => {
    lit(n, 34.6 + i * 0.55);
  });
  const others = ROLES.filter((n) => n !== "REVIEW").map((n) => B(n).g);
  tl.to(others, { opacity: 0.28, duration: 0.4 }, 39.1);
  tl.to(B("REVIEW").g, { y: -50, duration: 0.8, ease: "back.out(1.4)" }, 39.2);
  ft(Tm.lock, { opacity: 0, y: 40 }, { opacity: 1, y: -50 }, 0.8, 39.7);
  ft(Tm.lockLine, { opacity: 0, y: 0 }, { opacity: 1, y: -50 }, 0.6, 39.9);
  ft(Tm.lockIcon, { opacity: 1 }, { opacity: 0, ease: "none" }, 0.2, 41.8);
  ft(
    Tm.checkIcon,
    { opacity: 0, scale: 0.4, transformOrigin: "45px 45px" },
    { opacity: 1, scale: 1, ease: "back.out(2)" },
    0.5,
    41.9,
  );
  tl.to(others, { opacity: 1, duration: 0.4 }, 43.9);
  tl.to(B("REVIEW").g, { y: 0, duration: 0.6 }, 43.9);
  tl.to([Tm.lock, Tm.lockLine], { opacity: 0, duration: 0.4 }, 43.8);
  const tgt = P(0, 0, 330);
  Tm.hashes.forEach((hs, i) => {
    const o = P(hs.c[0], hs.c[1], 104);
    ft(hs.g, { opacity: 0, x: 0, y: 30 }, { opacity: 1, y: -120 }, 0.9, 44.7 + i * 0.12);
    tl.to(hs.g, { x: tgt[0] - o[0], y: tgt[1] - o[1] + 40, duration: 1, ease: "power3.inOut" }, 46 + i * 0.06);
    tl.to(hs.g, { opacity: 0, duration: 0.2 }, 47.1);
  });
  ft(
    Tm.proof,
    { opacity: 0, scale: 0.2, transformOrigin: `${String(tgt[0])}px ${String(tgt[1] - 40)}px` },
    { opacity: 1, scale: 1, ease: "back.out(1.8)" },
    0.6,
    47.1,
  );
  tl.to(Tm.proof, { y: -16, duration: 1.6, ease: "sine.inOut", yoyo: true, repeat: 1 }, 47.7);
  tl.to(Tm.proof, { opacity: 0, duration: 0.4 }, 49.5);
  Tm.ids.forEach(
    (g, i) => void ft(g, { opacity: 0, y: -140 }, { opacity: 1, y: 0, ease: "bounce.out" }, 0.9, 50.1 + i * 0.22),
  );
  ROLES.forEach((n, i) => {
    const s = B(n).stripe;
    if (s) ft(s, LIT, { attr: { class: "stripe lit violet" } }, 0.01, 50.6 + i * 0.22);
  });
  sceneOut("#s3", 55);

  /* settlement 55-82 */
  sceneIn("#ss", 54.8);
  ft(q("#ss-rail"), { x: -380 }, { x: 0 }, 0.9, 54.9);
  ft(q("#ss-panel"), { x: 480 }, { x: 0 }, 0.9, 54.9);
  const syncSettle = stepper("#ss", [56.2, 61.4, 66.6, 71.8, 77], 82);
  const D = S.settle;
  const chip = (id: string) => q(`#${id}`);
  tl.set(
    [D.held, D.paid, D.fly, D.rec.g, ...["m-held", "m-rec", "m-ok", "m-paid", "m-ref"].map(chip)],
    { opacity: 0 },
    0,
  );
  ft([D.you.g, ...D.stack], { y: 60, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.08 }, 0.8, 55.2);
  ft(D.esc.g, { y: 60, opacity: 0 }, { y: 0, opacity: 1 }, 0.8, 55.35);
  ft(D.lock.g, { y: -40, opacity: 0 }, { y: 0, opacity: 1 }, 0.6, 55.8);
  ft(D.agent.g, { y: 60, opacity: 0 }, { y: 0, opacity: 1 }, 0.8, 55.5);
  draw([D.rail], 55.6, 1);
  const fly = (path: string, a: number, d = 1.1) => {
    ft(D.fly, { opacity: 0 }, { opacity: 1 }, 0.01, a);
    tl.fromTo(
      D.fly,
      { motionPath: { path, start: 0, end: 0 } },
      { motionPath: { path, start: 0, end: 1 }, duration: d, ease: "power2.inOut", immediateRender: false },
      a,
    );
    tl.to(D.fly, { opacity: 0, duration: 0.01 }, a + d);
  };
  const pop = (id: string, a: number) =>
    ft(chip(id), { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, ease: "back.out(2)" }, 0.45, a);
  const stripe = D.agent.stripe;
  // 01 fund
  tl.to(D.stack[1] ?? [], { opacity: 0, duration: 0.01 }, 57);
  fly(D.path.fund, 57);
  ft(D.held, { opacity: 0 }, { opacity: 1 }, 0.01, 58.1);
  tl.to(D.lock.g, { y: -8, duration: 0.14, yoyo: true, repeat: 1 }, 58.15);
  pop("m-held", 58.4);
  // 02 work
  tl.to(D.agent.g, { y: -12, duration: 0.3, yoyo: true, repeat: 3, ease: "sine.inOut" }, 61.6);
  tl.set(D.rec.g, { opacity: 1 }, 62);
  [...D.rec.sheets]
    .reverse()
    .forEach(
      (sh, i) => void ft(sh, { opacity: 0, y: 24 }, { opacity: 1, y: 0, ease: "back.out(1.6)" }, 0.45, 62 + i * 0.35),
    );
  ft(
    D.rec.lines,
    { opacity: 0, scaleX: 0, transformOrigin: "14px 0px" },
    { opacity: 1, scaleX: 1, stagger: 0.18 },
    0.4,
    63.2,
  );
  pop("m-rec", 63.4);
  // 03 check
  tl.to(chip("m-rec"), { opacity: 0, duration: 0.3 }, 66.7);
  D.rec.lines.forEach(
    (l, i) => void ft(l, { attr: { class: "rline" } }, { attr: { class: "rline ok" } }, 0.01, 67 + i * 0.25),
  );
  ft(
    D.rec.seal,
    { opacity: 0, scale: 0.3, transformOrigin: "88px 120px" },
    { opacity: 1, scale: 1, ease: "back.out(2.4)" },
    0.45,
    68.2,
  );
  pop("m-ok", 68.5);
  // 04 pay
  tl.to([chip("m-held"), chip("m-ok")], { opacity: 0, duration: 0.3 }, 71.9);
  ft(D.lock.closed, { opacity: 1 }, { opacity: 0 }, 0.15, 72.1);
  ft(D.lock.open, { opacity: 0 }, { opacity: 1 }, 0.25, 72.15);
  tl.to(D.held, { opacity: 0, duration: 0.01 }, 72.5);
  fly(D.path.pay, 72.5);
  ft(D.paid, { opacity: 0 }, { opacity: 1 }, 0.01, 73.6);
  if (stripe) ft(stripe, UNLIT, LIT, 0.01, 73.6);
  pop("m-paid", 73.8);
  // 05 refund: a second job whose receipt fails
  tl.to([chip("m-paid"), D.paid], { opacity: 0, duration: 0.4 }, 77);
  if (stripe) ft(stripe, LIT, UNLIT, 0.01, 77);
  ft(D.lock.open, { opacity: 1 }, { opacity: 0 }, 0.2, 77.1);
  ft(D.lock.closed, { opacity: 0 }, { opacity: 1 }, 0.2, 77.15);
  ft(D.held, { opacity: 0, y: -40 }, { opacity: 1, y: 0 }, 0.5, 77.2);
  ft(D.rec.seal, { opacity: 1 }, { opacity: 0 }, 0.2, 77.6);
  ft(
    D.rec.bad,
    { opacity: 0, scale: 0.3, transformOrigin: "88px 120px" },
    { opacity: 1, scale: 1, ease: "back.out(2.4)" },
    0.45,
    77.8,
  );
  D.rec.lines.forEach((l) => void ft(l, { attr: { class: "rline ok" } }, { attr: { class: "rline bad" } }, 0.01, 77.8));
  tl.to(D.rec.g, { x: 5, duration: 0.06, yoyo: true, repeat: 5, ease: "none" }, 78.3);
  tl.to(D.held, { opacity: 0, duration: 0.01 }, 78.9);
  fly(D.path.back, 78.9);
  ft(D.stack[1] ?? [], { opacity: 0 }, { opacity: 1 }, 0.01, 80);
  pop("m-ref", 80.1);
  sceneOut("#ss", 82);

  return (t: number) => {
    syncTeam(t);
    syncSettle(t);
  };
}
