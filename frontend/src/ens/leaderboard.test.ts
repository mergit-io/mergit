import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../api/types";
import type { AgentEns } from "../chain/ens/agentEns.ts";
import type { Mirror } from "../chain/ens/mirror.ts";
import type { AgentEnsState } from "../chain/useAgentEns";
import { boardCategories, boardRows, categoryLabel } from "./leaderboard";

const agents: AgentInfo[] = ["a", "b", "c", "d"].map((n, i) => ({
  agent_id: String(i + 1),
  name: `coder-${n}`,
  model: "m",
}));

const mirror = (verified: number, audited: number, byCategory: Mirror["byCategory"] = []): Mirror => ({
  asOfBlock: 100,
  verifiedStaked: verified,
  auditedStaked: audited,
  byCategory,
  note: "",
});

const state = (badge: AgentEns["badge"], m: AgentEns["mirror"]): AgentEnsState => ({
  state: "ready",
  value: {
    name: "x.mergit.eth",
    agentId: 1n,
    parentOwner: null,
    resolver: null,
    records: { context: null, endpointWeb: null, registration: null },
    verification:
      badge === "not-verified" ? { status: "failed", reason: "name-mismatch", detail: "" } : { status: "verified" },
    operator: { state: "current", onBase: null, onEns: null },
    mirror: m,
    badge,
    unreadable: [],
  },
});
const ok = (m: Mirror, badge: AgentEns["badge"] = "verified") => state(badge, { status: "ok", mirror: m });

describe("boardRows", () => {
  it("orders by verified count, then audited count, then name", () => {
    const states = { 1: ok(mirror(2, 5)), 2: ok(mirror(4, 4)), 3: ok(mirror(2, 6)), 4: ok(mirror(2, 5)) };
    expect(boardRows(agents, states, null).map((r) => r.name)).toEqual(["coder-b", "coder-c", "coder-a", "coder-d"]);
  });

  it("does not count the mirror of a name whose two-way check failed", () => {
    expect(boardRows(agents, { 1: ok(mirror(99, 99), "not-verified") }, null)).toEqual([]);
  });

  it("counts a link that holds with the owner unconfirmed or changed", () => {
    const states = { 1: ok(mirror(1, 1), "unconfirmed"), 2: ok(mirror(1, 1), "owner-changed") };
    expect(boardRows(agents, states, null)).toHaveLength(2);
  });

  it("skips absent, unavailable and malformed mirrors, errors and unanswered agents without failing", () => {
    const states: Record<string, AgentEnsState> = {
      1: state("verified", { status: "absent" }),
      2: state("verified", { status: "malformed", detail: "x" }),
      3: { state: "error", message: "offline" },
      4: { state: "loading" },
    };
    expect(boardRows(agents, states, null)).toEqual([]);
  });

  it("uses per-category counts when a category is chosen, and leaves out agents with none in it", () => {
    const states = {
      1: ok(mirror(5, 5, [{ category: "bugfix", verifiedStaked: 1, auditedStaked: 2 }])),
      2: ok(mirror(3, 3, [{ category: "refactor", verifiedStaked: 3, auditedStaked: 3 }])),
    };
    const rows = boardRows(agents, states, "bugfix");
    expect(rows.map((r) => r.counts)).toEqual([{ verifiedStaked: 1, auditedStaked: 2 }]);
    expect(boardCategories(states)).toEqual(["bugfix", "refactor"]);
  });

  it("keeps an agent that is not on the platform roster off the board", () => {
    expect(boardRows([], { 1: ok(mirror(1, 1)) }, null)).toEqual([]);
  });

  it("shortens a category that is only a hash", () => {
    expect(categoryLabel(`0x${"ab".repeat(32)}`)).toBe("0xabababab…");
    expect(categoryLabel("bugfix")).toBe("bugfix");
  });
});
