/* Beats 82-105 s: integrations, credential boundary, dark closer. */
import type { Helpers } from "./motion";
import type { Scenes } from "./scenes";

export function beatsTail(h: Helpers, tl: gsap.core.Timeline, S: Scenes) {
  const { q, qa, ft, sceneIn, sceneOut, mask, rise, draw, travel } = h;

  /* integrations 82-90 */
  const A = S.apps;
  sceneIn("#s4", 82);
  mask("#s4", 82.3);
  ft(A.hub, { y: 80, opacity: 0 }, { y: 0, opacity: 1 }, 0.9, 82.5);
  A.plates.forEach((g, i) => void ft(g, { y: -120, opacity: 0 }, { y: 0, opacity: 1 }, 0.9, 82.9 + i * 0.15));
  draw(A.wires, 83.8, 1);
  rise(qa("#app-caps .cap"), 83.4, { y: 20, st: 0.15, d: 0.6 });
  // wires/packets in A order: GitHub, Slack, Linear, Notion
  const [gh, sl, ln, no] = A.wires;
  const [pgh, psl, pln, pno] = A.pk;
  if (gh && sl && ln && no && pgh && psl && pln && pno) {
    travel(psl, sl, 84.8, 1); // the Slack thread comes in
    travel(pgh, gh, 85.9, 1, 1, 0); // the fix goes to GitHub
    travel(pln, ln, 86.1, 1, 1, 0); // the ticket to Linear
    travel(pno, no, 86.3, 1, 1, 0); // the note to Notion
    travel(A.back, sl, 87.6, 1, 1, 0); // the reply goes back to Slack
  }
  sceneOut("#s4", 90);

  /* credentials 90-97 */
  const Cr = S.cred;
  sceneIn("#s5", 90);
  mask("#s5", 90.3);
  [Cr.vault.g, Cr.tools.g, Cr.model.g].forEach(
    (g, i) => void ft(g, { y: 80, opacity: 0 }, { y: 0, opacity: 1 }, 0.8, 90.7 + i * 0.18),
  );
  draw([Cr.wire], 91.5, 1);
  ft(Cr.wall, { opacity: 0, y: -60 }, { opacity: 1, y: 0 }, 0.7, 92);
  travel(Cr.ctx, Cr.wire, 92.8, 1.4, 0.45, 1);
  tl.to(Cr.model.g, { y: -10, duration: 0.2, yoyo: true, repeat: 1 }, 94.1);
  ft(Cr.key, { opacity: 0 }, { opacity: 1 }, 0.15, 93.8);
  tl.fromTo(
    Cr.key,
    { motionPath: { path: Cr.wallPath, start: 0, end: 0 } },
    { motionPath: { path: Cr.wallPath, start: 0, end: 1 }, duration: 1.3, ease: "power2.in", immediateRender: false },
    93.8,
  );
  ft(Cr.x, { opacity: 0, scale: 0.3 }, { opacity: 1, scale: 1, ease: "back.out(2.4)" }, 0.4, 95.1);
  tl.to(Cr.wall, { attr: { class: "wall hit" }, duration: 0.01 }, 95.1);
  tl.to(Cr.key, { opacity: 0, duration: 0.3 }, 95.3);
  rise(q("#cred-note"), 95.3, { y: 14, d: 0.6 });
  sceneOut("#s5", 97);

  /* closer 97-105 */
  const Z = S.closer;
  sceneIn("#s7", 96.8);
  tl.set([Z.held, Z.fly, Z.stack[1] ?? []], { opacity: 0 }, 0);
  tl.set(Z.lock.closed, { opacity: 0 }, 0);
  tl.set(Z.lock.open, { opacity: 1 }, 0);
  if (Z.agent.stripe) tl.set(Z.agent.stripe, { attr: { class: "stripe lit" } }, 0);
  ft(Z.root, { opacity: 0, y: 60 }, { opacity: 1, y: 0 }, 1, 97.2);
  ft(
    Z.rec.seal,
    { opacity: 0, scale: 0.3, transformOrigin: "88px 120px" },
    { opacity: 1, scale: 1, ease: "back.out(2.4)" },
    0.45,
    98.4,
  );
  ft(Z.paid, { opacity: 0, y: -80 }, { opacity: 1, y: 0, ease: "bounce.out" }, 0.9, 98.8);
  mask("#s7", 97.5, 0.2);
  rise(q("#z-sub"), 98.4, { y: 16 });
  rise(q("#z-btns"), 98.7, { y: 16 });
  rise(q("#z-foot"), 99.3, { y: 16 });
}
