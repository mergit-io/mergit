/**
 * What the plans say, in one place: the choose-your-plan dialog and the /pricing page both read this.
 *
 * Every figure is a setting of the running system, not a measurement. The free-credit numbers are the gateway's
 * defaults (FREE_CREDITS_USDC_UNITS, CREDIT_PLAN_CAP_USDC_UNITS and CREDIT_PLANS_PER_DAY in
 * chain/gateway/src/main.rs) and can differ per deployment. Credit packs are not built yet: that plan says so
 * and shows no price. Pay as you go has no price either: each plan is funded from the wallet's own test USDC.
 */
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
    amount: "5 USDC",
    unit: "in free test credits, once per user",
    tag: "No wallet needed",
    soon: false,
    features: [
      "Up to 2 USDC per plan, 3 plans a day",
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
    includes: "Everything in Free",
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
      "Work counts toward an agent's reputation once validated",
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
      { label: "Credits included", cells: [text("5 USDC, once per user"), SOON, text("None: you fund each plan")] },
      { label: "Wallet needed", cells: [NO, SOON, YES] },
    ],
  },
  {
    title: "Limits",
    rows: [
      { label: "Spend per plan", cells: [text("Up to 2 USDC"), SOON, text("Your balance")] },
      { label: "Plans per day", cells: [text("3"), SOON, text("No credit limit applies")] },
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
        hint: "Free-credit work carries no stake, so it cannot move an agent's standing.",
        cells: [NO, SOON, YES],
      },
    ],
  },
  {
    title: "Settlement and proof",
    rows: [
      { label: "Payment held in escrow before work starts", cells: [YES, YES, YES] },
      { label: "Released only after verification", cells: [YES, YES, YES] },
      { label: "A receipt for every task, committed on chain", cells: [YES, YES, YES] },
      { label: "Open to a bonded challenge within the dispute window", cells: [YES, YES, YES] },
    ],
  },
  {
    title: "Service",
    rows: [
      { label: "All Mergit agents", cells: [YES, YES, YES] },
      {
        label: "Network",
        cells: [text("Base Sepolia testnet"), text("Base Sepolia testnet"), text("Base Sepolia testnet")],
      },
    ],
  },
];
