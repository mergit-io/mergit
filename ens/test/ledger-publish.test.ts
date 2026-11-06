import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, keccak256, stringToBytes, toHex, type Address } from "viem";
import { permissionedRegistryAbi } from "../src/abi/permissionedRegistry.ts";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { dnsName } from "../src/dns.ts";
import { ledgerRecord, snapshotHash } from "../src/ledger-snapshot.ts";
import { publishLedgerRecord } from "../src/ledger-publish.ts";
import { readTextRecord } from "../src/resolver-read.ts";
import { MAINNET } from "../src/deployments.ts";
import { ACCOUNTS, deployResolver, impersonate, startFork, type Fork } from "./fork.ts";

const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
const IDENTITY = getAddress("0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6");
const ANCHOR = getAddress("0xf9DBfF75887361A67269765DA6F8732b233Fda76");
const OWNER = getAddress("0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D");
let ens: Fork, resolver: Address;
const record = (n: number) => ledgerRecord({ chainId: 84532, anchor: ANCHOR, identity: IDENTITY, fromBlock: 1n, toBlock: BigInt(n), outcomes: n, agents: 1, hash: snapshotHash(`file ${n}`), uri: `https://mergit.site/ledger/final-${n}.json` });
const read = () => readTextRecord(ens.pub, resolver, "mergit.eth", "mergit.ledger");

before(async () => {
  if (skip) return;
  ens = await startFork();
  resolver = await deployResolver(ens, ACCOUNTS.admin.address);
  await impersonate(ens, OWNER);
  await ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(OWNER).writeContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "setResolver", args: [BigInt(keccak256(toHex("mergit"))), resolver] } as never) });
  const setter = encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsName("ignored.eth"), "mergit.ledger", ""] });
  await ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(ACCOUNTS.admin).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "grantSetterRoles", args: [setter, ACCOUNTS.publisher.address] } as never) });
});
after(async () => { if (ens) await ens.stop(); });

test("a dry run reports a change and sends nothing; the real publish writes the record to mergit.eth and it reads back", { skip }, async () => {
  const wallet = ens.wallet(ACCOUNTS.publisher);
  const before = await ens.pub.getBlockNumber({ cacheTime: 0 });
  const dry = await publishLedgerRecord({ ens: ens.pub, wallet }, resolver, record(5), { dryRun: true });
  assert.deepEqual(dry, { changed: true, hash: null });
  assert.equal(await ens.pub.getBlockNumber({ cacheTime: 0 }), before, "a dry run must not send a transaction");
  assert.equal(await read(), "");

  const done = await publishLedgerRecord({ ens: ens.pub, wallet }, resolver, record(5));
  assert.equal(done.changed, true);
  assert.ok(done.hash);
  assert.equal(await read(), record(5));
});

test("publishing the same record again sends nothing; a newer record replaces it", { skip }, async () => {
  const wallet = ens.wallet(ACCOUNTS.publisher);
  const before = await ens.pub.getBlockNumber({ cacheTime: 0 });
  assert.deepEqual(await publishLedgerRecord({ ens: ens.pub, wallet }, resolver, record(5)), { changed: false, hash: null });
  assert.equal(await ens.pub.getBlockNumber({ cacheTime: 0 }), before);
  await publishLedgerRecord({ ens: ens.pub, wallet }, resolver, record(9));
  assert.equal(await read(), record(9));
});

test("it refuses an invalid record, a resolver with no code, and an account without the role, before or at the send", { skip }, async () => {
  const wallet = ens.wallet(ACCOUNTS.publisher);
  await assert.rejects(publishLedgerRecord({ ens: ens.pub, wallet }, resolver, '{"v":0}'), /ledger record/i);
  const empty = getAddress("0x" + keccak256(stringToBytes("no code here")).slice(26));
  await assert.rejects(publishLedgerRecord({ ens: ens.pub, wallet }, empty, record(1)), /no contract code/);
  const before = await read();
  await assert.rejects(publishLedgerRecord({ ens: ens.pub, wallet: ens.wallet(ACCOUNTS.alice) }, resolver, record(11)), /EACUnauthorizedAccountRoles/);
  assert.equal(await read(), before);
});

test("it refuses a resolver that mergit.eth does not point at (a stale config would pay for a record nobody reads), in a dry run too", { skip }, async () => {
  const wallet = ens.wallet(ACCOUNTS.publisher);
  const before = await ens.pub.getBlockNumber({ cacheTime: 0 });
  const stale = MAINNET.permissionedResolverImpl; // has code, but mergit.eth does not resolve through it
  await assert.rejects(publishLedgerRecord({ ens: ens.pub, wallet }, stale, record(21)), /does not point at/);
  await assert.rejects(publishLedgerRecord({ ens: ens.pub, wallet }, stale, record(21), { dryRun: true }), /does not point at/);
  assert.equal(await ens.pub.getBlockNumber({ cacheTime: 0 }), before, "nothing may be sent");
});
