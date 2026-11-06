import { describe, expect, it } from "vitest";
import { loadAgentEns, type EnsConfig } from "./agentEns.ts";
import { STUB_AGENTS, stubEnsClients, stubWriterReads } from "./stubClients.ts";
import { findRecordWriters } from "./writers.ts";

const cfg: EnsConfig = {
  identity: "0x00000000000000000000000000000000000000d1",
  chainId: 84532,
  universalResolver: "0x06fdd07f007adac667177b46ab2eb9a75132cfd5",
  registry: "0xf60aba43e1f7f3dab1186ff03b561401c9df85e2",
  anchor: "0xf9DBfF75887361A67269765DA6F8732b233Fda76",
};

const read = (id: string) =>
  loadAgentEns(stubEnsClients(cfg), cfg, { agentId: BigInt(id), label: STUB_AGENTS[id]?.label ?? "" });

/** The e2e tests rely on each fixture producing its outcome through the real two-way check; this pins that. */
describe("the e2e ENS fixtures, through the real reader", () => {
  it.each([
    ["1", "verified", "verified"],
    ["2", "owner-changed", "verified"],
    ["3", "unconfirmed", "verified"],
    ["4", "not-verified", "name-mismatch"],
    ["5", "not-verified", "no-registration-record"],
    ["6", "not-verified", "registration-file-unreachable"],
    ["7", "verified", "verified"],
    ["8", "not-verified", "read-failed"],
  ])("agent %s reads as %s (%s)", async (id, badge, reason) => {
    const got = await read(id);
    expect(got.badge).toBe(badge);
    expect(got.verification.status === "verified" ? "verified" : got.verification.reason).toBe(reason);
  });

  it("gives the verified fixture a parsed mirror and the malformed one a malformed mirror", async () => {
    expect((await read("1")).mirror.status).toBe("ok");
    expect((await read("7")).mirror.status).toBe("malformed");
  });

  it("names a writer for every record key", async () => {
    const writers = await findRecordWriters(
      stubWriterReads(),
      "0x5555555555555555555555555555555555555555",
      "coder-a.mergit.eth",
      ["agent-context", "mergit.reputation"],
      { fromBlock: 0n, toBlock: 1n },
    );
    expect(writers["agent-context"]?.account).toBe("0x6666666666666666666666666666666666666666");
    expect(writers["mergit.reputation"]?.account).toBe("0x4444444444444444444444444444444444444444");
  });
});
