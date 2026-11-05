import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { findRecordWriters, type WriterReads } from "./writers.ts";

const RESOLVER = "0x13C6c51B109972043DD487d97961D9f141e846c9" as Address;
const NAME = "coder-0.mergit.eth";
const PUBLISHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const EDITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const WINDOW = { fromBlock: 100n, toBlock: 200n };

type Log = { key: string; recordId: bigint; blockNumber: bigint; logIndex: number; transactionHash: Hex };
function reads(logs: Log[], senders: Record<Hex, Address>, recordId = 7n) {
  const calls = { getLogs: [] as { recordId: unknown; keyHash: unknown; fromBlock: bigint; toBlock: bigint }[] };
  const c: WriterReads = {
    readContract: vi.fn(() => Promise.resolve(recordId)),
    getLogs: vi.fn((args: { args: { recordId: bigint; keyHash: string }; fromBlock: bigint; toBlock: bigint }) => {
      calls.getLogs.push({
        recordId: args.args.recordId,
        keyHash: args.args.keyHash,
        fromBlock: args.fromBlock,
        toBlock: args.toBlock,
      });
      return Promise.resolve(
        logs.filter(
          (l) =>
            l.recordId === args.args.recordId &&
            l.key === args.args.keyHash &&
            l.blockNumber >= args.fromBlock &&
            l.blockNumber <= args.toBlock,
        ),
      );
    }),
    getTransaction: vi.fn(({ hash: h }: { hash: Hex }) => Promise.resolve({ from: senders[h] as Address })),
  };
  return { c, calls };
}

describe("findRecordWriters", () => {
  it("reports the sender of the transaction that last wrote each key", async () => {
    const { c } = reads(
      [
        { key: "mergit.reputation", recordId: 7n, blockNumber: 110n, logIndex: 0, transactionHash: hash(1) },
        { key: "mergit.reputation", recordId: 7n, blockNumber: 150n, logIndex: 2, transactionHash: hash(2) },
        { key: "agent-endpoint[web]", recordId: 7n, blockNumber: 120n, logIndex: 0, transactionHash: hash(3) },
      ],
      { [hash(1)]: EDITOR, [hash(2)]: PUBLISHER, [hash(3)]: EDITOR },
    );
    const w = await findRecordWriters(c, RESOLVER, NAME, ["mergit.reputation", "agent-endpoint[web]"], WINDOW);
    expect(w["mergit.reputation"]).toEqual({ account: PUBLISHER, txHash: hash(2), blockNumber: 150n });
    expect(w["agent-endpoint[web]"]).toEqual({ account: EDITOR, txHash: hash(3), blockNumber: 120n });
  });

  it("breaks a tie inside one block by log index", async () => {
    const { c } = reads(
      [
        { key: "k", recordId: 7n, blockNumber: 150n, logIndex: 1, transactionHash: hash(1) },
        { key: "k", recordId: 7n, blockNumber: 150n, logIndex: 5, transactionHash: hash(2) },
      ],
      { [hash(1)]: EDITOR, [hash(2)]: PUBLISHER },
    );
    expect((await findRecordWriters(c, RESOLVER, NAME, ["k"], WINDOW))["k"]?.account).toBe(PUBLISHER);
  });

  it("gives null for a key with no event in the window: it never guesses", async () => {
    const { c } = reads(
      [{ key: "mergit.reputation", recordId: 7n, blockNumber: 50n, logIndex: 0, transactionHash: hash(1) }],
      { [hash(1)]: PUBLISHER },
    );
    const w = await findRecordWriters(c, RESOLVER, NAME, ["mergit.reputation", "agent-context"], WINDOW);
    expect(w).toEqual({ "mergit.reputation": null, "agent-context": null });
  });

  it("asks only for this name's record and each key inside the window, and ignores other records' events", async () => {
    const { c, calls } = reads(
      [{ key: "k", recordId: 99n, blockNumber: 150n, logIndex: 0, transactionHash: hash(1) }],
      { [hash(1)]: PUBLISHER },
      7n,
    );
    expect((await findRecordWriters(c, RESOLVER, NAME, ["k"], WINDOW))["k"]).toBeNull();
    expect(calls.getLogs).toEqual([{ recordId: 7n, keyHash: "k", fromBlock: 100n, toBlock: 200n }]);
  });

  it("rejects with a plain message when a read fails", async () => {
    const down: WriterReads = {
      readContract: () => Promise.resolve(7n),
      getLogs: () => Promise.reject(new Error("range too large")),
      getTransaction: () => Promise.resolve({ from: PUBLISHER }),
    };
    await expect(findRecordWriters(down, RESOLVER, NAME, ["k"], WINDOW)).rejects.toThrow(/could not be read/i);
    const noRecord: WriterReads = { ...down, readContract: () => Promise.reject(new Error("reverted")) };
    await expect(findRecordWriters(noRecord, RESOLVER, NAME, ["k"], WINDOW)).rejects.toThrow(/could not be read/i);
  });
});
