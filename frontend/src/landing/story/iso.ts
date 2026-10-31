/*
 * Isometric drawing helpers for the scroll story. World axes: x runs right-down,
 * y left-down, z up. Everything is plain SVG built once on mount.
 */
const NS = "http://www.w3.org/2000/svg";
export const C = Math.cos(Math.PI / 6);
export const S = 0.5;

export type V3 = readonly [number, number, number];

export const P = (x: number, y: number, z = 0): [number, number] => [(x - y) * C, (x + y) * S - z];
const xy = (p: V3) =>
  P(p[0], p[1], p[2])
    .map((n) => n.toFixed(1))
    .join(",");
export const pts = (a: readonly V3[]) => a.map(xy).join(" ");
export const isoD = (a: readonly V3[]) => a.map((p, i) => (i ? "L" : "M") + xy(p).replace(",", " ")).join(" ");

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

/** A group whose local 2D (u, v) lies flat on the horizontal plane at height z. */
export function plane(parent: Element, x: number, y: number, z: number) {
  const [ox, oy] = P(x, y, z);
  return el("g", { transform: `matrix(${C},${S},${-C},${S},${ox},${oy})` }, parent);
}

/** A group whose local 2D stands upright on the plane y = const, facing the viewer's left. */
export function vplane(parent: Element, x: number, y: number, z: number) {
  const [ox, oy] = P(x, y, z);
  return el("g", { transform: `matrix(${C},${S},0,1,${ox},${oy})` }, parent);
}

export interface BoxOpts {
  x: number;
  y: number;
  z?: number;
  w: number;
  d: number;
  h: number;
  label?: string;
  cls?: string;
  seam?: number;
  stripe?: number;
  screws?: boolean;
}
export interface Box {
  g: SVGGElement;
  top: SVGGElement;
  stripe?: SVGPolylineElement;
}

export function box(parent: Element, o: BoxOpts): Box {
  const { x, y, z = 0, w, d, h } = o;
  const g = el("g", { class: `iso ${o.cls ?? ""}` }, parent);
  el(
    "polygon",
    {
      class: "f-r",
      points: pts([
        [x + w, y, z + h],
        [x + w, y + d, z + h],
        [x + w, y + d, z],
        [x + w, y, z],
      ]),
    },
    g,
  );
  el(
    "polygon",
    {
      class: "f-l",
      points: pts([
        [x, y + d, z + h],
        [x + w, y + d, z + h],
        [x + w, y + d, z],
        [x, y + d, z],
      ]),
    },
    g,
  );
  const ring = (zz: number, cls: string) =>
    el(
      "polyline",
      {
        class: cls,
        points: pts([
          [x, y + d, zz],
          [x + w, y + d, zz],
          [x + w, y, zz],
        ]),
      },
      g,
    );
  if (o.seam != null) ring(z + o.seam, "seam");
  const stripe = o.stripe != null ? ring(z + o.stripe, "stripe") : undefined;
  el(
    "polygon",
    {
      class: "f-t",
      points: pts([
        [x, y, z + h],
        [x + w, y, z + h],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ]),
    },
    g,
  );
  const top = plane(g, x, y, z + h);
  if (o.screws)
    for (const [a, b] of [
      [9, 9],
      [w - 9, 9],
      [w - 9, d - 9],
      [9, d - 9],
    ] as const)
      el("circle", { cx: a, cy: b, r: 2.2, class: "screw" }, top);
  if (o.label) {
    const t = el("text", { x: w / 2, y: d / 2 + 6, class: "isolabel", "text-anchor": "middle" }, top);
    t.textContent = o.label;
  }
  return stripe ? { g, top, stripe } : { g, top };
}
