import { getAddress, keccak256, namehash, toHex, type Address } from "viem";
import { MAINNET } from "./deployments.ts";
import { permissionedRegistryAbi } from "./abi/permissionedRegistry.ts";

const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const CHAINLINK_ETH_USD = getAddress("0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419");
const BASE_REGISTRAR_V1 = getAddress("0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85");
const NAME_WRAPPER_V1 = getAddress("0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401");
const ZERO = "0x0000000000000000000000000000000000000000";
const STALE_AFTER_S = 3 * 3600;
const V1_GRACE_S = 90 * 86400;

const erc20Abi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const feedAbi = [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
  outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }] as const;
const baseRegistrarAbi = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "nameExpires", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;
const wrapperAbi = [{ type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }] as const;

/** The slice of viem's public client that readGate uses, so a test can pass a stub. */
export type GateClient = {
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getBalance(args: { address: Address }): Promise<bigint>;
  getEnsAddress(args: { name: string; universalResolverAddress: Address }): Promise<Address | null>;
  getGasPrice(): Promise<bigint>;
};

type Balances = { ethWei: bigint; usdc: bigint };
export type GateReport = {
  name: string;
  generation: "v2" | "v1" | "unknown";
  resolvedAddress: Address | null;
  owner: Address | null;
  expiresAt: Date | null;
  inGracePeriod: boolean | null;
  balances: { resolvedAddress: Balances | null; owner: Balances | null };
  gasPriceWei: bigint;
  ethUsd: { price: number; updatedAt: Date; stale: boolean };
  findings: string[];
};

export function estimateCostUsd(gasUnits: bigint, gasPriceWei: bigint, ethUsd: number): number {
  return (Number(gasUnits * gasPriceWei) / 1e18) * ethUsd;
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    throw new Error(`gate: ${label} failed: ${(cause as Error).message}`, { cause });
  }
}

const isRevert = (e: unknown) => /revert/i.test((e as Error).message ?? "");
const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function readGate(client: GateClient, name: string, opts: { now?: Date } = {}): Promise<GateReport> {
  const now = opts.now ?? new Date();
  const m = /^([a-z0-9-]+)\.eth$/.exec(name);
  if (!m) throw new Error(`gate: only second-level .eth names are supported (got "${name}")`);
  const label = m[1];
  const labelId = BigInt(keccak256(toHex(label)));
  const findings: string[] = [];

  let generation: GateReport["generation"] = "unknown";
  let owner: Address | null = null;
  let expiresAt: Date | null = null;
  let inGracePeriod: boolean | null = null;

  const reg = (functionName: string, args: readonly unknown[]) =>
    client.readContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName, args });

  const v2Status = Number(await step("v2 registry status", () => reg("getStatus", [labelId])));
  const v2Owner = async (): Promise<Address | null> => {
    const o = (await step("v2 latest owner", () => reg("latestOwnerOf", [labelId]))) as Address;
    return o === ZERO ? null : getAddress(o);
  };
  if (v2Status === 2) {
    generation = "v2";
    const o = (await step("v2 owner", () => reg("findOwner", [label]))) as Address;
    owner = o === ZERO ? null : getAddress(o);
    expiresAt = new Date(Number((await step("v2 expiry", () => reg("findExpiry", [label]))) as bigint) * 1000);
  } else {
    // A lapsed ENSv2 label reads as status AVAILABLE with findOwner 0, but its expiry and last owner are still stored,
    // and both reads return 0 (no revert) for a label that was never registered.
    const v2Exp = (await step("v2 expiry", () => reg("findExpiry", [label]))) as bigint;
    if (v2Exp > 0n) {
      generation = "v2";
      owner = await v2Owner();
      expiresAt = new Date(Number(v2Exp) * 1000);
      findings.push(`${name} is in ENSv2 but its registration has lapsed (registry status AVAILABLE).`);
    } else {
      // ENSv1: `nameExpires` does not revert for expired names (`ownerOf` does, including inside the grace period), so read it first.
      const v1Exp = (await step("v1 expiry", () => client.readContract({ address: BASE_REGISTRAR_V1, abi: baseRegistrarAbi, functionName: "nameExpires", args: [labelId] }))) as bigint;
      if (v1Exp > 0n) {
        generation = "v1";
        expiresAt = new Date(Number(v1Exp) * 1000);
        inGracePeriod = now > expiresAt && now.getTime() < expiresAt.getTime() + V1_GRACE_S * 1000;
        let v1Owner: Address | null = null;
        try {
          v1Owner = (await client.readContract({ address: BASE_REGISTRAR_V1, abi: baseRegistrarAbi, functionName: "ownerOf", args: [labelId] })) as Address;
        } catch (e) {
          if (!isRevert(e)) throw new Error(`gate: v1 registrar owner failed: ${(e as Error).message}`, { cause: e });
        }
        if (v1Owner && getAddress(v1Owner) === NAME_WRAPPER_V1) {
          v1Owner = (await step("v1 name wrapper owner", () =>
            client.readContract({ address: NAME_WRAPPER_V1, abi: wrapperAbi, functionName: "ownerOf", args: [BigInt(namehash(name))] }))) as Address;
        }
        owner = v1Owner ? getAddress(v1Owner) : null;
        findings.push(`${name} is registered in ENSv1 only. The ENSv2 plan (own resolver, subnames) does not apply until it is migrated.`);
      } else {
        findings.push(`${name} was not found in ENSv1 or ENSv2.`);
      }
    }
  }
  if (expiresAt && expiresAt < now) findings.push(`${name} expired on ${iso(expiresAt)}${inGracePeriod ? " (inside the ENSv1 grace period)" : ""}.`);

  const resolvedRaw = await step("address resolution", () => client.getEnsAddress({ name, universalResolverAddress: MAINNET.universalResolverV2 }));
  const resolvedAddress = resolvedRaw ? getAddress(resolvedRaw) : null;

  const balancesOf = async (who: string, address: Address | null): Promise<Balances | null> => {
    if (!address) return null;
    const ethWei = await step(`ETH balance (${who})`, () => client.getBalance({ address }));
    const usdc = (await step(`USDC balance (${who})`, () => client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }))) as bigint;
    return { ethWei, usdc };
  };
  const balances = { owner: await balancesOf("owner", owner), resolvedAddress: await balancesOf("resolved address", resolvedAddress) };

  if (owner && resolvedAddress && owner !== resolvedAddress) findings.push(`The resolved address ${resolvedAddress} differs from the owner ${owner}; they are reported separately.`);
  if (balances.owner && balances.owner.ethWei === 0n) findings.push("The owner holds 0 ETH: a mainnet write cannot be paid yet.");

  const gasPriceWei = await step("gas price", () => client.getGasPrice());
  const round = (await step("ETH/USD feed", () => client.readContract({ address: CHAINLINK_ETH_USD, abi: feedAbi, functionName: "latestRoundData" }))) as readonly bigint[];
  const updatedAt = new Date(Number(round[3]) * 1000);
  const stale = (now.getTime() - updatedAt.getTime()) / 1000 > STALE_AFTER_S;
  if (stale) findings.push(`The ETH/USD reading is stale (updated ${updatedAt.toISOString()}); do not use it for cost figures.`);

  return { name, generation, resolvedAddress, owner, expiresAt, inGracePeriod, balances, gasPriceWei,
    ethUsd: { price: Number(round[1]) / 1e8, updatedAt, stale }, findings };
}
