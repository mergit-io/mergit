import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { AgentEns, FailureReason } from "../../chain/ens/agentEns.ts";
import { FAILURE_REASONS, failureText } from "../../chain/ens/identityView.ts";
import { explorerAddressUrl, findAgent, plainText, profileView, shortAddress } from "./profileView";

const IDENTITY = "0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6" as Address;
const ALICE = "0x040510eE34d76253FCF94abDb65b67358fF5fa94" as Address;
const BOB = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
const CTX = { identity: IDENTITY };

function ens(over: Partial<AgentEns> = {}): AgentEns {
  return {
    name: "coder-0.mergit.eth",
    agentId: 2n,
    parentOwner: null,
    resolver: null,
    records: { context: null, endpointWeb: null, registration: "1" },
    verification: { status: "verified" },
    operator: { state: "current", onBase: ALICE, onEns: ALICE },
    mirror: { status: "absent" },
    badge: "verified",
    unreadable: [],
    ...over,
  };
}
const failed = (reason: FailureReason, detail: string): Partial<AgentEns> => ({
  verification: { status: "failed", reason, detail },
  badge: "not-verified",
});

describe("profileView: the check", () => {
  it("explains a verified agent in sentences", () => {
    const v = profileView(ens(), CTX);
    expect(v.title).toBe("coder-0.mergit.eth");
    expect(v.verification.badge).toBe("verified");
    expect(v.verification.sentences.join(" ")).toMatch(/point at each other/);
    expect(v.verification.sentences.join(" ")).toMatch(/still the operator on Base/);
  });

  it.each(FAILURE_REASONS)(
    "gives the sentence for %s, and the raw detail only as a short quoted fragment",
    (reason) => {
      const detail = `first line\nsecond <script>alert(1)</script> ${"x".repeat(300)}`;
      const v = profileView(ens(failed(reason, detail)), CTX);
      expect(v.verification.badge).toBe("not-verified");
      expect(v.verification.sentences[0]).toBe(failureText(reason));
      const quoted = v.verification.sentences.find((s) => s.includes("first line"));
      expect(quoted).toBeDefined();
      const fragment = /"(.*)"/.exec(quoted ?? "")?.[1] ?? "";
      expect(fragment.length).toBeLessThanOrEqual(120);
      expect(fragment).not.toContain("\n");
      expect(v.verification.sentences.join("")).not.toContain("x".repeat(200));
    },
  );

  it("says an owner-changed agent was sold since ENS was last updated, and shows both operators", () => {
    const v = profileView(
      ens({ badge: "owner-changed", operator: { state: "changed", onBase: BOB, onEns: ALICE } }),
      CTX,
    );
    expect(v.verification.sentences.join(" ")).toMatch(/sold since its ENS records were last updated/);
    expect(v.operator).toMatchObject({ onBase: BOB, onEns: ALICE });
    expect(v.operator.sentence).toMatch(/not the one recorded on ENS/);
  });

  it("says an unconfirmed agent's owner record is not on ENS yet", () => {
    const v = profileView(
      ens({ badge: "unconfirmed", operator: { state: "unknown", onBase: ALICE, onEns: null } }),
      CTX,
    );
    expect(v.verification.sentences.join(" ")).toMatch(/owner record is not on ENS yet/);
    expect(v.operator.onEns).toBeNull();
    expect(v.operator.sentence).toMatch(/not recorded on ENS yet/);
  });
});

describe("profileView: records", () => {
  it("keeps the context's line breaks as separate lines of plain text", () => {
    const v = profileView(
      ens({
        records: {
          context: "# coder-0\nFixes tests.\n\n[x](javascript:alert(1)) <b>hi</b>",
          endpointWeb: null,
          registration: "1",
        },
      }),
      CTX,
    );
    expect(v.records.context).toEqual(["# coder-0", "Fixes tests.", "[x](javascript:alert(1)) <b>hi</b>"]);
  });

  it("drops control, zero-width and bidi-override characters from the context", () => {
    const hostile = "a\u0000b\u0007c\td\re​f‏g‮h⁦i⁩j\u001Fk\nl";
    const v = profileView(ens({ records: { context: hostile, endpointWeb: null, registration: "1" } }), CTX);
    expect(v.records.context).toEqual(["abcdefghijk", "l"]);
  });

  it("caps the context at 2,000 characters in total", () => {
    const long = Array.from({ length: 100 }, () => "y".repeat(99)).join("\n");
    const v = profileView(ens({ records: { context: long, endpointWeb: null, registration: "1" } }), CTX);
    const total = v.records.context.join("\n").length;
    expect(total).toBeLessThanOrEqual(2_001);
    expect(v.records.context.at(-1)?.endsWith("…")).toBe(true);
  });

  it("has no context lines when there is no context", () => {
    expect(profileView(ens(), CTX).records.context).toEqual([]);
  });

  it("passes the endpoint through only as the reader returned it, never rebuilding one", () => {
    const url = "https://mergit.site/agents/coder-0.mergit.eth";
    expect(
      profileView(ens({ records: { context: null, endpointWeb: url, registration: "1" } }), CTX).records.endpoint,
    ).toBe(url);
    expect(profileView(ens(), CTX).records.endpoint).toBeNull();
  });

  it("does not link an endpoint that holds an invisible or bidi-override character", () => {
    const lookalike = "https://mergit.site/‮gro.live";
    expect(
      profileView(ens({ records: { context: null, endpointWeb: lookalike, registration: "1" } }), CTX).records.endpoint,
    ).toBeNull();
  });
});

describe("profileView: registry and mirror", () => {
  it("names the registry entry", () => {
    expect(profileView(ens(), CTX).registry).toEqual({ identity: IDENTITY, agentId: "2" });
  });

  it("labels the mirror with its block, as a mirror and not a score, with counts per category", () => {
    const v = profileView(
      ens({
        mirror: {
          status: "ok",
          mirror: {
            asOfBlock: 12345,
            auditedStaked: 3,
            verifiedStaked: 2,
            byCategory: [
              { category: "test-repair", auditedStaked: 2, verifiedStaked: 1 },
              { category: "docs‮", auditedStaked: 1, verifiedStaked: 1 },
            ],
            note: "n​",
          },
        },
      }),
      CTX,
    );
    expect(v.mirror.sentence).toBe("Mirror of audited, staked outcomes read from Base at block 12345, not a score.");
    expect(v.mirror.rows).toEqual([
      { category: "test-repair", audited: 2, verified: 1 },
      { category: "docs", audited: 1, verified: 1 },
    ]);
    expect(v.mirror.note).toBe("n");
  });

  it("does not show a malformed mirror", () => {
    const v = profileView(ens({ mirror: { status: "malformed", detail: "bad" } }), CTX);
    expect(v.mirror.sentence).toMatch(/not shown because it is not valid/);
    expect(v.mirror.rows).toEqual([]);
  });

  it("says when there is no on-chain record yet", () => {
    const v = profileView(ens({ mirror: { status: "absent" } }), CTX);
    expect(v.mirror.sentence).toMatch(/no on-chain record yet/i);
    expect(v.mirror.rows).toEqual([]);
  });

  it("says when the mirror could not be read", () => {
    const v = profileView(ens({ mirror: { status: "unavailable" } }), CTX);
    expect(v.mirror.sentence).toMatch(/could not be read/);
    expect(v.mirror.rows).toEqual([]);
  });
});

describe("helpers", () => {
  it("shortens an address", () => {
    expect(shortAddress(ALICE)).toBe("0x0405…fa94");
  });

  it("builds explorer links only from a plain address and a known explorer", () => {
    expect(explorerAddressUrl("https://etherscan.io", ALICE)).toBe(`https://etherscan.io/address/${ALICE}`);
    expect(explorerAddressUrl(undefined, ALICE)).toBeNull();
    expect(explorerAddressUrl("https://etherscan.io", "javascript:alert(1)")).toBeNull();
    expect(explorerAddressUrl("https://etherscan.io", `${ALICE}/../x`)).toBeNull();
  });

  it("turns text into a single plain line when asked", () => {
    expect(plainText("a\nb​c", { singleLine: true })).toBe("a bc");
  });
});

describe("findAgent", () => {
  const agents = [
    { agent_id: "1", name: "coder-0", model: "m" },
    { agent_id: "2", name: "Writer 1", model: "m" },
    { agent_id: "3", name: "Fixer-2", model: "m" },
    { agent_id: "x", name: "broken", model: "m" },
  ];

  it("finds the agent whose name is the label", () => {
    expect(findAgent(agents, "coder-0")).toEqual({ kind: "found", agent: agents[0], agentId: 1n });
  });

  it("knows an agent whose name is not a label has no ENS name", () => {
    expect(findAgent(agents, "fixer-2")).toEqual({ kind: "no-ens-name", agent: agents[2] });
  });

  it("finds nothing for an unknown name, or an agent with a bad id", () => {
    expect(findAgent(agents, "nobody")).toEqual({ kind: "unknown" });
    expect(findAgent(agents, "broken")).toEqual({ kind: "unknown" });
    expect(findAgent([], "coder-0")).toEqual({ kind: "unknown" });
  });
});
