/*
 * Builds every illustration in the scroll story from plain SVG. Returns the
 * handles the timeline animates. Called once per mount, on the story root.
 */
import { box, el, isoD, P, plane, pts, vplane, type Box, type V3 } from "./iso";

const q = (root: ParentNode, sel: string) => {
  const e = root.querySelector(sel);
  if (!e) throw new Error(`story: missing ${sel}`);
  return e;
};

/* ---------- objects ---------- */

function coin(parent: Element) {
  const g = el("g", { class: "coin" }, parent);
  for (let k = 0; k <= 9; k++) {
    const t = plane(g, 0, 0, k);
    el(
      "circle",
      {
        cx: 0,
        cy: 0,
        r: 30,
        class: k < 9 ? "coin-edge" : "coin-face",
        ...(k === 0 || k === 9 ? { "data-rim": 1 } : {}),
      },
      t,
    );
    if (k === 9) {
      el("circle", { cx: 0, cy: 0, r: 20, class: "coin-ring" }, t);
      const tx = el("text", { x: 0, y: 7, "text-anchor": "middle", class: "coin-mark" }, t);
      tx.textContent = "$";
    }
  }
  return g;
}
/** A coin parked at a world point. The wrapper holds the position so the coin itself can animate. */
const parked = (parent: Element, p: V3) => coin(el("g", { transform: `translate(${P(...p).join(",")})` }, parent));

function glass(parent: Element, x: number, y: number, z: number, w: number, d: number, h: number) {
  const g = el("g", {}, parent);
  const back = el("g", {}, g);
  const mid = el("g", {}, g);
  const front = el("g", {}, g);
  el(
    "polygon",
    {
      class: "glass-b",
      points: pts([
        [x, y, z],
        [x + w, y, z],
        [x + w, y + d, z],
        [x, y + d, z],
      ]),
    },
    back,
  );
  el(
    "polyline",
    {
      class: "glass-edge",
      points: pts([
        [x, y + d, z],
        [x, y, z],
        [x + w, y, z],
      ]),
    },
    back,
  );
  el(
    "path",
    {
      class: "glass-edge",
      d: isoD([
        [x, y, z],
        [x, y, z + h],
      ]),
    },
    back,
  );
  el(
    "polygon",
    {
      class: "glass-f r",
      points: pts([
        [x + w, y, z + h],
        [x + w, y + d, z + h],
        [x + w, y + d, z],
        [x + w, y, z],
      ]),
    },
    front,
  );
  el(
    "polygon",
    {
      class: "glass-f l",
      points: pts([
        [x, y + d, z + h],
        [x + w, y + d, z + h],
        [x + w, y + d, z],
        [x, y + d, z],
      ]),
    },
    front,
  );
  el(
    "polygon",
    {
      class: "glass-f t",
      points: pts([
        [x, y, z + h],
        [x + w, y, z + h],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ]),
    },
    front,
  );
  return { g, back, mid, front };
}

function receipt(parent: Element, x: number, y: number, z: number) {
  const g = el("g", {}, parent);
  const sheets: SVGGElement[] = [];
  let seal: SVGGElement | undefined;
  let bad: SVGGElement | undefined;
  for (let k = 2; k >= 0; k--) {
    const holder = vplane(g, x - k * 14, y, z + k * 12);
    const s = el("g", {}, holder);
    el("rect", { x: 0, y: 0, width: 120, height: 150, rx: 6, class: "sheet" }, s);
    if (k === 0) {
      const hd = el("text", { x: 14, y: 26, class: "sheet-title" }, s);
      hd.textContent = "RECEIPT";
      [44, 60, 76, 92].forEach((ly, i) =>
        el("line", { class: "rline", x1: 14, y1: ly, x2: [96, 80, 90, 64][i] ?? 80, y2: ly }, s),
      );
      seal = el("g", { class: "seal ok" }, s);
      el("circle", { cx: 88, cy: 120, r: 18 }, seal);
      el("path", { d: "M80 120l6 6 11-12" }, seal);
      bad = el("g", { class: "seal bad" }, s);
      el("circle", { cx: 88, cy: 120, r: 18 }, bad);
      el("path", { d: "M81 113l14 14M95 113l-14 14" }, bad);
    }
    sheets.unshift(holder);
  }
  if (!seal || !bad) throw new Error("story: receipt");
  return { g, sheets, seal, bad, lines: Array.from(g.querySelectorAll<SVGLineElement>(".rline")) };
}

function lockBadge(parent: Element, x: number, y: number, z: number) {
  const g = el("g", {}, parent);
  box(g, { x: x - 30, y: y - 30, z, w: 60, d: 60, h: 6 });
  const t = plane(g, x - 30, y - 30, z + 6);
  const closed = el("g", { class: "lock-closed" }, t);
  el("rect", { x: 18, y: 28, width: 24, height: 18, rx: 3 }, closed);
  el("path", { d: "M23 28v-6a7 7 0 0 1 14 0v6" }, closed);
  const open = el("g", { class: "lock-open" }, t);
  el("circle", { cx: 30, cy: 30, r: 17 }, open);
  el("path", { d: "M22 30l6 6 10-11" }, open);
  return { g, closed, open };
}

const hop = (a: V3, b: V3, lift: number) => {
  const [x1, y1] = P(...a);
  const [x2, y2] = P(...b);
  return `M${x1} ${y1}Q${(x1 + x2) / 2} ${Math.min(y1, y2) - lift} ${x2} ${y2}`;
};

/** You, the escrow box, the agent and its receipt. */
export function diorama(svg: Element, s = 1) {
  const root = el("g", { transform: `scale(${s})` }, svg);
  el(
    "path",
    {
      class: "guide",
      d: isoD([
        [-560, 0, 0],
        [560, 0, 0],
      ]),
    },
    root,
  );
  const rail = el(
    "path",
    {
      class: "wire faint",
      d: isoD([
        [-320, 0, 0],
        [320, 0, 0],
      ]),
    },
    root,
  );
  const you = box(root, { x: -400, y: -80, w: 160, d: 160, h: 14, screws: true, label: "YOU" });
  const stack = [0, 1].map((k) => parked(root, [-320, 0, 14 + k * 10]));
  const esc = glass(root, -90, -90, 0, 180, 180, 170);
  const lbl = el("text", { x: 90, y: 168, "text-anchor": "middle", class: "isolabel" }, plane(esc.back, -90, -90, 0));
  lbl.textContent = "ESCROW";
  const lock = lockBadge(root, 0, 0, 170);
  const agent = box(root, {
    x: 245,
    y: -75,
    w: 150,
    d: 150,
    h: 110,
    seam: 55,
    stripe: 55,
    screws: true,
    label: "AGENT",
  });
  const rec = receipt(root, 250, -75, 130);
  const at = { you: [-320, 0, 24], esc: [0, 0, 40], agent: [320, 0, 110] } as const satisfies Record<string, V3>;
  const held = parked(esc.mid, at.esc);
  const paid = parked(root, at.agent);
  const fly = coin(root);
  const path = { fund: hop(at.you, at.esc, 120), pay: hop(at.esc, at.agent, 170), back: hop(at.esc, at.you, 150) };
  return { root, rail, you, stack, esc, lock, agent, rec, held, paid, fly, path };
}
export type Diorama = ReturnType<typeof diorama>;

/* ---------- scenes ---------- */

function stack(svg: Element) {
  const W = 240;
  const plates: SVGGElement[] = [];
  for (let i = 3; i >= 0; i--) {
    const g = el("g", { class: "plate" }, svg);
    box(g, { x: -W / 2, y: -W / 2, w: W, d: W, h: 16, screws: true, seam: 8 });
    const t = el("g", { transform: "scale(0.8)" }, plane(g, -W / 2, -W / 2, 16));
    if (i === 0) {
      el("rect", { x: 46, y: 96, width: 208, height: 96, rx: 16, class: "ink-line" }, t);
      el("path", { d: "M84 192l-14 26 36-26", class: "ink-line paper" }, t);
      for (const [x, y, w] of [
        [70, 124, 150],
        [70, 146, 120],
        [70, 168, 84],
      ] as const)
        el("line", { x1: x, y1: y, x2: x + w, y2: y, class: "ink-bar" }, t);
      el("rect", { x: 160, y: 160, width: 4, height: 16, class: "caret" }, t);
    }
    if (i === 1) {
      const N = [
        [150, 62],
        [76, 150],
        [150, 150],
        [224, 150],
        [150, 238],
      ] as const;
      for (const [a, b] of [
        [0, 1],
        [0, 2],
        [0, 3],
        [1, 4],
        [2, 4],
        [3, 4],
      ] as const) {
        const A = N[a];
        const B = N[b];
        el("line", { x1: A[0], y1: A[1], x2: B[0], y2: B[1], class: "mint-line" }, t);
      }
      N.forEach(([x, y], k) =>
        el("rect", { x: x - 17, y: y - 17, width: 34, height: 34, rx: 6, class: k ? "node" : "node root" }, t),
      );
    }
    if (i === 2) {
      el("circle", { cx: 150, cy: 150, r: 74, class: "ink-line dashed" }, t);
      el("rect", { x: 118, y: 146, width: 64, height: 50, rx: 8, class: "ink-fill" }, t);
      el("path", { d: "M130 146v-16a20 20 0 0 1 40 0v16", class: "ink-shackle" }, t);
      el("circle", { cx: 150, cy: 168, r: 6, class: "mint-fill" }, t);
    }
    if (i === 3)
      for (let r = 0; r < 9; r++)
        for (let c = 0; c < 9; c++) {
          const on = (r * 7 + c * 13) % 5 < 2;
          const hi = r >= 3 && r <= 5 && c >= 3 && c <= 5;
          el(
            "rect",
            {
              x: 42 + c * 25,
              y: 42 + r * 25,
              width: 17,
              height: 17,
              rx: 3,
              class: hi ? "cell hi" : on ? "cell on" : "cell",
            },
            t,
          );
        }
    plates[i] = g;
  }
  return plates;
}

function team(svg: Element) {
  const B = 150;
  const H = 100;
  const glow = el("ellipse", { cx: 0, cy: 0, rx: 330, ry: 330, class: "pool" }, plane(svg, 0, 0, 0));
  const wire = el(
    "path",
    {
      class: "wire",
      d: isoD([
        [-270, -135, 0],
        [0, -135, 0],
        [270, -135, 0],
        [270, 0, 0],
        [-270, 0, 0],
        [-270, 135, 0],
        [0, 135, 0],
        [270, 135, 0],
      ]),
    },
    svg,
  );
  const pkts = [0, 1, 2].map(() => el("circle", { r: 6, class: "pkt" }, svg));
  const roles: [string, number, number][] = [
    ["PLANNER", -270, -135],
    ["RESEARCH", 0, -135],
    ["CODE", 270, -135],
    ["QA", -270, 135],
    ["REVIEW", 0, 135],
    ["DOCS", 270, 135],
  ];
  const boxes: Record<string, Box & { c: [number, number] }> = {};
  [...roles]
    .sort((a, b) => a[1] + a[2] - (b[1] + b[2]))
    .forEach(([n, cx, cy]) => {
      boxes[n] = {
        ...box(svg, { x: cx - B / 2, y: cy - B / 2, w: B, d: B, h: H, seam: 50, stripe: 50, screws: true, label: n }),
        c: [cx, cy],
      };
    });
  const review = boxes.REVIEW;
  if (!review) throw new Error("story: team");
  const [rx, ry] = review.c;
  const lock = el("g", { class: "lock-tile" }, svg);
  box(lock, { x: rx - 45, y: ry - 45, z: 240, w: 90, d: 90, h: 10 });
  const lt = plane(lock, rx - 45, ry - 45, 250);
  const lockIcon = el("g", { class: "lock-closed" }, lt);
  el("rect", { x: 29, y: 44, width: 32, height: 26, rx: 4 }, lockIcon);
  el("path", { d: "M35 44v-8a10 10 0 0 1 20 0v8" }, lockIcon);
  const checkIcon = el("g", { class: "lock-open" }, lt);
  el("circle", { cx: 45, cy: 45, r: 26 }, checkIcon);
  el("path", { d: "M33 46l8 8 16-17" }, checkIcon);
  const lockLine = el(
    "path",
    {
      class: "leader dashed",
      d: isoD([
        [rx, ry, 110],
        [rx, ry, 240],
      ]),
    },
    svg,
  );
  const hashes = roles.map(([, cx, cy]) => {
    const g = el("g", {}, svg);
    box(g, { x: cx - 16, y: cy - 16, z: 104, w: 32, d: 32, h: 32 });
    return { g, c: [cx, cy] as const };
  });
  const proof = el("g", {}, svg);
  box(proof, { x: -40, y: -40, z: 330, w: 80, d: 80, h: 80, cls: "mint" });
  const ids = roles.map(([, cx, cy]) => {
    const g = el("g", {}, svg);
    box(g, { x: cx - 52, y: cy - 52, z: 102, w: 104, d: 104, h: 8 });
    const t = plane(g, cx - 52, cy - 52, 110);
    el("circle", { cx: 52, cy: 52, r: 22, class: "id-ring" }, t);
    el("circle", { cx: 52, cy: 52, r: 7, class: "id-dot" }, t);
    return g;
  });
  return { glow, wire, pkts, boxes, lock, lockIcon, checkIcon, lockLine, hashes, proof, ids };
}

function apps(svg: Element) {
  const A: [string, number, number][] = [
    ["GITHUB", -460, 10],
    ["SLACK", 10, -460],
    ["LINEAR", -10, 460],
    ["NOTION", 460, -10],
  ];
  const S2 = 170;
  const Z = 130;
  const wires = A.map(([, cx, cy]) => {
    const elbow: V3 = Math.abs(cx) > Math.abs(cy) ? [cx * 0.3, cy, 0] : [cx, cy * 0.3, 0];
    return el("path", { class: "wire", d: isoD([[cx, cy, 0], elbow, [0, 0, 0]]) }, svg);
  });
  const pk = A.map(() => el("circle", { r: 6, class: "pkt" }, svg));
  const back = el("circle", { r: 6, class: "pkt" }, svg);
  const hub = el("g", {}, svg);
  box(hub, { x: -150, y: -150, w: 300, d: 300, h: 22, seam: 11 });
  const ht = plane(hub, -150, -150, 22);
  el("rect", { x: 95, y: 95, width: 110, height: 110, rx: 10, class: "ink-fill" }, ht);
  const tx = el("text", { x: 150, y: 157, "text-anchor": "middle", class: "isolabel on-ink" }, ht);
  tx.textContent = "MERGIT";
  const plates = [...A]
    .sort((a, b) => a[1] + a[2] - (b[1] + b[2]))
    .map(([n, cx, cy]) => {
      const g = el("g", {}, svg);
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const lx = cx + sx * (S2 / 2 - 10);
        const ly = cy + sy * (S2 / 2 - 10);
        el(
          "path",
          {
            class: "leader faint",
            d: isoD([
              [lx, ly, 0],
              [lx, ly, Z],
            ]),
          },
          g,
        );
      }
      box(g, { x: cx - S2 / 2, y: cy - S2 / 2, z: Z, w: S2, d: S2, h: 14, screws: true, label: n });
      return g;
    });
  return { wires, pk, back, hub, plates };
}

function cred(svg: Element) {
  const B = 150;
  el(
    "path",
    {
      class: "guide",
      d: isoD([
        [-620, 0, 0],
        [620, 0, 0],
      ]),
    },
    svg,
  );
  const wire = el(
    "path",
    {
      class: "wire",
      d: isoD([
        [-330, 0, 0],
        [400, 0, 0],
      ]),
    },
    svg,
  );
  const wallPath = el(
    "path",
    {
      class: "nopaint",
      d: isoD([
        [-330, 0, 0],
        [198, 0, 0],
      ]),
    },
    svg,
  );
  const mk = (n: string, cx: number) =>
    box(svg, { x: cx - B / 2, y: -B / 2, w: B, d: B, h: 110, seam: 55, screws: true, label: n });
  const vault = mk("SEALED", -330);
  const wall = el(
    "polygon",
    {
      class: "wall",
      points: pts([
        [205, -105, 0],
        [205, 105, 0],
        [205, 105, 230],
        [205, -105, 230],
      ]),
    },
    svg,
  );
  const tools = mk("TOOLS", 0);
  const model = mk("MODEL", 400);
  const ctx = el("circle", { r: 7, class: "pkt" }, svg);
  const key = el("g", { class: "key" }, svg);
  el("circle", { r: 9 }, key);
  el("path", { d: "M-3 0h6M0-3v6" }, key);
  const x = el("g", { class: "xmark" }, svg);
  const xg = el("g", { transform: `translate(${P(205, 0, 70).join(",")})` }, x);
  el("circle", { r: 18 }, xg);
  el("path", { d: "M-6-6l12 12M6-6l-12 12" }, xg);
  return { wire, wallPath, vault, wall, tools, model, ctx, key, x };
}

export function buildScenes(root: HTMLElement) {
  return {
    plates: stack(q(root, "#stack")),
    team: team(q(root, "#team")),
    settle: diorama(q(root, "#m-dio"), 1.2),
    apps: apps(q(root, "#apps")),
    cred: cred(q(root, "#cred")),
    closer: diorama(q(root, "#z-dio"), 0.95),
  };
}
export type Scenes = ReturnType<typeof buildScenes>;
