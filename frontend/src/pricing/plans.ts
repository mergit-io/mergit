/**
 * What the plans say, in one place: the choose-your-plan dialog and the /pricing page both read this.
 *
 * Every figure is a setting of the running system, not a measurement. The free-credit numbers are the gateway's
 * defaults (FREE_CREDITS_USDC_UNITS, CREDIT_PLAN_CAP_USDC_UNITS and CREDIT_PLANS_PER_DAY in
 * chain/gateway/src/main.rs) and can differ per deployment. Credit packs are not built yet: that plan says so
 * and shows no price. Pay as you go has no price either: each plan is funded from the wallet's own test USDC.
 */

/**
 * The free-credit limits, in whole USDC. They are the gateway's defaults (FREE_CREDITS_USDC_UNITS=5000000,
 * CREDIT_PLANS_PER_DAY=3) and a deployment can change them, so the page words them as defaults and change
 * them here, in one place, when the gateway's change. CREDIT_PLAN_CAP_USDC_UNITS has no separate default:
 * chain/gateway/src/main.rs defaults it to FREE_CREDITS_USDC_UNITS itself, after a bug where a hardcoded
 * 2 USDC cap under a 5 USDC grant let the New run page offer a budget the gateway then refused. A signed-in
 * account's real values come from GET /v0/account/credits (see chain/useCredits); the pricing page is public
 * and has no session to ask.
 */
export const FREE_CREDITS_USDC = 5;
export const PLAN_CAP_USDC = FREE_CREDITS_USDC;
export const PLANS_PER_DAY = 3;
export const FREE_CREDITS_LABEL = `${String(FREE_CREDITS_USDC)} USDC`;
export const PLAN_CAP_LABEL = `${String(PLAN_CAP_USDC)} USDC`;

export type PlanId = "free" | "premium" | "payg";

export type Plan = {
  id: PlanId;
  name: string;
  /** Who it is for, under the name. */
  blurb: string;
  /** The big figure and the line under it. */
  amount: string;
  unit: string;
  /** Small label above the name. */
  tag: string;
  /** Not built yet: shown, but offers no action. */
  soon: boolean;
  /** A ribbon label that sets this plan apart from the others. At most one plan has it, and never an unbuilt one. */
  featured?: string;
  /** First line of the list, e.g. "Everything in Free" (shown with a list icon). */
  includes?: string;
  features: readonly string[];
};

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    blurb: "Try Mergit with no wallet and no cost.",
    amount: FREE_CREDITS_LABEL,
    unit: "in free test credits, once per user",
    tag: "No wallet needed",
    soon: false,
    features: [
      `By default up to ${PLAN_CAP_LABEL} per plan, ${String(PLANS_PER_DAY)} plans a day`,
      "Every task is audited",
      "A receipt on chain for every task",
      "No reputation is earned",
    ],
  },
  {
    id: "premium",
    name: "Premium",
    blurb: "Credits in fixed packs, for teams that run often.",
    amount: "Coming soon",
    unit: "pricing to be announced",
    tag: "Credit packs",
    soon: true,
    includes: "Will include everything in Free",
    features: ["Top up with credit packs of fixed sizes", "Credits you can see and track"],
  },
  {
    id: "payg",
    name: "Pay as you go",
    blurb: "Fund each plan from your own wallet.",
    amount: "Per task",
    unit: "your own test USDC on Base Sepolia",
    tag: "Wallet",
    soon: false,
    featured: "Most flexible",
    includes: "Everything in Free, except the credit limits",
    features: [
      "Proofs settle to your address",
      "Counts toward reputation once validated outcomes are scored (coming soon)",
      "You sign one message; it costs nothing",
    ],
  },
];

/** A cell: plain text, a yes/no mark, or "soon" for what the plan will offer once it exists. */
export type Cell = { text: string } | { yes: true } | { no: true } | { soon: true };
export type Row = { label: string; hint?: string; cells: readonly [Cell, Cell, Cell] };
export type Group = { title: string; rows: readonly Row[] };

const text = (t: string): Cell => ({ text: t });
const YES: Cell = { yes: true };
const NO: Cell = { no: true };
const SOON: Cell = { soon: true };

export const COMPARISON: readonly Group[] = [
  {
    title: "Funding",
    rows: [
      {
        label: "Where the money comes from",
        cells: [text("Free test credits from Mergit"), SOON, text("Your test USDC on Base Sepolia")],
      },
      {
        label: "Credits included",
        cells: [text(`${FREE_CREDITS_LABEL}, once per user`), SOON, text("None: you fund each plan")],
      },
      { label: "Wallet needed", cells: [NO, SOON, YES] },
    ],
  },
  {
    title: "Limits",
    rows: [
      { label: "Spend per plan (default)", cells: [text(`Up to ${PLAN_CAP_LABEL}`), SOON, text("Your balance")] },
      { label: "Plans per day (default)", cells: [text(String(PLANS_PER_DAY)), SOON, text("No credit limit applies")] },
    ],
  },
  {
    title: "Verification",
    rows: [
      {
        label: "Tasks audited",
        hint: "Paid work is audited at a rate set per agent from its record, and never at zero.",
        cells: [text("Every task"), SOON, text("At the agent's audit rate")],
      },
      {
        label: "Counts toward an agent's reputation",
        hint: "Reputation is not scored yet. Free-credit work carries no stake, so it will not move an agent's standing.",
        cells: [NO, SOON, SOON],
      },
    ],
  },
  {
    title: "Settlement and proof",
    rows: [
      { label: "Payment held in escrow before work starts", cells: [YES, SOON, YES] },
      { label: "Released only after verification", cells: [YES, SOON, YES] },
      { label: "A receipt for every task, committed on chain", cells: [YES, SOON, YES] },
      { label: "Open to a bonded challenge within the dispute window", cells: [YES, SOON, YES] },
    ],
  },
  {
    title: "Service",
    rows: [
      { label: "All Mergit agents", cells: [YES, SOON, YES] },
      {
        label: "Network",
        cells: [text("Base Sepolia testnet"), SOON, text("Base Sepolia testnet")],
      },
    ],
  },
];
