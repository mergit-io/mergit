/*
 * The scroll story's shape: how long the timeline is, where the nav links land, and how the page scrolls through it.
 * Three variants share one timeline and every animation. They differ only in which parts of it the page shows and how
 * it scrolls through them.
 *
 *   lean   (default) hero, the problem, the settlement flow and the closer. The settlement flow sits on one screen and
 *          plays by itself like a short video. The other scenes are skipped: the timeline jumps over them.
 *   flows  every scene, with both flows (team and settlement) playing by themselves on one screen each.
 *   full   the original: every scene, and the page scrolls through every step of both flows. Slowest.
 *
 * `/?story=flows` and `/?story=full` stay available to compare, and to go back if lean is not right.
 */
import { footer, nav as classicNav } from "../content";
import { buildTrack, type Piece, type Track } from "./track";

/** Timeline length in seconds. */
export const STORY_T = 102;
/** Pixels of scroll per second in the full story. */
export const SCROLL_PX = 520;
/** The scroll story starts just before the hero leaves; the hero itself plays on load. */
export const STORY_START = 5.6;

/** Pixels of scroll per second of timeline for everything that scrubs in the default story. */
const BASE_PX = 260;
/** Pixels the page rests on a flow while it plays. Scrolling inside that stretch changes nothing. */
const DWELL_PX = 1000;
/** Seconds of timeline that pass for each real second while a flow plays. */
export const FLOW_RATE = 1.2;

/**
 * The two flows. Each scene fades in at `enter`, its steps run from `start` to `end` (a step begins at each of
 * `steps`), and it fades out by `out`. All are seconds on the master timeline, as set in beatsMid.ts.
 */
export const FLOWS = [
  { id: "#s3", name: "team", enter: 26.8, start: 28.2, end: 53.8, out: 55, steps: [28.2, 33.6, 39, 44.4, 49.8] },
  { id: "#ss", name: "settlement", enter: 55, start: 56.2, end: 81, out: 82, steps: [56.2, 61.4, 66.6, 71.8, 77] },
] as const;

/** A nav link's landing place: its id, the second it lands on, and the flow scene it lands on when there is one. */
export type Anchor = readonly [id: string, t: number, flow?: string];

export type Variant = "lean" | "flows" | "full";

const ANCHORS_ALL: readonly Anchor[] = [
  ["how-it-works", 18.6],
  ["agents", 31, "#s3"],
  ["proofs", 59.2, "#ss"],
  ["integrations", 84.9],
];
const ANCHORS_LEAN: readonly Anchor[] = [
  ["problem", 7.2],
  ["how-it-works", 59.2, "#ss"],
];

export const ANCHORS = ANCHORS_ALL;
export const anchorsFor = (variant: Variant): readonly Anchor[] => (variant === "lean" ? ANCHORS_LEAN : ANCHORS_ALL);

/** The nav links shown for a variant. The lean story only has parts of the page that still exist. */
export function navFor(variant: Variant): { label: string; href: string }[] {
  if (variant !== "lean") return classicNav;
  return [
    { label: "The problem", href: "#problem" },
    { label: "How it works", href: "#how-it-works" },
    { label: "FAQ", href: "#faq" },
  ];
}

/**
 * The footer's links for a story: only those whose section the story has (its anchors and the FAQ under it), so none
 * is a dead link. A column left with no links is dropped.
 */
export function footerFor(variant: Variant): typeof footer.columns {
  const ids = new Set([...anchorsFor(variant).map(([id]) => `#${id}`), "#faq"]);
  return footer.columns
    .map((col) => ({ ...col, links: col.links.filter(([, href]) => ids.has(href ?? "")) }))
    .filter((col) => col.links.length > 0);
}

/** The flows that play by themselves in a variant. */
export const flowsFor = (variant: Variant): readonly (typeof FLOWS)[number][] =>
  variant === "lean" ? [FLOWS[1]] : variant === "flows" ? FLOWS : [];

/** The full story's resting points: every scene and every stepper step. Scrolling settles on the next one. */
const FULL_STOPS = [
  5.6, // hero
  11.9, // problem: the metered side is done
  14.2, // problem: both sides done
  18.6, // how it works: the stack has opened
  23.9, // how it works: all four steps labelled
  31, // team 1: the planner lifts
  37.9, // team 2: work dispatched
  42.8, // team 3: approval granted
  48.2, // team 4: hashes merged into one proof
  52.8, // team 5: identities issued
  59.2, // settlement 1: funded and held
  64.4, // settlement 2: receipt built
  69.6, // settlement 3: receipt checked
  74.9, // settlement 4: agent paid
  81, // settlement 5: refunded
  84.9, // integrations: wired
  88.7, // integrations: the loop closed
  92.6, // credentials: boundary in place
  96, // credentials: key blocked
  100.5, // closer
  STORY_T,
];

/** Resting points outside the flows in the flows story (each flow adds its own two, in `snapPlan`). */
const FLOWS_STOPS = [5.6, 11.9, 14.2, 18.6, 23.9, 84.9, 88.7, 92.6, 96, 100.5, STORY_T];
/** The same for the lean story: the hero, the two halves of the problem, and the closer. */
const LEAN_STOPS = [5.6, 11.9, 14.2, 96.8, 100.5, STORY_T];

const scrub = (from: number, to: number, pxPerSec = BASE_PX): Piece => ({
  kind: "scrub",
  from,
  to,
  px: (to - from) * pxPerSec,
});

const [TEAM, SETTLE] = FLOWS;

/**
 * The lean story scrolls more slowly than the others, so each scene has time to be seen: pixels of scroll per second of
 * timeline, and the same for the problem scene (two bars filling).
 */
const LEAN_PX = 340;
const PROBLEM_PX = 240;

const PIECES: Record<Variant, Piece[]> = {
  full: [scrub(STORY_START, STORY_T, SCROLL_PX)],
  flows: [
    scrub(STORY_START, TEAM.enter),
    scrub(TEAM.enter, TEAM.start),
    { kind: "play", flow: TEAM.id, px: DWELL_PX },
    { kind: "out", flow: TEAM.id, to: TEAM.out, px: (TEAM.out - TEAM.end) * BASE_PX },
    scrub(SETTLE.enter, SETTLE.start),
    { kind: "play", flow: SETTLE.id, px: DWELL_PX },
    { kind: "out", flow: SETTLE.id, to: SETTLE.out, px: (SETTLE.out - SETTLE.end) * BASE_PX },
    scrub(SETTLE.out, STORY_T),
  ],
  // The time jumps between pieces: 16 s to 54.8 s skips how-it-works and the team, 82 s to 96.8 s skips the
  // integrations and credentials. Each scene on either side of a jump has faded out (or not yet faded in) there.
  lean: [
    scrub(STORY_START, 6.8, LEAN_PX),
    scrub(6.8, 16, PROBLEM_PX),
    scrub(SETTLE.enter - 0.2, SETTLE.start, LEAN_PX),
    { kind: "play", flow: SETTLE.id, px: DWELL_PX },
    { kind: "out", flow: SETTLE.id, to: SETTLE.out, px: (SETTLE.out - SETTLE.end) * LEAN_PX },
    scrub(96.8, STORY_T, LEAN_PX),
  ],
};

/** The variant a visitor asked for: `?story=full` or `?story=flows`; anything else is the lean story. */
export function storyVariant(search: string): Variant {
  const asked = new URLSearchParams(search).get("story");
  return asked === "full" ? "full" : asked === "flows" ? "flows" : "lean";
}

export function variantTrack(variant: Variant): Track {
  return buildTrack(STORY_START, PIECES[variant]);
}

/** Where each nav link lands on the page, in pixels from the start of the story. */
export function anchorPx(track: Track, variant: Variant, [, t, flow]: Anchor): number {
  return variant !== "full" && flow ? track.flowSpan(flow).from : track.px(t);
}

/** Resting points and free stretches as 0 to 1 progress through the story, for scroll snapping. */
export function snapPlan(variant: Variant, track: Track): { stops: number[]; free: [number, number][] } {
  if (variant === "full") return { stops: FULL_STOPS.map((t) => track.px(t) / track.total), free: [] };
  const stops = (variant === "lean" ? LEAN_STOPS : FLOWS_STOPS).map((t) => track.px(t));
  const free: [number, number][] = [];
  for (const f of flowsFor(variant)) {
    const { from, to } = track.flowSpan(f.id);
    stops.push(from, to);
    free.push([from / track.total, to / track.total]);
  }
  return { stops: [...new Set(stops)].sort((a, b) => a - b).map((x) => x / track.total), free };
}
