import { encodeFunctionData, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { permissionedResolverAbi } from "./abi/permissionedResolver.ts";
import { permissionedRegistryAbi } from "./abi/permissionedRegistry.ts";
import { MAINNET } from "./deployments.ts";
import { dnsName } from "./dns.ts";
import { checkLedgerRecord } from "./ledger-snapshot.ts";
import { readTextRecord } from "./resolver-read.ts";

export const LEDGER_KEY = "mergit.ledger";

/**
 * Writes the `mergit.ledger` record to `mergit.eth` on the resolver with the publisher account (which holds that one key).
 * Validates the record first, fails if the resolver has no code or is not the one `mergit.eth` points at, sends nothing if the record is already there, and with
 * `dryRun` only reports whether a write would happen. A failed ENS read throws: it is never taken to mean "not set".
 */
export async function publishLedgerRecord(
  ctx: { ens: PublicClient; wallet: WalletClient }, resolver: Address, record: string, opts: { dryRun?: boolean } = {},
): Promise<{ changed: boolean; hash: Hex | null }> {
  checkLedgerRecord(record);
  const code = await ctx.ens.getCode({ address: resolver });
  if (!code || code === "0x") throw new Error(`ledger: no contract code at resolver ${resolver}`);
  const pointedAt = (await ctx.ens.readContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "getResolver", args: ["mergit"] })) as Address;
  if (pointedAt.toLowerCase() !== resolver.toLowerCase()) throw new Error(`ledger: mergit.eth does not point at resolver ${resolver} (it points at ${pointedAt}); check "resolver" in the writer config`);
  const current = await readTextRecord(ctx.ens, resolver, "mergit.eth", LEDGER_KEY);
  if (current === record) return { changed: false, hash: null };
  if (opts.dryRun) return { changed: true, hash: null };
  const hash = await ctx.wallet.writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "setText", args: [dnsName("mergit.eth"), LEDGER_KEY, record] } as never);
  const receipt = await ctx.ens.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`ledger: transaction ${hash} reverted`);
  return { changed: true, hash };
}
