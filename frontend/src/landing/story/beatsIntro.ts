/* Beats 0-27 s: living background, hero, problem, exploded "how it works" stack. */
import type { Helpers } from "./motion";
import type { Scenes } from "./scenes";

export function beatsIntro(h: Helpers, tl: gsap.core.Timeline, S: Scenes, T: number) {
  const { q, qa, ft, sceneIn, sceneOut, mask, rise, draw } = h;

  /* living background: drifting brand light and pulses along the ribbons */
  const poses: [number, [number, number, number][]][] = [
    [
      7,
      [
        [200, 700, 0.8],
        [300, 200, 0.9],
        [-700, -200, 0.8],
      ],
    ],
    [
      16,
      [
        [600, 300, 1.1],
        [-200, 300, 0.8],
        [-500, -300, 1.2],
      ],
    ],
    [
      55,
      [
        [900, 500, 1],
        [-900, 400, 0.9],
        [-1100, -400, 1],
      ],
    ],
    [
      82,
      [
        [200, 600, 0.9],
        [-300, 450, 1.4],
        [-200, -100, 0.8],
      ],
    ],
    [
      90,
      [
        [1000, 300, 0.9],
        [-800, 100, 0.8],
        [-300, -500, 1.1],
      ],
    ],
  ];
  for (const [t0, p] of poses)
    ["#b1", "#b2", "#b3"].forEach((id, k) => {
      const [x, y, s] = p[k] ?? [0, 0, 1];
      tl.to(q(id), { x, y, scale: s, duration: 2.4, ease: "sine.inOut" }, t0 - 1.2);
    });
  ["#b1", "#b2", "#b3"].forEach((id, k) => void tl.to(q(id), { rotation: 40 + k * 25, duration: T, ease: "none" }, 0));
  const pulses = q("#pulses");
  (qa("#ribbons .core") as unknown as SVGPathElement[]).forEach((p, i) => {
    const L = p.getTotalLength();
    for (let k = 0; k < 2; k++) {
      const c = p.cloneNode() as SVGPathElement;
      c.setAttribute("class", "pulse");
      c.style.strokeDasharray = `140 ${String(L)}`;
      pulses.appendChild(c);
      ft(c, { strokeDashoffset: L * (0.3 + k * 0.5) + i * 300 }, { strokeDashoffset: -L * 6, ease: "none" }, T, 0);
    }
  });
  ft(q("#ribbons"), { opacity: 0 }, { opacity: 1 }, 0.8, 6.2);
  tl.to(q("#ribbons"), { opacity: 0.35, duration: 0.8 }, 54.8);
  tl.to(q("#ribbons"), { opacity: 1, duration: 0.8 }, 81.6);

  /* S1 hero: it plays on load (heroIntro); the scroll only carries it away */
  sceneOut("#s1", 6.8);

  /* problem 7-16 */
  sceneIn("#sp", 6.8);
  mask("#sp", 7.2);
  rise(qa(".pcard"), 7.9, { y: 60, st: 0.2 });
  qa("#pa .fill").forEach(
    (f, i) =>
      void ft(f, { scaleX: 0 }, { scaleX: [0.92, 0.7, 0.81][i] ?? 0.8, ease: "steps(14)" }, 2.6, 8.6 + i * 0.25),
  );
  ft(q("#pa .none"), { opacity: 0, x: -10 }, { opacity: 1, x: 0 }, 0.5, 10.9);
  tl.to(q("#pa .none"), { x: 6, duration: 0.07, yoyo: true, repeat: 5, ease: "none" }, 11.4);
  qa("#pb .fill").forEach((f, i) => {
    const last = i === 3;
    ft(
      f,
      { scaleX: 0 },
      { scaleX: [0.92, 0.7, 0.81, 1][i] ?? 1, ease: last ? "power2.inOut" : "steps(14)" },
      last ? 1.2 : 2,
      last ? 12 : 9.4 + i * 0.25,
    );
  });
  ft(q("#pb-chip"), { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, ease: "back.out(2)" }, 0.5, 13.2);
  sceneOut("#sp", 16);

  /* how it works 16-27 */
  S.plates.forEach((p, i) => void tl.set(p, { y: -(3 - i) * 24 }, 0));
  ft(q("#stack"), { top: 1500 }, { top: 860, ease: "power3.out" }, 1.8, 15.4);
  S.plates.forEach((p, i) => void tl.to(p, { y: -(3 - i) * 160, duration: 2.2, ease: "power3.inOut" }, 16.8));
  sceneIn("#s2", 16);
  mask("#s2", 16.6);
  const lead = q("#leaders");
  const NS = "http://www.w3.org/2000/svg";
  [380, 540, 700, 860].forEach((y, i) => {
    const left = i % 2 === 0;
    q(`#ll${String(i)}`).style.top = `${String(y - 12)}px`;
    const p = document.createElementNS(NS, "path");
    p.setAttribute("class", "leader");
    p.setAttribute("d", left ? `M590 ${String(y)}H752` : `M1168 ${String(y)}H1330`);
    lead.appendChild(p);
    const d = document.createElementNS(NS, "circle");
    Object.entries({ class: "ldot", cx: left ? 752 : 1168, cy: y, r: 3.5 }).forEach(([k, v]) => {
      d.setAttribute(k, String(v));
    });
    lead.appendChild(d);
    draw([p], 19 + i * 1.1, 0.6);
    ft(d, { opacity: 0 }, { opacity: 1 }, 0.2, 19 + i * 1.1);
    ft(q(`#ll${String(i)}`), { opacity: 0, x: left ? -24 : 24 }, { opacity: 1, x: 0 }, 0.7, 19.4 + i * 1.1);
  });
  tl.to(qa(".caret"), { opacity: 0, duration: 0.01, repeat: 9, yoyo: true, repeatDelay: 0.35, ease: "none" }, 19);
  S.plates.forEach(
    (p, i) => void tl.to(p, { y: -(3 - i) * 24 - 120, opacity: 0, duration: 1.2, ease: "power3.in" }, 25.6 + i * 0.08),
  );
  sceneOut("#s2", 27);
}
