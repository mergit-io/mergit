import { describe, expect, it } from "vitest";
import type { AgentEns, FailureReason } from "../chain/ens/agentEns.ts";
import type { AgentEnsState } from "../chain/useAgentEns";
import { ensBadgeView } from "./badgeView";

const base: AgentEns = {
  name: "coder-a.mergit.eth",
  agentId: 1n,
  parentOwner: null,
  resolver: null,
  records: { context: null, endpointWeb: null, registration: "1" },
  verification: { status: "verified" },
  operator: { state: "current", onBase: null, onEns: null },
  mirror: { status: "absent" },
  badge: "verified",
  unreadable: [],
};

const ready = (over: Partial<AgentEns>): AgentEnsState => ({ state: "ready", value: { ...base, ...over } });
const failed = (reason: FailureReason): AgentEnsState =>
  ready({ badge: "not-verified", verification: { status: "failed", reason, detail: "x" } });

const REASONS: FailureReason[] = [
  "no-registration-record",
  "unknown-agent",
  "no-metadata-uri",
  "unsupported-uri",
  "registration-file-unreachable",
  "registration-file-invalid",
  "name-mismatch",
  "registration-not-listed",
  "read-failed",
];

const every: AgentEnsState[] = [
  { state: "loading" },
  { state: "none" },
  { state: "error", message: "Could not read the ENS records from Ethereum." },
  ready({}),
  ready({ badge: "unconfirmed" }),
  ready({ badge: "owner-changed" }),
  ...REASONS.map(failed),
];

const isVerified = (s: AgentEnsState) => s.state === "ready" && s.value.badge === "verified";

describe("ensBadgeView", () => {
  it("draws a tick for the read layer's verified badge and for nothing else", () => {
    for (const s of every)
      expect(
        ensBadgeView(s).tick,
        JSON.stringify(s, (_, v: unknown) => (typeof v === "bigint" ? String(v) : v)),
      ).toBe(isVerified(s));
  });

  it("never uses the success colour or the word verified alone unless verified", () => {
    for (const s of every.filter((x) => !isVerified(x))) {
      expect(ensBadgeView(s).className).not.toBe("b-ok");
      expect(ensBadgeView(s).label).not.toBe("Two-way verified");
    }
  });

  it("gives every failure reason its own words", () => {
    const words = REASONS.map((r) => ensBadgeView(failed(r)).reason);
    expect(words.every((w) => typeof w === "string" && w.length > 0)).toBe(true);
    expect(new Set(words).size).toBe(REASONS.length);
  });

  it("draws an unconfirmed link as weaker than a tick, with the reason", () => {
    const v = ensBadgeView(ready({ badge: "unconfirmed" }));
    expect(v.tick).toBe(false);
    expect(v.label).toBe("Linked, owner not confirmed");
    expect(v.reason).toMatch(/sale cannot be ruled out/);
  });

  it("marks an owner change as not verified, with no tick", () => {
    const v = ensBadgeView(ready({ badge: "owner-changed" }));
    expect(v.label).toBe("Owner changed, not verified");
    expect(v.tick).toBe(false);
  });

  it("shows a read error as unavailable, never as a verdict", () => {
    const v = ensBadgeView({ state: "error", message: "offline" });
    expect(v.label).toBe("ENS unavailable");
    expect(v.reason).toBe("offline");
  });
});
