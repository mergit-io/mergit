import { encodeFunctionData, type Address, type Hex } from "viem";
import { permissionedResolverAbi } from "./abi/permissionedResolver.ts";
import { dnsName } from "./dns.ts";
import { agentRegistrationKey } from "./ensip25.ts";
import { ensNameOf, type AgentInput } from "./registration.ts";

export type OneShotAgent = AgentInput & { agentId: number };
export type Chain = { chainId: number; identity: Address };

/** The three records every agent gets (HLD 6.2). `mergit.reputation` is never written here: only the publisher writes it. */
export function agentRecords(agent: OneShotAgent, chain: Chain): { key: string; value: string }[] {
  return [
    { key: agentRegistrationKey(chain.identity, chain.chainId, agent.agentId), value: "1" },
    { key: "agent-context", value: `# ${agent.name}\n\n${agent.description}` },
    { key: "agent-endpoint[web]", value: agent.profileUrl },
  ];
}

/** One encoded `setText` per record, for one batched `multicall`. */
export function recordCalls(agents: OneShotAgent[], chain: Chain): Hex[] {
  if (agents.length === 0) throw new Error("one-shot plan: no agents");
  const labels = new Set<string>();
  const ids = new Set<number>();
  for (const a of agents) {
    ensNameOf(a.label); // throws for a missing or malformed label
    if (!Number.isInteger(a.agentId) || a.agentId <= 0) throw new Error(`one-shot plan: invalid agent id for ${a.label}`);
    if (labels.has(a.label)) throw new Error(`one-shot plan: duplicate label ${a.label}`);
    if (ids.has(a.agentId)) throw new Error(`one-shot plan: duplicate agent id ${a.agentId}`);
    labels.add(a.label);
    ids.add(a.agentId);
  }
  return agents.flatMap((a) => {
    const name = dnsName(ensNameOf(a.label));
    return agentRecords(a, chain).map((r) => encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [name, r.key, r.value] }));
  });
}
