import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { fetchOutcomes, type LogClient } from "../src/outcome-source.ts";
import { impersonate, startFork } from "./fork.ts";

const ANCHOR = getAddress("0xf9DBfF75887361A67269765DA6F8732b233Fda76");
const VALIDATOR = getAddress("0xb41263A86d0EB428Dd1895f7110060Da7EC89F55"); // holds RECORDER_ROLE on Base Sepolia
const CAT = keccak256(toHex("test-repair"));
const t = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

const logAt = (blockNumber: bigint, logIndex: number, over: Record<string, unknown> = {}) => ({
  blockNumber, logIndex,
  args: { taskId: t(Number(blockNumber)), agentId: 2n, category: CAT, success: true, costMicros: 10n, tier: 0, source: 0, ...over },
});

function stubClient(logs: ReturnType<typeof logAt>[], failOnCall?: number) {
  const calls: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client: LogClient = {
    async getLogs({ fromBlock, toBlock }) {
      calls.push({ fromBlock, toBlock });
      if (failOnCall === calls.length) throw new Error("boom");
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  return { client, calls };
}

test("a 1,000-block range is fetched in five non-overlapping chunks of at most 200 blocks that cover it exactly", async () => {
  const { client, calls } = stubClient([]);
  await fetchOutcomes(client, ANCHOR, 1000n, 1999n);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map((c) => [c.fromBlock, c.toBlock]), [[1000n, 1199n], [1200n, 1399n], [1400n, 1599n], [1600n, 1799n], [1800n, 1999n]]);
});

test("the chunk size is configurable and a short final chunk is handled", async () => {
  const { client, calls } = stubClient([]);
  await fetchOutcomes(client, ANCHOR, 10n, 25n, { chunk: 10n });
  assert.deepEqual(calls.map((c) => [c.fromBlock, c.toBlock]), [[10n, 19n], [20n, 25n]]);
});

test("outcomes from every chunk come back decoded and ordered by block then log index", async () => {
  const { client } = stubClient([logAt(1500n, 3), logAt(1010n, 1), logAt(1010n, 0, { success: false }), logAt(1900n, 0)]);
  const out = await fetchOutcomes(client, ANCHOR, 1000n, 1999n);
  assert.deepEqual(out.map((o) => [o.blockNumber, o.logIndex]), [[1010n, 0], [1010n, 1], [1500n, 3], [1900n, 0]]);
  assert.equal(out[0].success, false);
  assert.equal(out[1].agentId, 2n);
  assert.equal(out[1].category, CAT);
  assert.equal(out[1].tier, 0);
  assert.equal(out[1].source, 0);
});

test("a failing chunk rejects the whole call and names the block range", async () => {
  const { client } = stubClient([logAt(1010n, 0)], 3);
  await assert.rejects(fetchOutcomes(client, ANCHOR, 1000n, 1999n), /outcomes: logs for blocks 1400-1599 failed: boom/);
});

test("an empty range returns nothing and asks the client nothing", async () => {
  const { client, calls } = stubClient([]);
  assert.deepEqual(await fetchOutcomes(client, ANCHOR, 500n, 499n), []);
  assert.equal(calls.length, 0);
});

test("a malformed log rejects instead of being skipped", async () => {
  const bad = logAt(1010n, 0, { agentId: undefined });
  const { client } = stubClient([bad]);
  await assert.rejects(fetchOutcomes(client, ANCHOR, 1000n, 1199n), /malformed/i);
});

const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
test("on a Base Sepolia fork, an outcome recorded by the validator is fetched and decoded", { skip }, async () => {
  const fork = await startFork({ upstream: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org", chain: baseSepolia });
  after(() => fork.stop());
  await impersonate(fork, VALIDATOR);
  const forkBlock = await fork.pub.getBlockNumber({ cacheTime: 0 });
  const recordAbi = parseAbi(["function record(bytes32 taskId, uint256 agentId, bytes32 category, bool success, uint256 costMicros, uint8 tier, uint8 source)"]);
  const hash = await fork.wallet(VALIDATOR).writeContract({ address: ANCHOR, abi: recordAbi, functionName: "record", args: [t(77), 1n, CAT, true, 1000n, 0, 0] } as never);
  assert.equal((await fork.pub.waitForTransactionReceipt({ hash })).status, "success");
  const head = await fork.pub.getBlockNumber({ cacheTime: 0 });
  const out = await fetchOutcomes(fork.pub as unknown as LogClient, ANCHOR, forkBlock, head);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].taskId, out[0].agentId, out[0].category, out[0].success, out[0].tier, out[0].source], [t(77), 1n, CAT, true, 0, 0]);
});
