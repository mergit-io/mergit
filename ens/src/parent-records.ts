import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { permissionedResolverAbi } from "./abi/permissionedResolver.ts";
import { dnsName } from "./dns.ts";

/** Profile texts of `mergit.eth` that are carried over to the new resolver. Never keys the one-shot or the services write themselves. */
export const PARENT_TEXT_KEYS = ["avatar", "description", "url", "name"] as const;
const ETH_COIN_TYPE = 60n;

export type ParentRecords = { address: Address | null; texts: Record<string, string> };
type Reader = {
  getEnsAddress(args: { name: string; universalResolverAddress: Address }): Promise<string | null>;
  getEnsText(args: { name: string; key: string; universalResolverAddress: Address }): Promise<string | null>;
};

/**
 * What `mergit.eth` itself resolves to today. Pointing the name at a new resolver replaces everything it served, so
 * without carrying these over `mergit.eth` would stop resolving to its address (and the owner's primary name with it).
 * A failed read throws: continuing without it would silently lose the records.
 */
export async function readParentRecords(pub: Reader, universalResolverAddress: Address): Promise<ParentRecords> {
  try {
    const addr = await pub.getEnsAddress({ name: "mergit.eth", universalResolverAddress });
    const texts: Record<string, string> = {};
    for (const key of PARENT_TEXT_KEYS) {
      const value = await pub.getEnsText({ name: "mergit.eth", key, universalResolverAddress });
      if (value) texts[key] = value;
    }
    return { address: addr ? getAddress(addr) : null, texts };
  } catch (e) {
    throw new Error(`one-shot: could not read the current records of mergit.eth: ${(e as Error).message.split("\n")[0]}`, { cause: e });
  }
}

/** The calls that write those records to the new resolver (the ETH address as 20 raw bytes, then each text). */
export function parentCalls(p: ParentRecords): Hex[] {
  const name = dnsName("mergit.eth");
  const calls: Hex[] = [];
  if (p.address) {
    calls.push(encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setAddress", args: [name, ETH_COIN_TYPE, p.address.toLowerCase() as Hex] }));
  }
  for (const [key, value] of Object.entries(p.texts)) {
    calls.push(encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [name, key, value] }));
  }
  return calls;
}
