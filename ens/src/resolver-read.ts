import { decodeFunctionResult, encodeFunctionData, namehash, parseAbi, type Address } from "viem";
import { permissionedResolverAbi } from "./abi/permissionedResolver.ts";
import { dnsName } from "./dns.ts";

const textAbi = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);

/** True for an error that is a contract revert (anywhere in the cause chain), false for transport, rate-limit and decode failures. */
export function isRevert(e: unknown): boolean {
  for (let x: any = e, i = 0; x && i < 8; x = x.cause, i++) {
    if (x.name === "ContractFunctionRevertedError" || /\brevert(ed)?\b/i.test(String(x.message ?? "").slice(0, 400))) return true;
  }
  return false;
}

/**
 * A text record read through the resolver's `resolve`. An unset record reads as `""`: a revert is taken to mean "not set".
 * Any other failure (network, rate limit, no data, bad decode) is thrown, never mistaken for "not set", because callers
 * decide what to write from this value.
 */
export async function readTextRecord(client: { readContract(args: any): Promise<unknown> }, resolver: Address, name: string, key: string): Promise<string> {
  try {
    const raw = await client.readContract({ address: resolver, abi: permissionedResolverAbi, functionName: "resolve",
      args: [dnsName(name), encodeFunctionData({ abi: textAbi, functionName: "text", args: [namehash(name), key] })] });
    return decodeFunctionResult({ abi: textAbi, functionName: "text", data: raw as `0x${string}` });
  } catch (e) {
    if (isRevert(e)) return "";
    throw new Error(`reading ${key} for ${name} failed: ${(e as Error).message.split("\n")[0]}`, { cause: e });
  }
}
