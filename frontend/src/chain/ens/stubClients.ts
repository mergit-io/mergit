import type { Address, Hex } from "viem";
import type { EnsClients, EnsConfig } from "./agentEns.ts";
import { agentRegistrationKey } from "./ensip25.ts";
import { PARENT_NAME } from "./names.ts";
import type { WriterReads } from "./writers.ts";

/**
 * Fixed chain answers for the end-to-end tests (VITE_ENS_READER=stub). They stand in for mainnet, Base and the
 * registration file host only: every answer still goes through the real two-way check in `loadAgentEns`, so a test
 * sees exactly the verdict the live app would give for the same chain state. One agent per outcome. Nothing here is
 * real ENS data, and the live site never loads this file.
 */

const OPERATOR: Address = "0x1111111111111111111111111111111111111111";
const BUYER: Address = "0x3333333333333333333333333333333333333333";
const PARENT_OWNER: Address = "0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D";
const RESOLVER: Address = "0x5555555555555555555555555555555555555555";
const PUBLISHER: Address = "0x4444444444444444444444444444444444444444";
const EDITOR: Address = "0x6666666666666666666666666666666666666666";

type Fixture = {
  label: string;
  /** The ENS name the agent's registration file claims (default: its own). */
  fileNames?: string;
  fileUnreachable?: boolean;
  /** The name carries the ENSIP-25 attestation (default true). */
  attested?: boolean;
  /** `mergit.operator` on ENS; null when the publisher has not written it. */
  operatorOnEns?: Address | null;
  operatorOnBase?: Address;
  mirror?: "ok" | "malformed" | "absent";
  /** Every ENS text read fails, as an unreachable mainnet RPC would. */
  ensDown?: boolean;
};

/** By Identity `agentId`. The e2e roster names agent N after its label here. */
export const STUB_AGENTS: Record<string, Fixture> = {
  1: { label: "coder-a" },
  2: { label: "coder-b", operatorOnBase: BUYER },
  3: { label: "coder-c", operatorOnEns: null },
  4: { label: "coder-d", fileNames: `someone-else.${PARENT_NAME}` },
  5: { label: "coder-e", attested: false },
  6: { label: "coder-f", fileUnreachable: true },
  7: { label: "coder-g", mirror: "malformed" },
  8: { label: "coder-h", ensDown: true },
};

const byName = (name: string) =>
  Object.entries(STUB_AGENTS).find(([, f]) => `${f.label}.${PARENT_NAME}` === name.toLowerCase());

function mirrorRecord(cfg: EnsConfig): string {
  return JSON.stringify({
    v: 0,
    mirror: true,
    source: { chainId: cfg.chainId, contract: cfg.anchor },
    asOfBlock: 23_456_789,
    auditedStaked: 5,
    verifiedStaked: 4,
    byCategory: {
      bugfix: { auditedStaked: 3, verifiedStaked: 3 },
      refactor: { auditedStaked: 2, verifiedStaked: 1 },
    },
    note: "Mirror of ReputationAnchor tier 0 outcomes. Not a score. Chain is the source of truth.",
  });
}

const revert = () => Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" });

export function stubEnsClients(cfg: EnsConfig): EnsClients {
  return {
    ens: {
      getEnsText: ({ name, key }) => {
        const hit = byName(name);
        if (!hit) return Promise.resolve("");
        const [id, f] = hit;
        if (f.ensDown) return Promise.reject(new Error("fetch failed: mainnet RPC unreachable"));
        const values: Record<string, string> = {
          [agentRegistrationKey(cfg.identity, cfg.chainId, id)]: f.attested === false ? "" : "1",
          "agent-context": `Mergit agent ${f.label}: fixes failing tests in TypeScript repos.`,
          "agent-endpoint[web]": `https://app.example.test/agents/${f.label}`,
          "mergit.operator": f.operatorOnEns === null ? "" : (f.operatorOnEns ?? OPERATOR),
          "mergit.reputation": f.mirror === "absent" ? "" : f.mirror === "malformed" ? "{not json" : mirrorRecord(cfg),
        };
        return Promise.resolve(values[key] ?? "");
      },
      readContract: ({ functionName }) =>
        Promise.resolve(functionName === "findOwner" ? PARENT_OWNER : functionName === "getResolver" ? RESOLVER : null),
    },
    base: {
      readContract: ({ functionName, args }) => {
        const f = STUB_AGENTS[String(args?.[0])];
        if (!f) return Promise.reject(revert());
        if (functionName === "tokenURI") return Promise.resolve(`https://files.example.test/agents/${f.label}.json`);
        return Promise.resolve(f.operatorOnBase ?? OPERATOR);
      },
    },
    fetchJson: (url) => {
      const hit = Object.entries(STUB_AGENTS).find(([, f]) => url.endsWith(`/${f.label}.json`));
      if (!hit || hit[1].fileUnreachable) return Promise.reject(new Error(`GET ${url}: 404`));
      const [id, f] = hit;
      return Promise.resolve({
        services: [{ name: "ENS", endpoint: f.fileNames ?? `${f.label}.${PARENT_NAME}` }],
        registrations: [{ agentId: Number(id), agentRegistry: `eip155:${String(cfg.chainId)}:${cfg.identity}` }],
      });
    },
  };
}

/** Who wrote each record, as the resolver's logs would say: the admin, the Mergit editor key, or the publisher. */
export function stubWriterReads(): WriterReads {
  const writerOf = (key: string): Address =>
    key.startsWith("mergit.") ? PUBLISHER : key.startsWith("agent-registration") ? PARENT_OWNER : EDITOR;
  const hashes = new Map<Hex, Address>();
  return {
    readContract: () => Promise.resolve(1n),
    getLogs: ({ args }) => {
      const hash: Hex = `0x${(hashes.size + 1).toString(16).padStart(64, "0")}`;
      hashes.set(hash, writerOf(args.keyHash));
      return Promise.resolve([{ blockNumber: 23_456_000n, logIndex: 0, transactionHash: hash }]);
    },
    getTransaction: ({ hash }) => Promise.resolve({ from: hashes.get(hash) ?? PARENT_OWNER }),
  };
}
