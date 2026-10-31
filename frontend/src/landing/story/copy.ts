/*
 * Copy for the scroll story. Every line comes from the repo (README, brand kit,
 * landing content). Product examples are labelled as such; no number is measured.
 */
export const storyCopy = {
  hero: {
    eyebrow: "Mergit · verified receipts for AI agents",
    title: "Pay for what",
    accent: "you got.",
    lede: ["Agent platforms bill you for the attempt.", "Mergit settles on the outcome, verified."],
  },
  problem: {
    eyebrow: "The problem",
    title: ["Billed for the attempt.", "Settled on the outcome."],
    today: "Agent platforms today",
    meters: ["Tokens", "Tool calls", "Sandbox minutes"],
    notMetered: "Not metered",
    chip: "Settles on the outcome",
  },
  how: {
    eyebrow: "01 / How it works",
    title: ["One request.", "A complete loop."],
    steps: [
      ["Describe the outcome", "“Fix the authentication bug.”"],
      ["Watch the work unfold", "Research → Code → QA → Review"],
      ["Approve the risky writes", "You decide what gets written."],
      ["Verify the finished work", "Artifact → hash → settled proof"],
    ],
  },
  team: {
    rail: ["Plan", "Dispatch", "Approve", "Verify", "Identity"],
    stat: ["6 specialists", "1 run"],
    side: ["Start free", "Trial credits pay for your first runs, with no wallet needed."],
    steps: [
      ["Turns an outcome into a task graph.", "Routes each step to the right specialist."],
      ["Specialists, not a single black box.", "Research, code and test in parallel. Every handoff visible."],
      ["Autonomy with a clear stop sign.", "Mergit asks before risky writes. You approve or deny."],
      ["Artifacts become receipts.", "Hashes settle on chain so the work can be checked, not just claimed."],
      ["A track record earned through work.", "Each agent carries an ERC-8004 identity. Non-transferable."],
    ],
  },
  settle: {
    rail: ["Fund", "Work", "Check", "Pay", "Refund"],
    stat: ["Attempt", "Outcome"],
    side: ["Pay for what you got", "Nothing is paid until you approve and fund the plan."],
    chips: {
      held: "Held in escrow",
      receipt: "Signed receipt",
      checked: "Checked",
      paid: "Paid",
      refunded: "Refunded",
    },
    steps: [
      ["You fund. It waits.", "Nothing is paid until you approve and fund the plan. The money is held in escrow."],
      ["Agents do the work.", "Every step they take is recorded in a signed receipt."],
      ["The work gets checked.", "An audit checks the receipt before any money moves."],
      ["Proven, then paid.", "Escrow releases to the agent and the proof settles on Ethereum."],
      ["Not proven? Not paid.", "If a challenge shows the work was wrong, you get refunded."],
    ],
  },
  apps: {
    eyebrow: "02 / Connected work",
    title: ["Works where your", "work already lives."],
    list: [
      ["GitHub", "Ship the fix"],
      ["Slack", "Close the loop"],
      ["Linear", "Move work forward"],
      ["Notion", "Leave the context"],
    ],
  },
  cred: {
    eyebrow: "03 / Credential boundary",
    title: ["Your credentials are", "not model context."],
    note: "Model receives task context. Never credentials.",
  },
  closer: {
    eyebrow: "Your agents, accountable",
    title: ["Give your next", "outcome a team."],
    accent: "And a receipt.",
    lede: "Hire AI agents and pay only for work that is proven done.",
    note: "Proof settlement on an L2 testnet · Test funds only: nothing here is real money.",
  },
} as const;
