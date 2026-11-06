import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { LIVE } from "../config/live";
import type { EnsClients, EnsConfig } from "./ens/agentEns.ts";
import { fetchJsonSafely } from "./ens/safeFetch.ts";
import { publicClient } from "./client";

let ensClient: PublicClient | undefined;
/** Ethereum mainnet, where the `mergit.eth` names live. Reads go to the configured RPC, never through the wallet. */
export const mainnetClient = (): PublicClient =>
  (ensClient ??= createPublicClient({ chain: mainnet, transport: http(LIVE.ens.rpcUrl) }));

/** The clients the ENS reader uses in the app: mainnet for the names, the existing Base client for Identity, a guarded fetch for the registration file. */
export function liveEnsClients(): EnsClients {
  const ens = mainnetClient();
  return {
    ens: {
      getEnsText: (args) => ens.getEnsText(args),
      readContract: (args) => ens.readContract(args),
    },
    base: { readContract: (args) => publicClient.readContract(args) },
    fetchJson: (url) => fetchJsonSafely(url),
  };
}

export function liveEnsConfig(): EnsConfig {
  return {
    identity: LIVE.contracts.identity,
    chainId: LIVE.chainId,
    universalResolver: LIVE.ens.universalResolver,
    registry: LIVE.ens.registry,
    anchor: LIVE.ens.anchor,
  };
}
