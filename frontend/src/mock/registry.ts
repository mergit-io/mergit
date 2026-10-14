/*
 * Agent registry and team for the Agents screen, following the dashboard in
 * the landing design video. Terms follow the current paper: agents carry an
 * ERC-8004 identity (not a soulbound passport) and are ranked by value
 * density D (not a star rating). Every number is illustrative.
 */
import type { IconName } from "../components/Icon";
import { CHAIN_LABEL } from "./data";

export const REGISTRY_CATEGORIES = ["All", "Security", "Web3", "Data", "DevOps", "Docs"] as const;
export type RegistryCategory = (typeof REGISTRY_CATEGORIES)[number];

/** Icon and colour per role or registry entry. Tones map to the dashboard's agent tokens. */
export type AgentLook = { icon: IconName; tone: "planner" | "research" | "coder" | "tester" | "reviewer" | "proof" };

export type TeamMember = AgentLook & { name: string; identity: number; density: string; isNew?: boolean };

/** The six specialists every workspace starts with. Identity numbers continue from #0412. */
export const starterTeam: TeamMember[] = [
  { name: "Planner", identity: 412, density: "4.6", icon: "route", tone: "planner" },
  { name: "Research", identity: 413, density: "4.8", icon: "search", tone: "research" },
  { name: "Code", identity: 414, density: "4.9", icon: "code", tone: "coder" },
  { name: "QA", identity: 415, density: "4.7", icon: "checks", tone: "tester" },
  { name: "Review", identity: 416, density: "4.4", icon: "shield", tone: "reviewer" },
  { name: "Docs", identity: 417, density: "4.3", icon: "file", tone: "proof" },
];

/** Two open slots after the starters, as in the design. */
export const TEAM_SLOTS = 8;

type Permission = { label: string; target: string; on: boolean };

export type RegistryAgent = AgentLook & {
  id: string;
  name: string;
  publisher: string;
  version: string;
  category: Exclude<RegistryCategory, "All">;
  /** Shown on the card; the Ops entry files under DevOps for filtering. */
  label: string;
  description: string;
  proofs: string;
  density: string;
  verified: boolean;
  model: string;
  permissions: Permission[];
};

const perm = (label: string, target: string): Permission => ({ label, target, on: false });

export const registry: RegistryAgent[] = [
  {
    id: "security-auditor",
    name: "Security Auditor",
    publisher: "mergit-labs",
    version: "v1.4",
    category: "Security",
    label: "Security",
    description: "Scans every diff for secrets, injection and auth flaws before review.",
    proofs: "2.1k",
    density: "4.9",
    verified: true,
    model: "Claude Sonnet 5",
    icon: "shield",
    tone: "reviewer",
    permissions: [
      perm("Read repositories", "GitHub"),
      perm("Comment on pull requests", "GitHub · ask first"),
      perm("Post findings", "Slack #security"),
    ],
  },
  {
    id: "solidity-auditor",
    name: "Solidity Auditor",
    publisher: "mergit-labs",
    version: "v1.5",
    category: "Web3",
    label: "Web3",
    description: "Audits smart contracts for reentrancy, overflow and access control.",
    proofs: "860",
    density: "4.8",
    verified: true,
    model: "Claude Opus 5.5",
    icon: "cube",
    tone: "coder",
    permissions: [perm("Read repositories", "GitHub"), perm("Comment on pull requests", "GitHub · ask first")],
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    publisher: "mergit-labs",
    version: "v1.6",
    category: "Data",
    label: "Data",
    description: "Queries your warehouse and turns questions into charts and notes.",
    proofs: "1.4k",
    density: "4.7",
    verified: true,
    model: "Claude Sonnet 5",
    icon: "chart",
    tone: "planner",
    permissions: [perm("Read warehouse", "Read-only role"), perm("Write notes", "Notion · Analytics")],
  },
  {
    id: "deploy-agent",
    name: "Deploy Agent",
    publisher: "mergit-labs",
    version: "v1.7",
    category: "DevOps",
    label: "DevOps",
    description: "Ships approved PRs through CI and rolls back on failed health checks.",
    proofs: "3.0k",
    density: "4.9",
    verified: true,
    model: "Claude Sonnet 5",
    icon: "plug",
    tone: "research",
    permissions: [perm("Trigger deploys", "CI · ask first"), perm("Read health checks", "Monitoring")],
  },
  {
    id: "incident-responder",
    name: "Incident Responder",
    publisher: "mergit-labs",
    version: "v1.8",
    category: "DevOps",
    label: "Ops",
    description: "Triages alerts, gathers logs and drafts the first incident update.",
    proofs: "980",
    density: "4.6",
    verified: true,
    model: "Claude Haiku 4.5",
    icon: "message",
    tone: "tester",
    permissions: [perm("Read logs", "Logging"), perm("Post updates", "Slack #incidents · ask first")],
  },
  {
    id: "release-notes",
    name: "Release Notes",
    publisher: "mergit-labs",
    version: "v1.9",
    category: "Docs",
    label: "Docs",
    description: "Writes release notes from merged PRs and posts them to Slack.",
    proofs: "1.7k",
    density: "4.8",
    verified: true,
    model: "Claude Haiku 4.5",
    icon: "notes",
    tone: "proof",
    permissions: [perm("Read merged PRs", "GitHub"), perm("Post notes", "Slack #releases")],
  },
  {
    id: "flaky-test-hunter",
    name: "Flaky Test Hunter",
    publisher: "community",
    version: "v0.3",
    category: "DevOps",
    label: "DevOps",
    description: "Reruns failing suites, isolates flaky tests and opens a quarantine PR.",
    proofs: "140",
    density: "3.9",
    verified: false,
    model: "Llama 3.3 70B",
    icon: "checks",
    tone: "tester",
    permissions: [perm("Run CI jobs", "CI"), perm("Open pull requests", "GitHub · ask first")],
  },
];

export const MODELS = ["Claude Sonnet 5", "Claude Opus 5.5", "Claude Haiku 4.5", "Llama 3.3 70B"];

export const identityNote = `A non-transferable ERC-8004 identity on the ${CHAIN_LABEL}. Value density moves only when audited receipts settle.`;
