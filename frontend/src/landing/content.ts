/*
 * Landing page copy and demo data. Text follows the landing design video,
 * with the protocol terms updated to the current paper: an unnamed Ethereum
 * L2 testnet (not Monad), ERC-8004 identities (not soulbound passports), and
 * value density (not a reputation score). Every number is illustrative.
 */
import type { AgentKind } from "../mock/data";

export const CHAIN = "L2 testnet";
export const FIRST_BLOCK = 18_431_195;

export const nav = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Agents", href: "#agents" },
  { label: "Integrations", href: "#integrations" },
  { label: "Proofs", href: "#proofs" },
];

export const intro = {
  eyebrow: "Mergit · verified receipts for AI agents",
  lead: "Every agent action, ",
  accent: "settled on chain.",
  hashes: ["0x91bd…77a2", "0x5e02…c3f8", "0x3a7c…e010"],
};

export const hero = {
  eyebrow: "Outcomes, not just outputs",
  title: ["AI", "agents", "that", "do", "real", "work.", "Proof", "you", "can", "verify."],
  /** Indexes of the title words that get the green highlight. */
  highlight: [4, 5],
  lede: "One sentence becomes a fix in GitHub, a ticket in Linear and a reply in the thread that asked. Every finished task settles on chain.",
  notes: ["Built for real workflows.", `Proofs on an ${CHAIN}.`],
  handwriting: ["From", "intent", "to", "verified", "action"],
  tools: ["GitHub", "Linear", "Slack"],
};

export const agentDemo = {
  prompt: "“Fix the authentication bug and reply here with the PR.”",
  steps: [
    {
      icon: "github",
      title: "PR #134 · Fix auth flow",
      detail: "47 tests passed · 6 / 6 proofs",
      badge: "Merged",
      tone: "green",
    },
    { icon: "linear", title: "Linear · Issue updated", detail: "Auth bug resolved", badge: "Closed", tone: "purple" },
    {
      icon: "thread",
      title: "Thread · Reply posted",
      detail: "Fix is live. Let me know if you need anything else.",
      badge: "Replied",
      tone: "green",
    },
  ],
  done: "Completed · 6 proofs settled",
} as const;

export const howItWorks = {
  eyebrow: "01 / How it works",
  title: "One request. A complete loop.",
  lede: "From the thread where work starts to the proof that it finished. No lost context between the two.",
  steps: [
    {
      icon: "message",
      title: "Describe the outcome",
      body: "Start with what needs to change. Mergit turns the request and its context into a task graph.",
      chip: "“Fix the authentication bug.”",
    },
    {
      icon: "route",
      title: "Watch the work unfold",
      body: "Specialists research, code and test in parallel. Follow each handoff in the graph and live logs.",
      chip: "Research → Code → QA → Review",
    },
    {
      icon: "shield",
      title: "Approve the risky writes",
      body: "Review the proposed action before an agent opens a PR or posts back to your workspace.",
      chip: "You decide what gets written.",
    },
    {
      icon: "fingerprint",
      title: "Verify the finished work",
      body: "Artifacts become receipts. Hashes settle on chain so the work can be checked, not just claimed.",
      chip: "Artifact → hash → settled proof",
    },
  ],
} as const;

export const team = {
  eyebrow: "02 / The team",
  title: "Specialists, not a single black box.",
  lede: "Six focused roles. One coordinated run. Every agent has a clear job, visible tools and an accountable handoff.",
  agents: [
    {
      kind: "Planner",
      name: "Planner",
      body: "Turns an outcome into a task graph. Routes each step to the right specialist.",
      delivers: "Task graph + dependencies",
      id: "#0412",
      density: "4.6",
    },
    {
      kind: "Research",
      name: "Research",
      body: "Reads the thread, repository and docs to find the cause before work begins.",
      delivers: "Findings + source context",
      id: "#0413",
      density: "4.8",
    },
    {
      kind: "Coder",
      name: "Code",
      body: "Fixes bugs and ships changes. Passes the patch forward with its tests.",
      delivers: "Code changes + regression test",
      id: "#0414",
      density: "4.9",
    },
    {
      kind: "Tester",
      name: "QA",
      body: "Runs tests, checks the result and gives the team evidence, not a guess.",
      delivers: "Test results + validation",
      id: "#0415",
      density: "4.7",
    },
    {
      kind: "Reviewer",
      name: "Review",
      body: "Reviews every diff before a PR opens. Flags the changes that need attention.",
      delivers: "Diff review + approval request",
      id: "#0416",
      density: "4.4",
    },
    {
      kind: "Proof",
      name: "Docs",
      body: "Writes incident notes and release summaries so the next person has context.",
      delivers: "Incident note + thread reply",
      id: "#0417",
      density: "4.3",
    },
  ] satisfies { kind: AgentKind; name: string; body: string; delivers: string; id: string; density: string }[],
};

export const connected = {
  eyebrow: "03 / Connected work",
  title: "Works where your work already lives.",
  lede: "Bring the context in. Put the result back. Mergit connects the tools across your workflow, not another inbox to manage.",
  apps: [
    {
      mark: "GH",
      app: "GitHub",
      title: "Ship the fix",
      body: "Read repositories, commit on branches and open pull requests.",
      trace: "PR #134 · Fix auth flow",
    },
    {
      mark: "SL",
      app: "Slack",
      title: "Close the loop",
      body: "Read the thread where a bug is reported and reply with the result.",
      trace: "#backend · Reply with PR link",
    },
    {
      mark: "LN",
      app: "Linear",
      title: "Move work forward",
      body: "Create issues, update their state and comment with the outcome.",
      trace: "Authentication bug · Resolved",
    },
    {
      mark: "NO",
      app: "Notion",
      title: "Leave the context",
      body: "Write an incident note that explains the cause and the fix.",
      trace: "Incident note · Auth redirect",
    },
  ],
};

export const approval = {
  eyebrow: "04 / Human in the loop",
  title: "Autonomy with a clear stop sign.",
  lede: "Let agents do the legwork. Keep the consequential decisions. Mergit asks before risky writes, with the context you need to make the call.",
  points: [
    "See the proposed action and its target",
    "Inspect the diff and test results",
    "Approve or deny before anything is written",
  ],
  tool: "github.open_pull_request",
  action: "Open PR “Fix authentication bug”",
  target: "acme/billing · fix/session-refresh → main",
  tags: ["47 tests passed", "Review completed"],
  signed: "Signed by 0x6E2d…9A0b · tx 0x41c9…e2a7",
  denied: "Denied · nothing was written",
  asks: ["Opening a pull request", "Posting in Slack"],
};

export const credentials = {
  eyebrow: "05 / Credential boundary",
  /** Broken onto three lines, as in the design. */
  title: ["Your credentials are not", "model", "context."],
  lede: "Credentials are sealed per user and never reach a model. Agents use connected tools without seeing the keys behind them.",
  sealed: "Sealed per user",
  tools: "Connected tools",
  scope: "Scoped actions",
  note: "Model receives task context. Never credentials.",
};

export const proofOfWork = {
  eyebrow: "06 / Verified receipts",
  title: ["“Done” is a receipt,", "not a promise."],
  lede: `Every finished task produces a verifiable work receipt. Match the artifact to its hash, then follow its settlement on an ${CHAIN}.`,
  receipt: {
    title: "PR #134, fix authentication bug",
    badge: "Hashes match",
    hashLabel: "Artifact hash / SHA-256",
    hash: "0x8f2e7a91c04d5be36f1a…4b91",
    hashNote: "Example hash · Compare with the canonical artifact",
    facts: [
      ["Artifact", "src/auth/session.ts + regression test"],
      ["Validation", "47 tests passed"],
      ["Network", `Ethereum ${CHAIN}`],
      ["Settlement", "6 of 6 proofs settled"],
    ],
    steps: ["Task done", "Hashed", "Queued", "Confirmed"],
  },
  identity: {
    badge: "ERC-8004 identity",
    title: "A track record earned through work.",
    body: "Each agent carries an ERC-8004 identity. Its value density moves only when audited receipts settle, never when an agent says it succeeded.",
    label: "Audited receipt → value density",
    detail: "Persistent identity. Non-transferable. Verifiable history.",
  },
};

export const faq = {
  eyebrow: "07 / Questions, answered",
  title: "A little more clarity.",
  lede: "What happens between your request and the receipt.",
  items: [
    {
      q: "What can I ask Mergit to do?",
      a: "Describe an outcome in your connected workflow: fix a bug, investigate an issue or write an incident note. Mergit plans the steps and coordinates the specialists.",
    },
    {
      q: "Can agents write without my approval?",
      a: "Mergit asks for approval before risky writes. Review the proposed action, its target and the supporting evidence, then approve or deny it.",
    },
    {
      q: "What does a work proof verify?",
      a: "A receipt links the finished task to its artifacts through hashes and a settlement record. You can compare the artifact with its hash.",
    },
    {
      q: "Where do the proofs settle?",
      a: "On an Ethereum L2 testnet. The specific L2 is not chosen yet, and the examples on this page show testnet settlement, not mainnet availability.",
    },
  ],
};

export const cta = {
  eyebrow: "08 / Your agents, accountable",
  title: ["Give your next outcome a", "team. And a receipt."],
  lede: "Follow the authentication fix from the first request to PR #134 and its settled proofs. See what accountable agents look like.",
  note: `${CHAIN} · Labeled product examples`,
};

export const footer = {
  tagline: "Real work. Verifiable proof.",
  columns: [
    {
      title: "Explore",
      links: [
        ["How it works", "#how-it-works"],
        ["Agents", "#agents"],
        ["Integrations", "#integrations"],
      ],
    },
    {
      title: "Understand",
      links: [
        ["Receipts", "#proofs"],
        ["Security", "#security"],
        ["FAQ", "#faq"],
      ],
    },
  ],
  settle: `Proof settlement on an ${CHAIN}`,
};
