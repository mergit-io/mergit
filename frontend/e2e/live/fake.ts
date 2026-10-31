/**
 * A fake browser wallet and fake Mergit backends for live-mode tests. The wallet is injected as
 * window.ethereum; the API, gateway, store and RPC hosts from LIVE_ENV are intercepted.
 */
import type { BrowserContext, Page, Route } from "@playwright/test";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, toFunctionSelector, type Hex } from "viem";
import { LIVE_ENV } from "../../playwright.config";

const receiptRegistryAbi = parseAbi([
  "event ReceiptCommitted(bytes32 indexed taskId, uint256 indexed agentId, bytes32 root, bytes32 terminalHash, bytes32 bodyHash, uint256 costMicros)",
]);

export const ME = getAddress("0x6e2d4a9c51b07f3e9d28c4a16b0e7f2c3d119a0b");
export const OTHER = getAddress("0x1111111111111111111111111111111111111111");
export const RUNTIME_KEY = getAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");

export type Backend = {
  ethWei?: bigint;
  usdcUnits?: bigint;
  credits?: { granted: string; spent: string; remaining: string; plans_today: number };
  commitments?: Array<{ taskId: Hex; agentId: bigint; root: Hex; bodyHash: Hex; costMicros: bigint; block: number }>;
  /** Bundles the store serves, keyed by body hash (the only way the app may fetch them). */
  bundles?: Record<string, string>;
  /**
   * The wallet being linked already has its own account: linking is answered with 409 and an offer to merge (`"plain"`:
   * a 409 with no offer). `POST /v0/auth/merge` then makes the session act as the wallet.
   */
  walletTaken?: { token: string; other: Record<string, unknown> } | "plain";
  /** False: no account uses the wallet, so signing in (not creating an account) with it is refused. */
  walletRegistered?: boolean;
  /** What GET /v0/auth/providers says is set up. Default: none, so only the wallet is offered. */
  providers?: { wallet: boolean; github: boolean; google: boolean; email: boolean };
  /**
   * What GET /v0/auth/me answers: an account (the session cookie after GitHub, Google or an emailed code), `null` for
   * no session (401). Unset, it answers with something that is not an account, so a remembered session is kept.
   */
  me?: Record<string, unknown> | null;
  /** What `me` becomes once the emailed code has been accepted. */
  meAfterEmail?: Record<string, unknown>;
  /** On-chain commitment per task, as `commitmentOf` returns it. */
  committed?: Record<
    string,
    { agentId: bigint; root: Hex; terminalHash: Hex; bodyHash: Hex; costMicros: bigint; phiHash: Hex }
  >;
};

const SELECTOR = {
  commitmentOf: toFunctionSelector("commitmentOf(bytes32)"),
  runtimeKeyOf: toFunctionSelector("runtimeKeyOf(uint256)"),
  operatorOf: toFunctionSelector("operatorOf(uint256)"),
  phiHashOf: toFunctionSelector("phiHashOf(bytes32)"),
};

/**
 * Installs the fake MetaMask before any page script runs, announced the way real wallets are (EIP-6963) and also as
 * `window.ethereum`. `chainId` is what it starts on. `absent` installs no wallet at all. `decoyDefault` makes another
 * wallet own `window.ethereum` (as Coinbase Wallet or Brave Wallet do) while MetaMask still announces itself: the app
 * must use MetaMask, so the decoy refuses every request.
 */
export async function installWallet(
  context: BrowserContext,
  opts: { chainId?: number; absent?: boolean; decoyDefault?: boolean } = {},
) {
  if (opts.absent) return;
  await context.addInitScript(
    ({ me, chainId, decoyDefault }) => {
      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
      const state = {
        accounts: [me] as string[],
        chainId,
        signed: [] as string[],
        sent: [] as Array<{ to: string; data: string }>,
      };
      const emit = (event: string, ...args: unknown[]) => {
        (listeners[event] ?? []).forEach((l) => {
          l(...args);
        });
      };
      const w = window as unknown as Record<string, unknown>;
      w.__fakeWallet = {
        state,
        switchAccount: (a: string) => {
          state.accounts = [a];
          emit("accountsChanged", state.accounts);
        },
      };
      const metamask = {
        isMetaMask: true,
        on: (e: string, l: (...a: unknown[]) => void) => (listeners[e] ??= []).push(l),
        removeListener: (e: string, l: (...a: unknown[]) => void) => {
          listeners[e] = (listeners[e] ?? []).filter((x) => x !== l);
        },
        request: ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
          const answer = (): unknown => {
            switch (method) {
              case "eth_requestAccounts":
              case "eth_accounts":
                return state.accounts;
              case "eth_chainId":
                return `0x${state.chainId.toString(16)}`;
              case "wallet_switchEthereumChain":
                state.chainId = parseInt((params?.[0] as { chainId: string }).chainId, 16);
                emit("chainChanged", `0x${state.chainId.toString(16)}`);
                return null;
              case "personal_sign":
                state.signed.push(typeof params?.[0] === "string" ? params[0] : "");
                return `0x${"11".repeat(65)}`;
              case "eth_sendTransaction": {
                // Every transaction "lands": the fake node answers any receipt with success.
                const tx = params?.[0] as { to: string; data: string };
                state.sent.push({ to: tx.to, data: tx.data });
                return `0x${state.sent.length.toString(16).padStart(64, "0")}`;
              }
              default:
                throw new Error(`fake wallet: unsupported ${method}`);
            }
          };
          try {
            return Promise.resolve(answer());
          } catch (e) {
            return Promise.reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
      };
      w.ethereum = decoyDefault
        ? {
            isMetaMask: true, // some wallets claim this
            isCoinbaseWallet: true,
            on: () => undefined,
            removeListener: () => undefined,
            request: () => Promise.reject(new Error("the wallet that owns window.ethereum must not be used")),
          }
        : metamask;
      const info = { uuid: "fake-metamask", name: "MetaMask", icon: "data:,", rdns: "io.metamask" };
      const announce = () => {
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider: metamask }) }),
        );
      };
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    { me: ME, chainId: opts.chainId ?? 84532, decoyDefault: opts.decoyDefault ?? false },
  );
}

export const CORS = (route: Route) => ({
  "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
  "access-control-allow-credentials": "true",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
});

export function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    headers: { ...CORS(route), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const ZERO: Hex = `0x${"00".repeat(32)}`;
const word = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);

/** Answers JSON-RPC like a tiny Base Sepolia node. */
function rpc(b: Backend) {
  return async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS(route) });
    const req = route.request().postDataJSON() as { id: number; method: string; params: unknown[] };
    const result = (() => {
      switch (req.method) {
        case "eth_chainId":
          return hex(84532);
        case "eth_blockNumber":
          return hex(100);
        case "eth_getBalance":
          return hex(b.ethWei ?? 0n);
        case "eth_getTransactionReceipt": {
          const [hash] = req.params as [Hex];
          return {
            transactionHash: hash,
            transactionIndex: "0x0",
            blockHash: `0x${"cd".repeat(32)}`,
            blockNumber: hex(100),
            from: ME,
            to: LIVE_ENV.VITE_ESCROW,
            cumulativeGasUsed: hex(50_000),
            gasUsed: hex(50_000),
            effectiveGasPrice: hex(1),
            contractAddress: null,
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            status: "0x1",
            type: "0x2",
          };
        }
        case "eth_call": {
          const data = (req.params[0] as { data: string }).data;
          if (data.startsWith("0x70a08231")) return word(b.usdcUnits ?? 0n); // balanceOf
          if (data.startsWith("0xdd62ed3e")) return word(0n); // allowance
          if (data.startsWith(SELECTOR.operatorOf)) return encodeAbiParameters([{ type: "address" }], [OTHER]);
          if (data.startsWith(SELECTOR.runtimeKeyOf)) return encodeAbiParameters([{ type: "address" }], [RUNTIME_KEY]);
          if (data.startsWith(SELECTOR.commitmentOf)) {
            const task = `0x${data.slice(10, 74)}`;
            const c = b.committed?.[task];
            return encodeAbiParameters(
              [
                {
                  type: "tuple",
                  components: [
                    { type: "uint256" },
                    { type: "bytes32" },
                    { type: "bytes32" },
                    { type: "bytes32" },
                    { type: "uint256" },
                    { type: "uint64" },
                  ],
                },
              ],
              [c ? [c.agentId, c.root, c.terminalHash, c.bodyHash, c.costMicros, 1n] : [0n, ZERO, ZERO, ZERO, 0n, 0n]],
            );
          }
          if (data.startsWith(SELECTOR.phiHashOf)) return b.committed?.[`0x${data.slice(10, 74)}`]?.phiHash ?? ZERO;
          return word(0n);
        }
        case "eth_getLogs":
          return (b.commitments ?? []).map((c, i) => ({
            address: LIVE_ENV.VITE_RECEIPT_REGISTRY,
            topics: encodeEventTopics({
              abi: receiptRegistryAbi,
              eventName: "ReceiptCommitted",
              args: { taskId: c.taskId, agentId: c.agentId },
            }),
            data: encodeAbiParameters(
              [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
              [c.root, `0x${"ab".repeat(32)}`, c.bodyHash, c.costMicros],
            ),
            blockNumber: hex(c.block),
            blockHash: `0x${"cd".repeat(32)}`,
            transactionHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
            transactionIndex: "0x0",
            logIndex: hex(i),
            removed: false,
          }));
        default:
          return null;
      }
    })();
    return json(route, { jsonrpc: "2.0", id: req.id, result });
  };
}

/** Paths the store was asked for in the current test. */
export const storeCalls: string[] = [];

/** Intercepts every backend host. Returns the requests the API received, for assertions. */
export async function mockBackend(page: Page, b: Backend = {}) {
  const apiCalls: Array<{ path: string; body: unknown }> = [];
  storeCalls.length = 0;
  await page.route(`${LIVE_ENV.VITE_RPC_URL}/**`, rpc(b));
  await page.route(`${LIVE_ENV.VITE_API_URL}/**`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS(route) });
    const path = new URL(route.request().url()).pathname;
    apiCalls.push({ path, body: route.request().postDataJSON() as unknown });
    if (path === "/v0/auth/nonce") return json(route, { nonce: "a1b2c3d4e5f6a7b8" });
    if (path === "/v0/auth/verify") {
      const intent = (route.request().postDataJSON() as { intent?: string } | null)?.intent;
      if (intent === "login" && b.walletRegistered === false) return json(route, { detail: "no_account" }, 404);
      return json(route, { address: ME });
    }
    if (path === "/v0/auth/providers")
      return json(route, b.providers ?? { wallet: true, github: false, google: false, email: false });
    if (path === "/v0/auth/me") {
      if (b.me === null) return json(route, { detail: "not signed in" }, 401);
      return json(route, b.me ?? {});
    }
    if (path === "/v0/auth/email/start") return route.fulfill({ status: 204, headers: CORS(route) });
    if (path === "/v0/auth/email/verify") {
      if (b.meAfterEmail) b.me = b.meAfterEmail;
      const address = b.meAfterEmail?.["address"];
      return json(route, { address: typeof address === "string" ? address : ME });
    }
    if (path === "/v0/wallet-interest") return route.fulfill({ status: 204, headers: CORS(route) });
    if (path === "/v0/account/trial") {
      const started_at = "2026-10-30T10:00:00+00:00";
      b.me = { ...b.me, trial: { started_at } };
      return json(route, { started_at });
    }
    if (path === "/v0/auth/wallet/link" && b.walletTaken !== undefined) {
      const taken = b.walletTaken;
      if (taken === "plain") return json(route, { detail: "that wallet belongs to another account" }, 409);
      return json(route, { detail: { code: "wallet_taken", merge_token: taken.token, other: taken.other } }, 409);
    }
    if (path === "/v0/auth/merge") {
      b.me = { ...b.me, address: ME.toLowerCase(), wallets: [ME.toLowerCase()] };
      return json(route, { address: ME.toLowerCase() });
    }
    if (path === "/v0/auth/wallet/link") {
      b.me = { ...b.me, address: ME.toLowerCase(), wallets: [ME.toLowerCase()] };
      return json(route, { address: ME.toLowerCase() });
    }
    return json(route, {});
  });
  await page.route(`${LIVE_ENV.VITE_GATEWAY_URL}/**`, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS(route) });
    if (new URL(route.request().url()).pathname === "/v0/commitments") {
      // The gateway's index of ReceiptCommitted events, newest first.
      const rows = [...(b.commitments ?? [])]
        .sort((x, y) => y.block - x.block)
        .map((c, i) => ({
          task_id: c.taskId,
          agent_id: c.agentId.toString(),
          root: c.root,
          body_hash: c.bodyHash,
          cost_micros: c.costMicros.toString(),
          block: c.block,
          tx: `0x${(i + 1).toString(16).padStart(64, "0")}`,
        }));
      return json(route, rows);
    }
    return json(route, {
      granted_usdc_units: b.credits?.granted ?? "5000000",
      spent_usdc_units: b.credits?.spent ?? "0",
      remaining_usdc_units: b.credits?.remaining ?? "5000000",
      plans_today: b.credits?.plans_today ?? 0,
    });
  });
  await page.route(`${LIVE_ENV.VITE_STORE_URL}/**`, (route) => {
    storeCalls.push(new URL(route.request().url()).pathname);
    const parts = new URL(route.request().url()).pathname.split("/");
    // Only /v0/bundles/{bodyHash} serves bundles; the squattable /v0/tasks/{id}/bundle route serves nothing here.
    const body = parts[2] === "bundles" ? b.bundles?.[parts[3] ?? ""] : undefined;
    return body
      ? route.fulfill({ status: 200, headers: { ...CORS(route), "content-type": "application/json" }, body })
      : json(route, { error: "NOT_FOUND" }, 404);
  });
  return apiCalls;
}
