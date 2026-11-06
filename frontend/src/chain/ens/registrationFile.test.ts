import { describe, expect, it } from "vitest";
import { parseRegistrationFile } from "./registrationFile.ts";

const REGISTRY = "eip155:84532:0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6";
const file = (over: Record<string, unknown> = {}) => ({
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "coder-0",
  services: [
    { name: "ENS", endpoint: "coder-0.mergit.eth", version: "v1" },
    { name: "web", endpoint: "https://mergit.site/agents/coder-0.mergit.eth" },
  ],
  registrations: [{ agentId: 2, agentRegistry: REGISTRY }],
  ...over,
});

describe("parseRegistrationFile", () => {
  it("reads the ENS endpoint name and the registrations, with agent ids as strings", () => {
    expect(parseRegistrationFile(file())).toEqual({
      ensName: "coder-0.mergit.eth",
      registrations: [{ agentId: "2", agentRegistry: REGISTRY }],
    });
  });

  it("matches the ENS service name case-insensitively and takes the first one", () => {
    const f = file({
      services: [
        { name: "ens", endpoint: "first.mergit.eth" },
        { name: "ENS", endpoint: "second.mergit.eth" },
      ],
    });
    expect(parseRegistrationFile(f).ensName).toBe("first.mergit.eth");
  });

  it("gives null for a missing ENS service and [] for missing registrations", () => {
    expect(parseRegistrationFile({ name: "x" })).toEqual({ ensName: null, registrations: [] });
    expect(
      parseRegistrationFile(file({ services: [{ name: "web", endpoint: "https://x.example" }] })).ensName,
    ).toBeNull();
  });

  it("accepts numeric-string agent ids and skips entries it cannot trust", () => {
    const f = file({
      registrations: [
        { agentId: "7", agentRegistry: REGISTRY },
        { agentId: -1, agentRegistry: REGISTRY },
        { agentId: 1.5, agentRegistry: REGISTRY },
        { agentId: "abc", agentRegistry: REGISTRY },
        { agentId: 3, agentRegistry: 42 },
        { agentId: 4 },
        "nope",
        null,
        42,
      ],
    });
    expect(parseRegistrationFile(f).registrations).toEqual([{ agentId: "7", agentRegistry: REGISTRY }]);
  });

  it("refuses a body that is not an object, or whose lists are not lists", () => {
    for (const bad of [null, "text", 42, [], undefined, true])
      expect(() => parseRegistrationFile(bad), JSON.stringify(bad)).toThrow(/registration file/i);
    expect(() => parseRegistrationFile({ services: "nope" })).toThrow(/services/);
    expect(() => parseRegistrationFile({ registrations: {} })).toThrow(/registrations/);
  });

  it("returns null for an ENS name that is too long or contains whitespace", () => {
    expect(parseRegistrationFile(file({ services: [{ name: "ENS", endpoint: "a".repeat(254) }] })).ensName).toBeNull();
    expect(
      parseRegistrationFile(file({ services: [{ name: "ENS", endpoint: "coder 0.mergit.eth" }] })).ensName,
    ).toBeNull();
    expect(parseRegistrationFile(file({ services: [{ name: "ENS", endpoint: 5 }] })).ensName).toBeNull();
  });

  it("ignores __proto__ and constructor keys: nothing is inherited, nothing is polluted", () => {
    const hostile = JSON.parse(
      '{"__proto__": {"services": [{"name":"ENS","endpoint":"evil.mergit.eth"}]}, "constructor": {"registrations": []}}',
    ) as unknown;
    expect(parseRegistrationFile(hostile)).toEqual({ ensName: null, registrations: [] });
    expect(({} as Record<string, unknown>).services).toBeUndefined();
  });
});
