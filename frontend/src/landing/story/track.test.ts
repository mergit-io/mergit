import { describe, expect, it } from "vitest";
import { buildTrack, snapTarget, type Piece } from "./track";

// A small story: 0 to 10 s scrubbed, a flow that plays on its own, 10 to 14 s scrubbed back out, then 14 to 20 s.
const pieces: Piece[] = [
  { kind: "scrub", from: 0, to: 10, px: 1000 },
  { kind: "play", flow: "a", px: 500 },
  { kind: "out", flow: "a", to: 14, px: 400 },
  { kind: "scrub", from: 14, to: 20, px: 600 },
];
const track = buildTrack(0, pieces);
const clock = (t: number) => () => t;

describe("buildTrack", () => {
  it("adds up the scroll of every piece", () => {
    expect(track.total).toBe(2500);
  });

  it("refuses pieces that do not make sense", () => {
    expect(() => buildTrack(0, [])).toThrow();
    expect(() => buildTrack(0, [{ kind: "scrub", from: 0, to: 0, px: 100 }])).toThrow();
    expect(() => buildTrack(0, [{ kind: "scrub", from: 0, to: 5, px: 0 }])).toThrow();
    expect(() => buildTrack(0, [{ kind: "play", flow: "a", px: -1 }])).toThrow();
    expect(() => buildTrack(5, [{ kind: "scrub", from: 0, to: 10, px: 100 }])).toThrow(/start/i);
  });

  it("scrubbed pieces map scroll to time in a straight line", () => {
    expect(track.timeAt(0, clock(0))).toBe(0);
    expect(track.timeAt(500, clock(0))).toBe(5);
    // Exactly where the flow starts, its own clock takes over at the second the scrub ended on.
    expect(track.timeAt(1000, clock(10))).toBe(10);
    expect(track.timeAt(2200, clock(0))).toBeCloseTo(14 + (2200 - 1900) / 100, 9);
    expect(track.timeAt(2500, clock(0))).toBe(20);
  });

  it("while a flow plays, the time is the flow's own clock, however far the page scrolls", () => {
    expect(track.timeAt(1000, clock(3))).toBe(3);
    expect(track.timeAt(1250, clock(7.5))).toBe(7.5);
    expect(track.timeAt(1499, clock(12))).toBe(12);
  });

  it("leaving a flow carries on from wherever its clock was, so there is no jump", () => {
    // Out piece spans scroll 1500 to 1900 and ends at 14 s.
    expect(track.timeAt(1500, clock(10.5))).toBeCloseTo(10.5, 9);
    expect(track.timeAt(1700, clock(10.5))).toBeCloseTo((10.5 + 14) / 2, 9);
    expect(track.timeAt(1900, clock(10.5))).toBe(14);
    // A flow that had not got far still reaches the same end.
    expect(track.timeAt(1900, clock(2))).toBe(14);
  });

  it("holds at the ends instead of running past them", () => {
    expect(track.timeAt(-10, clock(0))).toBe(0);
    expect(track.timeAt(99_999, clock(0))).toBe(20);
  });

  it("says which piece a scroll position is in, and how far through it", () => {
    expect(track.locate(250)).toMatchObject({ index: 0, e: 0.25 });
    expect(track.locate(1250)).toMatchObject({ index: 1, e: 0.5 });
    expect(track.locate(1700)).toMatchObject({ index: 2, e: 0.5 });
    expect(track.locate(-5)).toMatchObject({ index: 0, e: 0 });
    expect(track.locate(9999)).toMatchObject({ index: 3, e: 1 });
  });

  it("knows where a flow starts and ends on the page", () => {
    expect(track.flowSpan("a")).toEqual({ from: 1000, to: 1500 });
    expect(() => track.flowSpan("nope")).toThrow();
  });

  it("knows where a moment of a scrubbed piece sits on the page, for nav links", () => {
    expect(track.px(0)).toBe(0);
    expect(track.px(5)).toBe(500);
    expect(track.px(16)).toBe(1900 + 200);
    // A moment inside the flow's own stretch is where the flow starts.
    expect(track.px(10)).toBe(1000);
  });

  it("is monotonic for a clock that does not run backwards: more scroll is never earlier", () => {
    let last = -1;
    for (let x = 0; x <= 2500; x += 25) {
      const t = track.timeAt(x, clock(Math.min(13, 10 + x / 1000)));
      expect(t).toBeGreaterThanOrEqual(last - 1e-9);
      last = t;
    }
  });
});

describe("snapTarget", () => {
  const stops = [0, 0.2, 0.3, 0.9, 1];
  const free: [number, number][] = [[0.3, 0.9]];

  it("settles on the next resting point in the direction of scrolling", () => {
    expect(snapTarget(0.05, 1, stops, free)).toBe(0.2);
    expect(snapTarget(0.25, 1, stops, free)).toBe(0.3);
    expect(snapTarget(0.25, -1, stops, free)).toBe(0.2);
    expect(snapTarget(0.95, -1, stops, free)).toBe(0.9);
  });

  it("does not move the page while it is inside a free range", () => {
    for (const v of [0.31, 0.5, 0.89]) {
      expect(snapTarget(v, 1, stops, free)).toBe(v);
      expect(snapTarget(v, -1, stops, free)).toBe(v);
    }
  });

  it("settles at the edge of a free range instead of flying through it", () => {
    expect(snapTarget(0.27, 1, stops, free)).toBe(0.3);
    expect(snapTarget(0.92, -1, stops, free)).toBe(0.9);
  });

  it("stays inside the story at both ends", () => {
    expect(snapTarget(0.999, 1, stops, free)).toBe(1);
    expect(snapTarget(0.0001, -1, stops, free)).toBe(0);
    expect(snapTarget(1.2, 1, stops, free)).toBe(1);
  });
});
