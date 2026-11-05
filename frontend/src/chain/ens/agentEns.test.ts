import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { loadAgentEns, type EnsClients, type EnsConfig } from "./agentEns.ts";
import { agentRegistrationKey } from "./ensip25.ts";

const IDENTITY = "0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6" as Address;
const ANCHOR = "0xf9DBfF75887361A67269765DA6F8732b233Fda76" as Address;
const OWNER = "0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D" as Address;
const RESOLVER = "0x13C6c51B109972043DD487d97961D9f141e846c9" as Address;
const ALICE = "0x040510eE34d76253FCF94abDb65b67358fF5fa94" as Address;
const BOB = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
const CFG: EnsConfig = {
  identity: IDENTITY,
  chainId: 84532,
  universalResolver: "0x06fdd07f007adac667177b46ab2eb9a75132cfd5",
  registry: "0xf60aba43e1f7f3dab1186ff03b561401c9df85e2",
  anchor: ANCHOR,
};
const AGENT = { agentId: 2n, label: "coder-0" };
const NAME = "coder-0.mergit.eth";
const REG_KEY = agentRegistrationKey(IDENTITY, 84532, 2n);
const URI = "https://mergit.site/agents/coder-0.json";
const MIRROR = JSON.stringify({
  v: 0,
  mirror: true,
  source: { chainId: 84532, contract: ANCHOR },
  asOfBlock: 100,
  auditedStaked: 2,
  verifiedStaked: 1,
  byCategory: { "test-repair": { auditedStaked: 2, verifiedStaked: 1 } },
  note: "n",
});
const goodFile = () => ({
  services: [{ name: "ENS", endpoint: NAME }],
  registrations: [{ agentId: 2, agentRegistry: `eip155:84532:${IDENTITY}` }],
});

type Value<T> = T | Error;
type Scenario = {
  texts: Record<string, Value<string | null>>;
  tokenURI: Value<string>;
  operatorOf: Value<Address>;
  owner: Value<Address>;
  resolver: Value<Address>;
  file: Value<unknown>;
};
const base = (): Scenario => ({
  texts: {
    [REG_KEY]: "1",
    "agent-context": "# coder-0",
    "agent-endpoint[web]": "https://mergit.site/agents/coder-0.mergit.eth",
    "mergit.operator": ALICE,
    "mergit.reputation": MIRROR,
  },
  tokenURI: URI,
  operatorOf: ALICE,
  owner: OWNER,
  resolver: RESOLVER,
  file: goodFile(),
});
const revert = (fn: string) =>
  new Error(`The contract function "${fn}" reverted with the following reason: unknown agent`);

function stubs(s: Scenario) {
  const log = { fetched: [] as string[], textKeys: [] as string[] };
  const pick = <T>(v: Value<T>): T => {
    if (v instanceof Error) throw v;
    return v;
  };
  const clients: EnsClients = {
    ens: {
      getEnsText: ({ name, key }) => {
        expect(name).toBe(NAME);
        log.textKeys.push(key);
        return Promise.resolve(pick(s.texts[key] ?? null));
      },
      readContract: ({ functionName }: { functionName: string }) => {
        if (functionName === "findOwner") return Promise.resolve(pick(s.owner));
        if (functionName === "getResolver") return Promise.resolve(pick(s.resolver));
        return Promise.reject(new Error(`unexpected ENS read ${functionName}`));
      },
    },
    base: {
      readContract: ({ functionName }: { functionName: string }) => {
        if (functionName === "tokenURI") return Promise.resolve(pick(s.tokenURI));
        if (functionName === "operatorOf") return Promise.resolve(pick(s.operatorOf));
        return Promise.reject(new Error(`unexpected Base read ${functionName}`));
      },
    },
    fetchJson: (url: string) => {
      log.fetched.push(url);
      return Promise.resolve(pick(s.file));
    },
  };
  return { clients, log };
}
const run = (mutate: (s: Scenario) => void = () => undefined) => {
  const s = base();
  mutate(s);
  const { clients, log } = stubs(s);
  return loadAgentEns(clients, CFG, AGENT).then((value) => ({ value, log }));
};

describe("loadAgentEns", () => {
  it("is verified when both directions agree, and carries everything the page needs", async () => {
    const { value: v } = await run();
    expect(v.verification).toEqual({ status: "verified" });
    expect(v.badge).toBe("verified");
    expect(v.name).toBe(NAME);
    expect(v.agentId).toBe(2n);
    expect(v.parentOwner).toBe(OWNER);
    expect(v.resolver).toBe(RESOLVER);
    expect(v.records).toEqual({
      context: "# coder-0",
      endpointWeb: "https://mergit.site/agents/coder-0.mergit.eth",
      registration: "1",
    });
    expect(v.operator).toEqual({ state: "current", onBase: ALICE, onEns: ALICE });
    expect(v.mirror.status).toBe("ok");
    expect(v.unreadable).toEqual([]);
  });

  it("fails with no-registration-record when the ENSIP-25 record is empty or absent, and never fetches the file then", async () => {
    for (const empty of [null, ""]) {
      const { value, log } = await run((s) => (s.texts[REG_KEY] = empty));
      expect(value.verification).toMatchObject({ status: "failed", reason: "no-registration-record" });
      expect(value.badge).toBe("not-verified");
      expect(log.fetched).toEqual([]);
    }
  });

  it("fails clearly when the registry side is missing: unknown agent, no URI, a URI that is not https", async () => {
    expect((await run((s) => (s.tokenURI = revert("tokenURI")))).value.verification).toMatchObject({
      reason: "unknown-agent",
    });
    expect((await run((s) => (s.tokenURI = ""))).value.verification).toMatchObject({ reason: "no-metadata-uri" });
    for (const uri of [
      "ipfs://abc",
      "http://mergit.site/a.json",
      "data:application/json;base64,e30=",
      "//x.example/a",
      "file:///etc/passwd",
    ]) {
      const { value, log } = await run((s) => (s.tokenURI = uri));
      expect(value.verification, uri).toMatchObject({ status: "failed", reason: "unsupported-uri" });
      expect(log.fetched, uri).toEqual([]);
    }
  });

  it("fails when the registration file cannot be fetched or is not a usable file", async () => {
    const down = await run((s) => (s.file = new Error("The registration file could not be fetched.")));
    expect(down.value.verification).toMatchObject({ status: "failed", reason: "registration-file-unreachable" });
    expect((down.value.verification as { detail: string }).detail).toMatch(/could not be fetched/);
    for (const junk of ["text", 42, null, [], { services: "x" }]) {
      expect((await run((s) => (s.file = junk))).value.verification, JSON.stringify(junk)).toMatchObject({
        reason: "registration-file-invalid",
      });
    }
  });

  it("fails with name-mismatch, naming both names, when the file names another agent's ENS name or none", async () => {
    const other = await run(
      (s) => (s.file = { ...goodFile(), services: [{ name: "ENS", endpoint: "coder-1.mergit.eth" }] }),
    );
    expect(other.value.verification).toMatchObject({ status: "failed", reason: "name-mismatch" });
    const detail = (other.value.verification as { detail: string }).detail;
    expect(detail).toContain("coder-1.mergit.eth");
    expect(detail).toContain(NAME);
    expect((await run((s) => (s.file = { registrations: goodFile().registrations }))).value.verification).toMatchObject(
      { reason: "name-mismatch" },
    );
    expect(
      (await run((s) => (s.file = { ...goodFile(), services: [{ name: "ens", endpoint: "CODER-0.MERGIT.ETH" }] })))
        .value.verification,
    ).toEqual({ status: "verified" });
  });

  it("fails with registration-not-listed when the file lists another agent id or another registry", async () => {
    const wrongId = await run(
      (s) => (s.file = { ...goodFile(), registrations: [{ agentId: 3, agentRegistry: `eip155:84532:${IDENTITY}` }] }),
    );
    expect(wrongId.value.verification).toMatchObject({ status: "failed", reason: "registration-not-listed" });
    const wrongRegistry = await run(
      (s) =>
        (s.file = {
          ...goodFile(),
          registrations: [{ agentId: 2, agentRegistry: "eip155:1:0x0000000000000000000000000000000000000001" }],
        }),
    );
    expect(wrongRegistry.value.verification).toMatchObject({ reason: "registration-not-listed" });
    expect((await run((s) => (s.file = { services: goodFile().services }))).value.verification).toMatchObject({
      reason: "registration-not-listed",
    });
  });

  it("drops the tick when the operator on Base is not the one recorded on ENS (owner changed), even though the two-way check passes", async () => {
    const { value } = await run((s) => (s.operatorOf = BOB));
    expect(value.verification).toEqual({ status: "verified" });
    expect(value.operator).toEqual({ state: "changed", onBase: BOB, onEns: ALICE });
    expect(value.badge).toBe("owner-changed");
  });

  it("compares operators case-insensitively", async () => {
    const { value } = await run((s) => (s.texts["mergit.operator"] = ALICE.toLowerCase()));
    expect(value.operator.state).toBe("current");
    expect(value.badge).toBe("verified");
  });

  it("gives only 'unconfirmed', not the tick, while the operator record is missing: the agent may have been sold before the publisher's first pass", async () => {
    for (const missing of [null, "", "not an address"]) {
      const { value } = await run((s) => (s.texts["mergit.operator"] = missing));
      expect(value.verification).toEqual({ status: "verified" });
      expect(value.operator).toEqual({ state: "unknown", onBase: ALICE, onEns: null });
      expect(value.badge, JSON.stringify(missing)).toBe("unconfirmed");
    }
  });

  it("shows not-verified when the two-way check failed, even if the operator also changed", async () => {
    const { value } = await run((s) => {
      s.operatorOf = BOB;
      s.texts[REG_KEY] = "";
    });
    expect(value.operator.state).toBe("changed");
    expect(value.badge).toBe("not-verified");
  });

  it("never throws and never says verified when a read the check depends on fails", async () => {
    const boom = new Error("HTTP request failed. 429 rate limited");
    const critical: [string, (s: Scenario) => void][] = [
      ["the ENSIP-25 record", (s) => (s.texts[REG_KEY] = boom)],
      ["tokenURI", (s) => (s.tokenURI = boom)],
      ["operatorOf", (s) => (s.operatorOf = boom)],
      ["the operator record", (s) => (s.texts["mergit.operator"] = boom)],
    ];
    for (const [what, mutate] of critical) {
      const { value } = await run(mutate);
      expect(value.verification, what).toMatchObject({ status: "failed", reason: "read-failed" });
      expect((value.verification as { detail: string }).detail, what).toMatch(/429/);
      expect(value.badge, what).toBe("not-verified");
    }
  });

  it("nulls a display field whose read fails, lists it, and keeps an otherwise earned tick", async () => {
    const boom = new Error("network down");
    const cases: [string, (s: Scenario) => void, (v: Awaited<ReturnType<typeof run>>["value"]) => unknown][] = [
      ["context", (s) => (s.texts["agent-context"] = boom), (v) => v.records.context],
      ["endpoint", (s) => (s.texts["agent-endpoint[web]"] = boom), (v) => v.records.endpointWeb],
      ["owner", (s) => (s.owner = boom), (v) => v.parentOwner],
      ["resolver", (s) => (s.resolver = boom), (v) => v.resolver],
    ];
    for (const [what, mutate, field] of cases) {
      const { value } = await run(mutate);
      expect(field(value), what).toBeNull();
      expect(value.unreadable, what).toHaveLength(1);
      expect(value.verification, what).toEqual({ status: "verified" });
    }
    const m = (await run((s) => (s.texts["mergit.reputation"] = boom))).value;
    expect(m.mirror.status).toBe("unavailable");
    expect(m.unreadable).toHaveLength(1);
  });

  it("only returns an endpoint that is a plain https URL", async () => {
    for (const bad of [
      "javascript:alert(1)",
      "http://x.example",
      "/relative",
      "//evil.example",
      "https://x.example/a b",
      "https://user:pw@x.example",
      "data:text/html,x",
      "https://" + "a".repeat(400) + ".example",
    ]) {
      const { value } = await run((s) => (s.texts["agent-endpoint[web]"] = bad));
      expect(value.records.endpointWeb, bad).toBeNull();
    }
    expect(
      (await run((s) => (s.texts["agent-endpoint[web]"] = "https://mergit.site/agents/x?a=1"))).value.records
        .endpointWeb,
    ).toBe("https://mergit.site/agents/x?a=1");
  });

  it("reports an absent or untrustworthy reputation record without failing the agent", async () => {
    expect((await run((s) => (s.texts["mergit.reputation"] = null))).value.mirror).toEqual({ status: "absent" });
    const other = JSON.stringify({
      ...JSON.parse(MIRROR),
      source: { chainId: 84532, contract: "0x0000000000000000000000000000000000000001" },
    });
    const { value } = await run((s) => (s.texts["mergit.reputation"] = other));
    expect(value.mirror.status).toBe("malformed");
    expect(value.verification).toEqual({ status: "verified" });
    expect((await run((s) => (s.texts["mergit.reputation"] = "not json"))).value.mirror.status).toBe("malformed");
  });

  it("treats an invalid label as a programming error, not a data condition", async () => {
    const { clients } = stubs(base());
    await expect(loadAgentEns(clients, CFG, { agentId: 2n, label: "Coder 0" })).rejects.toThrow(/label/i);
  });
});
