/*
 * Hero illustration: a person hands work to Mergit in a chat, the agent spins
 * up the work, and a verified receipt comes back. Flat SVG on a 1300x640 board.
 */
import { el } from "./iso";

function gear(parent: Element, cx: number, cy: number, r: number, teeth: number, cls: string) {
  const g = el("g", { class: cls, transform: `translate(${String(cx)} ${String(cy)})` }, parent);
  const spin = el("g", {}, g);
  const d: string[] = [];
  const ro = r;
  const ri = r * 0.8;
  for (let i = 0; i < teeth * 2; i++) {
    const a0 = (i / (teeth * 2)) * Math.PI * 2;
    const a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2;
    const rr = i % 2 ? ri : ro;
    d.push(`${i ? "L" : "M"}${(Math.cos(a0) * rr).toFixed(1)} ${(Math.sin(a0) * rr).toFixed(1)}`);
    d.push(`L${(Math.cos(a1) * rr).toFixed(1)} ${(Math.sin(a1) * rr).toFixed(1)}`);
  }
  el("path", { d: `${d.join("")}Z`, class: "gear-body" }, spin);
  el("circle", { r: r * 0.36, class: "gear-hole" }, spin);
  return spin;
}

const lines = (parent: Element, x: number, y: number, widths: number[], cls: string) =>
  widths.map((w, i) => el("rect", { x, y: y + i * 20, width: w, height: 8, rx: 4, class: cls }, parent));

function text(parent: Element, x: number, y: number, s: string, cls: string) {
  const t = el("text", { x, y, class: cls }, parent);
  t.textContent = s;
  return t;
}

export function heroArt(svg: SVGSVGElement) {
  svg.setAttribute("viewBox", "150 0 1000 640");
  const blob = el(
    "path",
    {
      class: "art-blob",
      d: "M150 300C130 150 300 40 520 40S1000 20 1120 140S1220 420 1120 540S760 620 520 610S170 450 150 300Z",
    },
    svg,
  );
  const ground = el("ellipse", { cx: 650, cy: 612, rx: 560, ry: 26, class: "art-ground" }, svg);

  /* gears behind the phone: the work spinning up */
  const gears = [gear(svg, 900, 150, 74, 10, "gear"), gear(svg, 1000, 270, 46, 8, "gear small")];

  /* phone with the conversation */
  const phone = el("g", { class: "art-phone" }, svg);
  el("rect", { x: 470, y: 18, width: 360, height: 584, rx: 44, class: "phone-frame" }, phone);
  el("rect", { x: 486, y: 34, width: 328, height: 552, rx: 32, class: "phone-screen" }, phone);
  el("rect", { x: 610, y: 48, width: 80, height: 10, rx: 5, class: "phone-notch" }, phone);
  el("rect", { x: 486, y: 72, width: 328, height: 70, class: "phone-head" }, phone);
  el("circle", { cx: 528, cy: 107, r: 20, class: "bot-avatar" }, phone);
  el("rect", { x: 517, y: 101, width: 22, height: 11, rx: 5.5, class: "bot-visor" }, phone);
  text(phone, 560, 103, "Mergit agents", "art-title");
  const status = text(phone, 560, 124, "● 6 specialists ready", "art-status");

  // the request
  const ask = el("g", { class: "bubble-ask" }, phone);
  el("rect", { x: 560, y: 166, width: 238, height: 84, rx: 22, class: "ask-bg" }, ask);
  text(ask, 580, 196, "Fix the authentication bug", "art-msg on-dark");
  text(ask, 580, 220, "and reply here with the PR.", "art-msg on-dark");
  el("circle", { cx: 778, cy: 262, r: 12, class: "user-avatar" }, ask);

  // the agent working, then answering
  const work = el("g", { class: "bubble-work" }, phone);
  el("rect", { x: 504, y: 272, width: 230, height: 70, rx: 22, class: "work-bg" }, work);
  const shimmer = lines(work, 524, 292, [150, 110], "shimmer");
  const reply = el("g", { class: "bubble-reply" }, phone);
  el("rect", { x: 504, y: 272, width: 250, height: 86, rx: 22, class: "work-bg" }, reply);
  text(reply, 524, 302, "PR #134 · Fix auth flow", "art-msg");
  text(reply, 524, 326, "47 tests passed · 6 / 6 proofs", "art-msg dim");

  // the receipt that comes back
  const receipt = el("g", { class: "art-receipt" }, phone);
  el("rect", { x: 504, y: 376, width: 292, height: 120, rx: 16, class: "receipt-bg" }, receipt);
  text(receipt, 522, 404, "RECEIPT · PRODUCT EXAMPLE", "art-mono");
  text(receipt, 522, 434, "0x8f2e7a91…4b91", "art-hash");
  const ok = el("g", { class: "receipt-ok" }, receipt);
  el("rect", { x: 522, y: 452, width: 140, height: 28, rx: 14, class: "ok-bg" }, ok);
  text(ok, 538, 471, "✓ HASHES MATCH", "art-mono ok");

  const pill = el("g", { class: "art-pill" }, phone);
  el("rect", { x: 520, y: 520, width: 260, height: 46, rx: 23, class: "pill-bg" }, pill);
  const pillText = text(pill, 650, 549, "Held in escrow", "art-pill-text");
  pillText.setAttribute("text-anchor", "middle");

  /* the person who delegates */
  const person = el("g", { class: "art-person" }, svg);
  el("ellipse", { cx: 300, cy: 585, rx: 150, ry: 34, class: "legs" }, person);
  el("path", { d: "M170 590c20-60 90-70 140-50s110 10 140 50c-60 22-220 22-280 0Z", class: "legs" }, person);
  el("path", { d: "M228 420c0-40 30-62 72-62s72 22 72 62v130H228Z", class: "torso" }, person);
  el("path", { d: "M300 450c40 10 70 20 92 6", class: "arm" }, person);
  el("path", { d: "M244 470c30 20 90 18 140 2", class: "arm" }, person);
  el("rect", { x: 370, y: 430, width: 30, height: 48, rx: 6, class: "hand-phone" }, person);
  el("rect", { x: 284, y: 338, width: 32, height: 34, rx: 10, class: "skin" }, person);
  el("circle", { cx: 300, cy: 304, r: 46, class: "skin" }, person);
  el(
    "path",
    { d: "M254 300c-4-40 26-62 54-60 30 2 48 22 44 52-14-16-40-22-62-20-14 2-26 12-36 28Z", class: "hair" },
    person,
  );
  el("path", { d: "M318 318q8 6 16 0", class: "smile" }, person);
  const askBubble = el("g", { class: "art-think" }, svg);
  el(
    "path",
    {
      d: "M150 170h150a22 22 0 0 1 22 22v56a22 22 0 0 1-22 22h-88l-24 26v-26h-38a22 22 0 0 1-22-22v-56a22 22 0 0 1 22-22Z",
      class: "think-bg",
    },
    askBubble,
  );
  lines(askBubble, 156, 198, [120, 90, 60], "think-line");

  /* the agent */
  const robot = el("g", { class: "art-robot" }, svg);
  el("ellipse", { cx: 1010, cy: 600, rx: 120, ry: 16, class: "robot-shadow" }, robot);
  el("path", { d: "M1010 330v-34", class: "antenna" }, robot);
  el("circle", { cx: 1010, cy: 290, r: 10, class: "antenna-tip" }, robot);
  el("rect", { x: 930, y: 460, width: 160, height: 130, rx: 44, class: "robot-white" }, robot);
  const badge = el("g", { class: "robot-badge" }, robot);
  el("circle", { cx: 1010, cy: 524, r: 24, class: "badge-bg" }, badge);
  el("path", { d: "M998 524l8 8 15-16", class: "badge-check" }, badge);
  el("circle", { cx: 902, cy: 392, r: 30, class: "robot-ear" }, robot);
  el("circle", { cx: 1118, cy: 392, r: 30, class: "robot-ear" }, robot);
  el("rect", { x: 900, y: 326, width: 220, height: 138, rx: 64, class: "robot-white" }, robot);
  el("rect", { x: 930, y: 354, width: 160, height: 80, rx: 40, class: "robot-visor" }, robot);
  const eyes = [
    el("circle", { cx: 978, cy: 394, r: 16, class: "robot-eye" }, robot),
    el("circle", { cx: 1042, cy: 394, r: 16, class: "robot-eye" }, robot),
  ];

  return {
    blob,
    ground,
    gears,
    phone,
    status,
    ask,
    work,
    shimmer,
    reply,
    receipt,
    ok,
    pill,
    pillText,
    person,
    askBubble,
    robot,
    badge,
    eyes,
  };
}
export type HeroArt = ReturnType<typeof heroArt>;
