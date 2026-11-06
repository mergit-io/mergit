import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address } from "viem";
import { estimateCostUsd, readGate } from "../src/gate.ts";

const OWNER = getAddress("0x1725a458a3fc8bb3d7460d262c7f94766fef585d");
const OTHER = getAddress("0x00000000000000000000000000000000000000aa");
const NOW = new Date("2026-11-06T00:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const ZERO = "0x0000000000000000000000000000000000000000";

type Spec = {
  v2Status?: number; // 2 = REGISTERED
  v2Owner?: Address;
  v2Expiry?: number;
  v2ExpiredExpiry?: number; // what the real registry does for a lapsed label: status AVAILABLE, findOwner 0, expiry and latestOwnerOf still set
  v1Owner?: Address | null; // null: BaseRegistrar.ownerOf reverts (no such token)
  v1Expiry?: number;
  wrapperOwner?: Address;
  resolved?: Address | null;
  eth?: Record<string, bigint>;
  usdc?: Record<string, bigint>;
  gasPrice?: bigint;
  feedAnswer?: bigint; // 8 decimals
  feedUpdatedAt?: number;
  failOn?: string; // method name that throws
};

function stub(spec: Spec = {}) {
  const s = { v2Status: 2, v2Owner: OWNER, v2Expiry: NOW_S + 365 * 86400, v1Owner: null, resolved: OWNER, gasPrice: 125_000_000n,
    feedAnswer: 241_600_000_000n, feedUpdatedAt: NOW_S - 600, eth: {}, usdc: {}, ...spec } as Required<Spec>;
  const guard = (m: string) => { if (s.failOn === m) throw new Error(`boom in ${m}`); };
  return {
    async readContract({ functionName, args }: { address: Address; abi: unknown; functionName: string; args?: readonly unknown[] }) {
      guard(functionName);
      switch (functionName) {
        case "getStatus": return s.v2Status;
        case "findOwner": return s.v2Status === 2 ? s.v2Owner : ZERO;
        case "findExpiry": return BigInt(s.v2Status === 2 ? s.v2Expiry : (s.v2ExpiredExpiry ?? 0));
        case "latestOwnerOf": return s.v2Status === 2 || s.v2ExpiredExpiry ? s.v2Owner : ZERO;
        case "getResolver": return OWNER;
        case "ownerOf": if (s.v1Owner === null) throw new Error("execution reverted"); return s.v1Owner;
        case "nameExpires": return BigInt(s.v1Expiry ?? 0);
        case "balanceOf": return s.usdc[String(args?.[0])] ?? 0n;
        case "latestRoundData": return [1n, s.feedAnswer, 0n, BigInt(s.feedUpdatedAt), 1n];
        default: throw new Error(`unexpected read ${functionName}`);
      }
    },
    async getBalance({ address }: { address: Address }) { guard("getBalance"); return s.eth[address] ?? 0n; },
    async getEnsAddress() { guard("getEnsAddress"); return s.resolved; },
    async getGasPrice() { guard("getGasPrice"); return s.gasPrice; },
  };
}

test("estimateCostUsd multiplies gas units, gas price and the ETH price", () => {
  // 350,000 gas * 0.125 gwei = 4.375e-5 ETH; at $2416 that is about $0.1057
  assert.ok(Math.abs(estimateCostUsd(350_000n, 125_000_000n, 2416) - 0.105700) < 1e-6);
});

test("a registered ENSv2 name reports generation v2, owner, expiry and resolved address", async () => {
  const r = await readGate(stub(), "mergit.eth", { now: NOW });
  assert.equal(r.generation, "v2");
  assert.equal(r.owner, OWNER);
  assert.equal(r.resolvedAddress, OWNER);
  assert.equal(r.expiresAt?.toISOString(), new Date((NOW_S + 365 * 86400) * 1000).toISOString());
  assert.equal(r.gasPriceWei, 125_000_000n);
  assert.equal(r.ethUsd.price, 2416);
  assert.equal(r.ethUsd.stale, false);
});

test("zero ETH on the owner is reported as a funding finding", async () => {
  const r = await readGate(stub(), "mergit.eth", { now: NOW });
  assert.equal(r.balances.owner?.ethWei, 0n);
  assert.ok(r.findings.some((f) => /0 ETH/.test(f)), r.findings.join("\n"));
});

test("a name that exists only in ENSv1 reports generation v1 and says so (never a v2 owner)", async () => {
  const r = await readGate(stub({ v2Status: 0, v1Owner: OTHER, v1Expiry: NOW_S + 86400 }), "mergit.eth", { now: NOW });
  assert.equal(r.generation, "v1");
  assert.equal(r.owner, OTHER);
  assert.ok(r.findings.some((f) => /ENSv1/.test(f)), r.findings.join("\n"));
});

test("a name found nowhere reports generation unknown", async () => {
  const r = await readGate(stub({ v2Status: 0, v1Owner: null, resolved: null }), "mergit.eth", { now: NOW });
  assert.equal(r.generation, "unknown");
  assert.equal(r.owner, null);
  assert.ok(r.findings.some((f) => /not found/.test(f)), r.findings.join("\n"));
});

test("a failed read rejects with the name of the read, never a half-filled report", async () => {
  await assert.rejects(readGate(stub({ failOn: "getGasPrice" }), "mergit.eth", { now: NOW }), /gate: gas price failed/);
  await assert.rejects(readGate(stub({ failOn: "latestRoundData" }), "mergit.eth", { now: NOW }), /gate: ETH\/USD feed failed/);
});

test("an expired name is flagged as expired", async () => {
  const r = await readGate(stub({ v2Expiry: NOW_S - 86400 }), "mergit.eth", { now: NOW });
  assert.ok(r.findings.some((f) => /expired/.test(f)), r.findings.join("\n"));
});

test("when the resolved address differs from the owner, both balances are reported separately", async () => {
  const r = await readGate(stub({ resolved: OTHER, eth: { [OWNER]: 5n, [OTHER]: 7n }, usdc: { [OWNER]: 1n, [OTHER]: 2n } }), "mergit.eth", { now: NOW });
  assert.equal(r.balances.owner?.ethWei, 5n);
  assert.equal(r.balances.resolvedAddress?.ethWei, 7n);
  assert.equal(r.balances.owner?.usdc, 1n);
  assert.equal(r.balances.resolvedAddress?.usdc, 2n);
  assert.ok(r.findings.some((f) => /differs/.test(f)), r.findings.join("\n"));
});

test("a stale ETH/USD reading is flagged", async () => {
  const r = await readGate(stub({ feedUpdatedAt: NOW_S - 4 * 3600 }), "mergit.eth", { now: NOW });
  assert.equal(r.ethUsd.stale, true);
  assert.ok(r.findings.some((f) => /stale/.test(f)), r.findings.join("\n"));
});

test("only second-level .eth names are accepted", async () => {
  await assert.rejects(readGate(stub(), "a.mergit.eth", { now: NOW }), /second-level/);
  await assert.rejects(readGate(stub(), "mergit.com", { now: NOW }), /second-level/);
});

test("a lapsed ENSv2 name (registry says AVAILABLE) still reports v2, its last owner and its expiry, not 'not found'", async () => {
  const r = await readGate(stub({ v2Status: 0, v2ExpiredExpiry: NOW_S - 86400 }), "mergit.eth", { now: NOW });
  assert.equal(r.generation, "v2");
  assert.equal(r.owner, OWNER);
  assert.equal(r.expiresAt?.toISOString(), new Date((NOW_S - 86400) * 1000).toISOString());
  assert.ok(r.findings.some((f) => /expired/.test(f)), r.findings.join("\n"));
  assert.ok(!r.findings.some((f) => /not found/.test(f)), r.findings.join("\n"));
});

test("a v1 name inside the 90-day grace period reports its expiry and the grace period (v1 ownerOf reverts when expired)", async () => {
  const r = await readGate(stub({ v2Status: 0, v1Owner: null, v1Expiry: NOW_S - 10 * 86400 }), "mergit.eth", { now: NOW });
  assert.equal(r.generation, "v1");
  assert.equal(r.inGracePeriod, true);
  assert.equal(r.expiresAt?.toISOString(), new Date((NOW_S - 10 * 86400) * 1000).toISOString());
  assert.ok(r.findings.some((f) => /expired/.test(f) && /grace/.test(f)), r.findings.join("\n"));
});

test("a v1 name past the grace period is expired and not in grace", async () => {
  const r = await readGate(stub({ v2Status: 0, v1Owner: null, v1Expiry: NOW_S - 100 * 86400 }), "mergit.eth", { now: NOW });
  assert.equal(r.generation, "v1");
  assert.equal(r.inGracePeriod, false);
  assert.ok(r.findings.some((f) => /expired/.test(f)), r.findings.join("\n"));
});
