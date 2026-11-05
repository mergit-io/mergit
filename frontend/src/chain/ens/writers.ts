import { getAddress, namehash, parseAbiItem, type Address, type Hex } from "viem";

export type RecordWriter = { account: Address; txHash: Hex; blockNumber: bigint } | null;

/** The resolver's `TextUpdated`: the record id and the key hash are indexed, so both can be filtered on. */
export const textUpdatedEvent = parseAbiItem(
  "event TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value)",
);

const getRecordIdAbi = [
  {
    type: "function",
    name: "getRecordId",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export type WriterReads = {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getLogs(args: {
    address: Address;
    event: typeof textUpdatedEvent;
    args: { recordId: bigint; keyHash: string };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly unknown[]>;
  getTransaction(args: { hash: Hex }): Promise<{ from: Address }>;
};

type Seen = { blockNumber: bigint; logIndex: number; transactionHash: Hex };
const asSeen = (raw: unknown): Seen => {
  const l = raw as Partial<Seen> | null;
  if (
    !l ||
    typeof l.blockNumber !== "bigint" ||
    typeof l.logIndex !== "number" ||
    typeof l.transactionHash !== "string"
  ) {
    throw new Error("malformed log");
  }
  return { blockNumber: l.blockNumber, logIndex: l.logIndex, transactionHash: l.transactionHash };
};

/**
 * Which account last wrote each record of `name`, read from the resolver's `TextUpdated` logs inside `window` (public
 * RPCs limit how many blocks one query may span, so the caller chooses a window). A key with no event in the window
 * is `null`: the answer is "not known", never a guess. The writer is the sender of the transaction, not the resolver.
 */
export async function findRecordWriters(
  c: WriterReads,
  resolver: Address,
  name: string,
  keys: string[],
  window: { fromBlock: bigint; toBlock: bigint },
): Promise<Record<string, RecordWriter>> {
  try {
    const recordId = (await c.readContract({
      address: resolver,
      abi: getRecordIdAbi,
      functionName: "getRecordId",
      args: [namehash(name)],
    })) as bigint;
    const entries = await Promise.all(
      keys.map(async (key): Promise<[string, RecordWriter]> => {
        const logs = (
          await c.getLogs({ address: resolver, event: textUpdatedEvent, args: { recordId, keyHash: key }, ...window })
        ).map(asSeen);
        const last = logs.reduce<Seen | null>(
          (best, l) =>
            best === null ||
            l.blockNumber > best.blockNumber ||
            (l.blockNumber === best.blockNumber && l.logIndex > best.logIndex)
              ? l
              : best,
          null,
        );
        if (last === null) return [key, null];
        const tx = await c.getTransaction({ hash: last.transactionHash });
        return [key, { account: getAddress(tx.from), txHash: last.transactionHash, blockNumber: last.blockNumber }];
      }),
    );
    return Object.fromEntries(entries);
  } catch (cause) {
    throw new Error("The record writers could not be read.", { cause });
  }
}
