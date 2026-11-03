import type { Address } from "viem";
import { isDemoPath, resolveMode, type DataMode } from "./mode";

/**
 * What this build is: `live` talks to the Mergit services and the chain (set VITE_DATA_MODE=live and the VITE_* values
 * below); `mock` (the default) renders the design over sample data.
 */
const BUILD_MODE: DataMode = import.meta.env.VITE_DATA_MODE === "live" ? "live" : "mock";

const loadedAt = typeof window === "undefined" ? "/" : window.location.pathname;

/** True when this page was loaded at /demo: the same bundle, over sample data, with its own storage and no API. */
export const IN_DEMO = isDemoPath(loadedAt);

/** Fixed for the life of the page: the demo is sample data, everywhere else is what the build is. */
export const DATA_MODE: DataMode = resolveMode(loadedAt, BUILD_MODE);

const env = import.meta.env as Record<string, string | undefined>;

export const LIVE = {
  apiUrl: env.VITE_API_URL ?? "",
  /** The hostname GitHub and Google sign-in runs on (VITE_AUTH_ORIGIN); blank means the API's own. */
  authOrigin: env.VITE_AUTH_ORIGIN ?? "",
  gatewayUrl: env.VITE_GATEWAY_URL ?? "",
  storeUrl: env.VITE_STORE_URL ?? "",
  rpcUrl: env.VITE_RPC_URL ?? "https://sepolia.base.org",
  chainId: Number(env.VITE_CHAIN_ID ?? 84532),
  chainName: env.VITE_CHAIN_NAME ?? "Base Sepolia",
  deployBlock: BigInt(env.VITE_DEPLOY_BLOCK ?? 0),
  contracts: {
    usdc: (env.VITE_USDC ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address,
    escrow: (env.VITE_ESCROW ?? "0x0000000000000000000000000000000000000000") as Address,
    registry: (env.VITE_RECEIPT_REGISTRY ?? "0x0000000000000000000000000000000000000000") as Address,
    identity: (env.VITE_IDENTITY ?? "0x0000000000000000000000000000000000000000") as Address,
  },
  faucets: {
    eth: "https://portal.cdp.coinbase.com/products/faucet",
    usdc: "https://faucet.circle.com",
  },
} as const;
