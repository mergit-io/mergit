import { useEffect, useState } from "react";
import { LIVE } from "../config/live";
import type { AgentEns } from "./ens/agentEns.ts";
import { agentRegistrationKey } from "./ens/ensip25.ts";
import { findRecordWriters, type RecordWriter, type WriterReads } from "./ens/writers.ts";
import { mainnetClient } from "./liveEns";

export type Writers =
  { state: "loading" } | { state: "unavailable" } | { state: "ready"; byKey: Record<string, RecordWriter> };

/** The record keys an agent's profile lists, in the order it shows them. */
export function recordKeys(agentId: bigint): string[] {
  return [
    agentRegistrationKey(LIVE.contracts.identity, LIVE.chainId, agentId),
    "agent-context",
    "agent-endpoint[web]",
    "mergit.operator",
    "mergit.reputation",
  ];
}

async function readWriters(ens: AgentEns): Promise<Record<string, RecordWriter>> {
  if (!ens.resolver) throw new Error("no resolver");
  if (LIVE.ens.reader === "stub") {
    const { stubWriterReads } = await import("./ens/stubClients.ts");
    return findRecordWriters(stubWriterReads(), ens.resolver, ens.name, recordKeys(ens.agentId), {
      fromBlock: 0n,
      toBlock: 1n,
    });
  }
  const client = mainnetClient();
  const reads: WriterReads = {
    readContract: (args) => client.readContract(args),
    getLogs: (args) => client.getLogs(args),
    getTransaction: (args) => client.getTransaction(args),
  };
  const toBlock = await client.getBlockNumber();
  const fromBlock = toBlock > LIVE.ens.writerBlocks ? toBlock - LIVE.ens.writerBlocks : 0n;
  return findRecordWriters(reads, ens.resolver, ens.name, recordKeys(ens.agentId), { fromBlock, toBlock });
}

/**
 * Who last wrote each of an agent's records, from the resolver's logs in the last `LIVE.ens.writerBlocks` blocks (best
 * effort, HLD 6.2). A record written before that window has a `null` writer: shown as unknown, never guessed.
 */
export function useRecordWriters(ens: AgentEns | null): Writers {
  const key = ens ? `${ens.name}:${String(ens.agentId)}:${ens.resolver ?? ""}` : null;
  const [result, setResult] = useState<{ key: string; writers: Writers } | null>(null);
  useEffect(() => {
    if (!ens || key === null) return;
    let active = true;
    readWriters(ens).then(
      (byKey) => {
        if (active) setResult({ key, writers: { state: "ready", byKey } });
      },
      () => {
        if (active) setResult({ key, writers: { state: "unavailable" } });
      },
    );
    return () => {
      active = false;
    };
    // the key carries everything the read depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (key === null) return { state: "unavailable" };
  return result?.key === key ? result.writers : { state: "loading" };
}
