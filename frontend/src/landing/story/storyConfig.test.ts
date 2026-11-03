import { describe, expect, it } from "vitest";
import {
  anchorPx,
  anchorsFor,
  FLOW_RATE,
  FLOWS,
  flowsFor,
  footerFor,
  navFor,
  SCROLL_PX,
  snapPlan,
  STORY_START,
  STORY_T,
  storyVariant,
  variantTrack,
  type Variant,
} from "./storyConfig";

const VARIANTS: Variant[] = ["lean", "flows", "full"];

describe("storyVariant", () => {
  it("is the lean story unless the address asks for an earlier one", () => {
    expect(storyVariant("")).toBe("lean");
    expect(storyVariant("?story=flows")).toBe("flows");
    expect(storyVariant("?story=full")).toBe("full");
    expect(storyVariant("?x=1&story=full")).toBe("full");
  });

  it("falls back to the lean story for anything else: the value comes from the address bar", () => {
    expect(storyVariant("?story=lean")).toBe("lean");
    expect(storyVariant("?story=%3Cscript%3E")).toBe("lean");
    expect(storyVariant("?story=")).toBe("lean");
  });
});

describe("the flows", () => {
  it("each flow's steps sit inside its play range, in order", () => {
    for (const f of FLOWS) {
      expect(f.enter).toBeLessThan(f.start);
      expect(f.start).toBeLessThan(f.end);
      expect(f.end).toBeLessThan(f.out);
      expect([...f.steps].sort((a, b) => a - b)).toEqual([...f.steps]);
      expect(f.steps[0]).toBe(f.start);
      expect(f.steps.at(-1) ?? 0).toBeLessThan(f.end);
    }
  });

  it("each flow plays for about twenty seconds, and every step stays long enough to read", () => {
    for (const f of FLOWS) {
      const seconds = (f.end - f.start) / FLOW_RATE;
      expect(seconds).toBeGreaterThan(12);
      expect(seconds).toBeLessThan(22);
      for (let i = 1; i < f.steps.length; i++) {
        const step = ((f.steps[i] ?? 0) - (f.steps[i - 1] ?? 0)) / FLOW_RATE;
        expect(step).toBeGreaterThan(3);
        expect(step).toBeLessThan(5);
      }
    }
  });

  it("which flows play depends on the story: lean has only the settlement one, flows has both, full none", () => {
    expect(flowsFor("lean").map((f) => f.name)).toEqual(["settlement"]);
    expect(flowsFor("flows").map((f) => f.name)).toEqual(["team", "settlement"]);
    expect(flowsFor("full")).toEqual([]);
  });
});

describe("how long each story is to scroll", () => {
  const total = (v: Variant) => variantTrack(v).total;

  it("the full story keeps the one-speed scroll it had before", () => {
    expect(total("full")).toBe((STORY_T - STORY_START) * SCROLL_PX);
  });

  it("the flows story is under a third of the full one, about fifteen screens", () => {
    expect(total("flows")).toBeLessThan(total("full") / 3);
    expect(total("flows")).toBeLessThan(15_000);
  });

  it("the lean story is under half the flows story: seven screens at most", () => {
    expect(total("lean")).toBeLessThan(total("flows") * 0.5);
    expect(total("lean")).toBeLessThan(6_500);
  });

  it("a page snapped to a flow's start on a whole pixel is inside the flow, so the flow plays", () => {
    for (const v of ["lean", "flows"] as const) {
      const track = variantTrack(v);
      for (const f of flowsFor(v)) {
        const { from } = track.flowSpan(f.id);
        expect(track.locate(Math.round(from)).piece.kind).toBe("play");
        expect(track.locate(Math.floor(from)).piece.kind).toBe("play");
      }
    }
  });

  it("each flow that plays is one screen of scrolling or a little more, not five", () => {
    for (const v of ["lean", "flows"] as const) {
      const track = variantTrack(v);
      for (const f of flowsFor(v)) {
        const { from, to } = track.flowSpan(f.id);
        expect(to - from).toBeGreaterThanOrEqual(900);
        expect(to - from).toBeLessThanOrEqual(1400);
      }
    }
  });
});

describe("every story", () => {
  for (const variant of VARIANTS) {
    const track = variantTrack(variant);
    const plan = snapPlan(variant, track);

    it(`${variant}: resting points are in order and inside the story`, () => {
      expect([...plan.stops].sort((a, b) => a - b)).toEqual(plan.stops);
      expect(plan.stops[0]).toBe(0);
      expect(plan.stops.at(-1)).toBeCloseTo(1, 9);
    });

    it(`${variant}: a free range starts and ends on a resting point, so a scroll cannot fly through it`, () => {
      for (const [a, b] of plan.free) {
        expect(plan.stops.some((s) => Math.abs(s - a) < 1e-9)).toBe(true);
        expect(plan.stops.some((s) => Math.abs(s - b) < 1e-9)).toBe(true);
        expect(b).toBeGreaterThan(a);
      }
    });

    it(`${variant}: there is a free range for each flow that plays, with no resting point inside it`, () => {
      expect(plan.free).toHaveLength(flowsFor(variant).length);
      for (const [a, b] of plan.free) {
        expect(plan.stops.filter((s) => s > a + 1e-9 && s < b - 1e-9)).toEqual([]);
      }
    });

    it(`${variant}: every nav link lands inside the story, in order down the page`, () => {
      const tops = anchorsFor(variant).map((a) => anchorPx(track, variant, a));
      for (const top of tops) {
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top).toBeLessThan(track.total);
      }
      expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    });
  }

  it("the full story rests at every step of both flows, as it always did", () => {
    expect(snapPlan("full", variantTrack("full")).stops.length).toBeGreaterThan(15);
  });

  it("the nav links for a flow land where that flow starts playing", () => {
    const flows = variantTrack("flows");
    expect(anchorPx(flows, "flows", ["agents", 31, "#s3"])).toBe(flows.flowSpan("#s3").from);
    const lean = variantTrack("lean");
    expect(anchorPx(lean, "lean", ["how-it-works", 59.2, "#ss"])).toBe(lean.flowSpan("#ss").from);
    // In the full story the same links land on the second they always did.
    const full = variantTrack("full");
    expect(anchorPx(full, "full", ["agents", 31, "#s3"])).toBe(full.px(31));
  });
});

describe("the lean story", () => {
  const track = variantTrack("lean");

  it("shows the hero, the problem, the settlement flow and the closer, and skips the rest", () => {
    const seen = (t: number) => track.pieces.some((p) => p.kind === "scrub" && t >= p.from && t <= p.to);
    for (const t of [6, 10, 15.9, 55, 99, STORY_T]) expect(seen(t)).toBe(true);
    // How it works, the team, the integrations and the credentials are never reached by scrolling.
    for (const t of [20, 30, 45, 85, 92]) expect(seen(t)).toBe(false);
  });

  it("every skipped stretch begins and ends with the scenes on either side faded out", () => {
    // Scenes fade over half a second ending at these seconds (beatsIntro and beatsMid): the problem out at 16 and
    // the settlement in at 54.8; the settlement out at 82 and the closer in at 96.8.
    const ends = track.pieces.flatMap((p) => (p.kind === "scrub" ? [[p.from, p.to]] : []));
    expect(ends).toContainEqual([6.8, 16]);
    expect(ends).toContainEqual([54.8, 56.2]);
    expect(ends).toContainEqual([96.8, STORY_T]);
  });

  it("the nav only offers parts the lean page has", () => {
    expect(navFor("lean").map((l) => l.href)).toEqual(["#problem", "#how-it-works", "#faq"]);
    expect(navFor("flows").map((l) => l.label)).toContain("Integrations");
    const ids = anchorsFor("lean").map((a) => `#${a[0]}`);
    for (const l of navFor("lean")) if (l.href !== "#faq") expect(ids).toContain(l.href);
  });
});

describe("footerFor", () => {
  it("links only to sections the story has, so no footer link is dead", () => {
    for (const variant of VARIANTS) {
      const ids = new Set([...anchorsFor(variant).map(([id]) => `#${id}`), "#faq"]);
      const links = footerFor(variant).flatMap((c) => c.links);
      expect(links.length).toBeGreaterThan(0);
      for (const [, href] of links) expect(ids.has(href ?? "")).toBe(true);
    }
  });

  it("the lean story keeps How it works and the FAQ", () => {
    expect(footerFor("lean").flatMap((c) => c.links.map(([label]) => label))).toEqual(["How it works", "FAQ"]);
  });
});
