/*
 * The scroll story's track: how far the page scrolls for each part of the story, and what moment of the timeline each
 * scroll position shows. Three kinds of piece, in order:
 *
 *   scrub  scroll drives the timeline from one second to another in a straight line (most of the story)
 *   play   a flow (the team or settlement scene) plays by itself on its own clock while the page rests on it;
 *          scrolling inside this piece changes nothing, so the whole flow fits one screen of scrolling
 *   out    scroll drives the timeline from wherever the flow's clock had got to, on to a given second, so scrolling
 *          past a flow before it ends leaves smoothly instead of jumping to its end
 */
export type Piece =
  | { kind: "scrub"; from: number; to: number; px: number }
  | { kind: "play"; flow: string; px: number }
  | { kind: "out"; flow: string; to: number; px: number };

type Placed = Piece & { p0: number; p1: number };

/**
 * Piece edges carry float noise (56.2 - 54.8 is 1.4000000000000057), while the page rests on whole or device pixels.
 * A position this close below an edge counts as past it, so a page snapped to a flow's start is inside the flow.
 */
export const EDGE_PX = 1;

export type Track = {
  /** Pixels of scrolling from the first moment of the story to the last. */
  total: number;
  pieces: Placed[];
  /** The piece at a scroll offset, and how far through it (0 to 1). Offsets outside the track clamp to its ends. */
  locate: (px: number) => { index: number; piece: Placed; e: number };
  /** The timeline second to show at a scroll offset, given each flow's own clock. */
  timeAt: (px: number, clockOf: (flow: string) => number) => number;
  /** Where a flow's play piece starts and ends on the page. */
  flowSpan: (flow: string) => { from: number; to: number };
  /** Scroll offset of timeline second `t`, for nav links. A second inside a flow is where that flow starts. */
  px: (t: number) => number;
};

export function buildTrack(start: number, pieces: Piece[]): Track {
  if (pieces.length === 0) throw new Error("track: no pieces");
  const first = pieces[0];
  if (first?.kind === "scrub" && first.from !== start) {
    throw new Error(`track: the first piece must start at the story start (${String(start)})`);
  }
  const placed: Placed[] = [];
  let p = 0;
  for (const piece of pieces) {
    if (!(piece.px > 0)) throw new Error("track: every piece needs some scroll");
    if (piece.kind === "scrub" && !(piece.to > piece.from)) throw new Error("track: a scrub piece must move forward");
    placed.push({ ...piece, p0: p, p1: p + piece.px });
    p += piece.px;
  }
  const total = p;

  const locate = (px: number) => {
    const x = Math.min(total, Math.max(0, px));
    let index = placed.findIndex((c) => x < c.p1 - EDGE_PX);
    if (index < 0) index = placed.length - 1;
    const piece = placed[index] as Placed;
    return { index, piece, e: Math.min(1, Math.max(0, (x - piece.p0) / piece.px)) };
  };

  const timeAt = (px: number, clockOf: (flow: string) => number) => {
    const { piece, e } = locate(px);
    if (piece.kind === "scrub") return piece.from + (piece.to - piece.from) * e;
    if (piece.kind === "play") return clockOf(piece.flow);
    const from = clockOf(piece.flow);
    return from + (piece.to - from) * e;
  };

  const flowSpan = (flow: string) => {
    const c = placed.find((x) => x.kind === "play" && x.flow === flow);
    if (!c) throw new Error(`track: no flow ${flow}`);
    return { from: c.p0, to: c.p1 };
  };

  const px = (t: number) => {
    const hit = placed.find((c) => c.kind === "scrub" && t >= c.from && t <= c.to);
    if (hit && hit.kind === "scrub") return hit.p0 + ((t - hit.from) / (hit.to - hit.from)) * hit.px;
    // Inside a flow: the start of the flow whose scene is on screen at that second.
    const before = placed.filter((c) => c.kind === "scrub" && c.to <= t).pop();
    const next = before ? placed[placed.indexOf(before) + 1] : undefined;
    return next ? next.p0 : total;
  };

  return { total, pieces: placed, locate, timeAt, flowSpan, px };
}

/**
 * Where the page should settle after a scroll, in 0 to 1 progress. Resting points are in `stops`. Inside a `free`
 * range the page stays where it is, so that stretch is one continuous scroll. Otherwise it settles on the next stop in
 * the direction of scrolling (`dir` > 0 is down). A free range's own edges must be stops, so a scroll that is heading
 * into one stops at its start and does not fly through it.
 */
export function snapTarget(value: number, dir: number, stops: number[], free: [number, number][]): number {
  if (free.some(([a, b]) => value > a && value < b)) return value;
  const sorted = [...stops].sort((a, b) => a - b);
  const first = sorted[0] ?? 0;
  const last = sorted[sorted.length - 1] ?? 1;
  if (dir >= 0) return sorted.find((s) => s >= value) ?? last;
  return [...sorted].reverse().find((s) => s <= value) ?? first;
}
