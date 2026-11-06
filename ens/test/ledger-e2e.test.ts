import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
// The web app's ledger reader, loaded straight from the frontend source (plain Node).
import { loadLedger, type LedgerClients, type LedgerConfig } from "../../frontend/src/chain/ens/ledger.ts";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { permissionedRegistryAbi } from "../src/abi/permissionedRegistry.ts";
import { MAINNET } from "../src/deployments.ts";
import { dnsName } from "../src/dns.ts";
import { buildSnapshot, ledgerRecord, snapshotHash } from "../src/ledger-snapshot.ts";
import { publishLedgerRecord } from "../src/ledger-publish.ts";
import { fetchOutcomes, type LogClient } from "../src/outcome-source.ts";
import { ACCOUNTS, deployResolver, impersonate, startFork, type Fork } from "./fork.ts";

// The whole final-ledger pipeline on real forks: Base outcomes -> snapshot file + ENS record -> mainnet ENS -> the web app's reader.
const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
const IDENTITY = getAddress("0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6");
const ANCHOR = getAddress("0xf9DBfF75887361A67269765DA6F8732b233Fda76");
const VALIDATOR = getAddress("0xb41263A86d0EB428Dd1895f7110060Da7EC89F55");
const OWNER = getAddress("0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D");
const CAT = keccak256(toHex("test-repair"));
const URI = "https://mergit.site/ledger/final-test.json";
const identityAbi = parseAbi(["function registerAgent(address runtimeKey, string metadataURI) returns (uint256 agentId)"]);
const recordAbi = parseAbi(["function record(bytes32 taskId, uint256 agentId, bytes32 category, bool success, uint256 costMicros, uint8 tier, uint8 source)"]);

let ens: Fork, base: Fork, resolver: Address, agentId: bigint, fromBlock: bigint, snapshotText: string, record: string;
const files = new Map<string, string>();
const cfg: LedgerConfig = { universalResolver: MAINNET.universalResolverV2, chainId: 84532, anchor: ANCHOR };
let clients: LedgerClients;

before(async () => {
  if (skip) return;
  ens = await startFork();
  base = await startFork({ upstream: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org", chain: baseSepolia });
  await impersonate(base, VALIDATOR);
  await impersonate(ens, OWNER);
  resolver = await deployResolver(ens, ACCOUNTS.admin.address);
  const setter = encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsName("ignored.eth"), "mergit.ledger", ""] });
  await ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(ACCOUNTS.admin).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "grantSetterRoles", args: [setter, ACCOUNTS.publisher.address] } as never) });
  await ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(OWNER).writeContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "setResolver", args: [BigInt(keccak256(toHex("mergit"))), resolver] } as never) });
  clients = { getEnsText: (a) => ens.pub.getEnsText(a), fetchText: async (u) => { const f = files.get(u); if (f === undefined) throw new Error("The ledger file could not be fetched (404)."); return f; } };

  fromBlock = await base.pub.getBlockNumber({ cacheTime: 0 });
  const sim = await base.pub.simulateContract({ address: IDENTITY, abi: identityAbi, functionName: "registerAgent", args: [ACCOUNTS.mergit.address, "https://mergit.site/registrations/coder-0.json"], account: ACCOUNTS.alice } as never);
  agentId = (sim as { result: bigint }).result;
  await base.pub.waitForTransactionReceipt({ hash: await base.wallet(ACCOUNTS.alice).writeContract((sim as { request: never }).request) });
  for (const [n, success, tier] of [[1, true, 0], [2, false, 0], [3, true, 1]] as const) {
    const hash = await base.wallet(VALIDATOR).writeContract({ address: ANCHOR, abi: recordAbi, functionName: "record", args: [`0x${n.toString(16).padStart(64, "0")}` as Hex, agentId, CAT, success, 2500n, tier, 0] } as never);
    await base.pub.waitForTransactionReceipt({ hash });
  }
});
after(async () => { if (ens) await ens.stop(); if (base) await base.stop(); });

test("before anything is published the reader reports an absent ledger", { skip }, async () => {
  assert.deepEqual(await loadLedger(clients, cfg), { status: "absent" });
});

test("the snapshot built from real Base outcomes, committed to mergit.eth by one record, verifies in the web app's reader", { skip }, async () => {
  const toBlock = await base.pub.getBlockNumber({ cacheTime: 0 });
  const outcomes = await fetchOutcomes(base.pub as unknown as LogClient, ANCHOR, fromBlock, toBlock);
  assert.equal(outcomes.length, 3);
  snapshotText = buildSnapshot({
    chain: { id: 84532, identity: IDENTITY, anchor: ANCHOR }, range: { fromBlock, toBlock },
    agents: [{ agentId: Number(agentId), operator: ACCOUNTS.alice.address, metadataUri: "https://mergit.site/registrations/coder-0.json", label: "coder-0" }],
    outcomes, knownCategories: ["test-repair"], createdAt: "2026-11-06T06:00:00.000Z", terms: { disputeWindowSeconds: 600 },
  });
  record = ledgerRecord({ chainId: 84532, anchor: ANCHOR, identity: IDENTITY, fromBlock, toBlock, outcomes: outcomes.length, agents: 1, hash: snapshotHash(snapshotText), uri: URI });
  files.set(URI, snapshotText);

  const r = await publishLedgerRecord({ ens: ens.pub, wallet: ens.wallet(ACCOUNTS.publisher) }, resolver, record);
  assert.equal(r.changed, true);

  const state = await loadLedger(clients, cfg);
  assert.equal(state.status, "ok", JSON.stringify(state).slice(0, 300));
  if (state.status === "ok") {
    assert.equal(state.verified, true);
    assert.equal(state.hash, snapshotHash(snapshotText));
    assert.equal(state.record.hash, snapshotHash(snapshotText));
    assert.equal(state.summary.totals.outcomes, 3, "every recorded outcome is in the file, tier 1 included");
    assert.equal(state.summary.totals.auditedStaked, 2, "only tier 0 counts as audited");
    assert.equal(state.summary.totals.verifiedStaked, 1);
    assert.equal(state.summary.agents[0]?.ensName, "coder-0.mergit.eth");
  }
});

test("a file that was changed after it was committed no longer verifies (hash mismatch), and a missing file is unreachable", { skip }, async () => {
  files.set(URI, snapshotText.replace('"success":false', '"success":true'));
  const tampered = await loadLedger(clients, cfg);
  assert.equal(tampered.status, "mismatch");
  if (tampered.status === "mismatch") assert.equal(tampered.field, "hash");
  files.delete(URI);
  assert.equal((await loadLedger(clients, cfg)).status, "unreachable");
  files.set(URI, snapshotText);
  assert.equal((await loadLedger(clients, cfg)).status, "ok");
});

test("a record that names a different anchor than the app trusts is refused", { skip }, async () => {
  const other = await loadLedger(clients, { ...cfg, anchor: getAddress("0x0000000000000000000000000000000000000001") });
  assert.equal(other.status, "malformed");
});

test("an RPC failure reads as unavailable, never as verified", { skip }, async () => {
  const down: LedgerClients = { ...clients, getEnsText: () => Promise.reject(new Error("HTTP request failed. 429")) };
  assert.deepEqual(await loadLedger(down, cfg), { status: "unavailable" });
});
