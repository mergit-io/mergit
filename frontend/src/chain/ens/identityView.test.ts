import { describe, expect, expectTypeOf, it } from "vitest";
import type { AgentEns, FailureReason } from "./agentEns.ts";
import { FAILURE_REASONS, failureText, identityView, type AgentEnsState } from "./identityView.ts";

const ALICE = "0x040510eE34d76253FCF94abDb65b67358fF5fa94";
const BOB = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

const BADGES: AgentEns["badge"][] = ["verified", "unconfirmed", "owner-changed", "not-verified"];

function ens(badge: AgentEns["badge"], over: Partial<AgentEns> = {}): AgentEns {
  return {
    name: "coder-0.mergit.eth",
    agentId: 2n,
    parentOwner: null,
    resolver: null,
    records: { context: null, endpointWeb: null, registration: "1" },
    verification:
      badge === "not-verified"
        ? { status: "failed", reason: "name-mismatch", detail: "The file names x.mergit.eth." }
        : { status: "verified" },
    operator: {
      state: badge === "verified" ? "current" : badge === "owner-changed" ? "changed" : "unknown",
      onBase: ALICE,
      onEns: badge === "owner-changed" ? BOB : badge === "verified" ? ALICE : null,
    },
    mirror: { status: "absent" },
    badge,
    unreadable: [],
    ...over,
  };
}
const ready = (value: AgentEns): AgentEnsState => ({ state: "ready", value });

describe("identityView", () => {
  it("gives each badge its own label, and a tick only to verified", () => {
    const views = BADGES.map((b) => identityView(ready(ens(b))));
    expect(views.map((v) => v.label)).toEqual([
      "Verified on ENS",
      "ENS match, owner not confirmed",
      "Owner changed since ENS was updated",
      "Not verified on ENS",
    ]);
    expect(views.map((v) => v.icon)).toEqual(["tick", "clock", "warn", "fail"]);
    expect(views.filter((v) => v.showTick)).toHaveLength(1);
    expect(views[0]?.showTick).toBe(true);
    for (const v of views.slice(1)) {
      expect(v.showTick).toBe(false);
      expect(v.icon).not.toBe("tick");
    }
  });

  it("gives every state a word and a hint, so it is never colour alone", () => {
    for (const b of BADGES) {
      const v = identityView(ready(ens(b)));
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.hint.length).toBeGreaterThan(0);
      expect(v.link).toBe(true);
    }
  });

  it("explains a failed check with the failure's own sentence", () => {
    const v = identityView(ready(ens("not-verified")));
    expect(v.hint).toBe(failureText("name-mismatch"));
    expect(v.tone).toBe("bad");
  });

  it("never shows a tick while loading", () => {
    const v = identityView({ state: "loading" });
    expect(v).toMatchObject({ tone: "none", icon: null, showTick: false });
    expect(v.label.length).toBeGreaterThan(0);
  });

  it("shows an agent without an ENS name as such, with no link", () => {
    const v = identityView({ state: "none" });
    expect(v).toMatchObject({ link: false, label: "No ENS name", showTick: false, icon: null, tone: "none" });
  });

  it("says the records could not be read when the read failed, with no tick", () => {
    const v = identityView({ state: "error", message: "Could not read the ENS records from Ethereum. Try again." });
    expect(v.showTick).toBe(false);
    expect(v.icon).not.toBe("tick");
    expect(v.label).toBe("ENS unavailable");
    expect(v.hint).toBe("Could not read the ENS records from Ethereum. Try again.");
    expect(identityView({ state: "error", message: "" }).hint).toMatch(/could not be read/);
  });

  it("adds what could not be read to the hint but keeps the badge", () => {
    const value = ens("verified", { unreadable: ["the agent's description", "the web endpoint"] });
    const v = identityView(ready(value));
    expect(v.label).toBe("Verified on ENS");
    expect(v.showTick).toBe(true);
    expect(v.hint).toContain("the agent's description, the web endpoint");
  });

  it("never shows a tick for a badge it does not know", () => {
    const v = identityView(ready(ens("verified", { badge: "something-else" as AgentEns["badge"] })));
    expect(v.showTick).toBe(false);
    expect(v.icon).not.toBe("tick");
  });
});

describe("failureText", () => {
  it("lists every failure reason", () => {
    expectTypeOf<(typeof FAILURE_REASONS)[number]>().toEqualTypeOf<FailureReason>();
    expect(new Set(FAILURE_REASONS).size).toBe(FAILURE_REASONS.length);
    expect(FAILURE_REASONS.length).toBe(9);
  });

  it("has a plain, distinct sentence for every reason", () => {
    const sentences = FAILURE_REASONS.map(failureText);
    for (const s of sentences) {
      expect(s.length).toBeGreaterThan(10);
      expect(s).toMatch(/^[A-Z].*\.$/);
    }
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});
