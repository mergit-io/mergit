import { encodeFunctionData, keccak256, toHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { MAINNET } from "./deployments.ts";
import { permissionedRegistryAbi } from "./abi/permissionedRegistry.ts";
import { permissionedResolverAbi } from "./abi/permissionedResolver.ts";
import { dnsName } from "./dns.ts";
import { agentRecords, recordCalls, type Chain, type OneShotAgent } from "./oneshot-plan.ts";
import { parentCalls, readParentRecords, type ParentRecords } from "./parent-records.ts";
import { ensNameOf } from "./registration.ts";
import { deployResolverProxy, predictResolverAddress } from "./resolver-deploy.ts";

export type OneShotConfig = { chain: Chain; agents: OneShotAgent[]; publisher: Address; editor: Address; saltNonce?: number };
export type StepResult = { step: string; hash: Hex; gasUsed: bigint };
export type OneShotResult = { resolver: Address; steps: StepResult[]; /** What `mergit.eth` itself resolved to before the switch, carried to the new resolver. */ parent: ParentRecords };

const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;
const MERGIT_LABEL_ID = BigInt(keccak256(toHex("mergit")));
const UR = MAINNET.universalResolverV2;

/** The `setter` argument of grantSetterRoles: an ABI-encoded setText call. Only the key matters; name and value are ignored. */
const setter = (key: string): Hex =>
  encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsName("ignored.eth"), key, ""] });

/**
 * Refuses to run when a planned record already resolves on the current resolver of `mergit.eth`: that means a previous run
 * finished, and running again would point the name at a new, empty resolver and orphan every record on this one,
 * including `mergit.reputation`. Runs before anything is sent.
 */
export async function assertNotAlreadyConfigured(pub: PublicClient, cfg: OneShotConfig): Promise<void> {
  for (const a of cfg.agents) {
    const name = ensNameOf(a.label);
    let got: string | null = null;
    try { got = (await pub.getEnsText({ name, key: "agent-endpoint[web]", universalResolverAddress: UR })) ?? null; } catch { got = null; }
    if (got) {
      throw new Error(`one-shot: ${name} is already configured: agent-endpoint[web] resolves to "${got}" on the current resolver of mergit.eth. `
        + "Running the one-shot again would point mergit.eth at a new, empty resolver and orphan every record on this one, including mergit.reputation. "
        + "To add agents later, write their records to the existing resolver instead (append mode is not built yet; see ens/RUNBOOK.md).");
    }
  }
}

/**
 * The mainnet one-shot, in an order that never leaves `mergit.eth` pointing at an empty resolver:
 * deploy the resolver, grant the two accounts their keys, write all agent records in one multicall, and only then
 * point `mergit.eth` at the resolver. Any failure stops the run and names the step, what was done and the resolver.
 */
export async function runOneShot(ctx: { pub: PublicClient; wallet: WalletClient; owner: Address }, cfg: OneShotConfig): Promise<OneShotResult> {
  const calls = recordCalls(cfg.agents, cfg.chain); // validates the agent list before anything is sent
  await assertNotAlreadyConfigured(ctx.pub, cfg);
  // replacing the resolver replaces everything `mergit.eth` served: read it now, before anything is sent, and carry it over
  const parent = await readParentRecords(ctx.pub as never, UR);
  const steps: StepResult[] = [];
  let resolver: Address | undefined;
  const fail = (name: string, e: unknown): never => {
    throw new Error(`one-shot: step "${name}" failed after [${steps.map((s) => s.step).join(", ") || "nothing"}]${resolver ? ` (resolver ${resolver})` : ""}: ${(e as Error).message}`, { cause: e });
  };
  const send = async (name: string, write: () => Promise<Hex>) => {
    try {
      const hash = await write();
      const receipt = await ctx.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
      steps.push({ step: name, hash, gasUsed: receipt.gasUsed });
    } catch (e) { fail(name, e); }
  };
  const onResolver = (functionName: "grantSetterRoles" | "multicall", args: unknown[]) => () =>
    ctx.wallet.writeContract({ address: resolver!, abi: permissionedResolverAbi, functionName, args } as never);

  // The address is deterministic, so it is known (and reported on any failure) before the deploy transaction is sent,
  // and a rerun after a failed or timed-out deploy reuses the resolver instead of colliding with it.
  const nonce = BigInt(cfg.saltNonce ?? 0);
  try { resolver = await predictResolverAddress(ctx.pub, ctx.owner, nonce); } catch (e) { fail("predict resolver address", e); }
  try {
    const code = await ctx.pub.getCode({ address: resolver! });
    if (code && code !== "0x") {
      steps.push({ step: "reuse resolver (already deployed)", hash: ZERO_HASH, gasUsed: 0n });
    } else {
      const d = await deployResolverProxy(ctx, ctx.owner, nonce);
      if (d.address.toLowerCase() !== resolver!.toLowerCase()) throw new Error(`the factory deployed ${d.address} but ${resolver} was predicted`);
      steps.push({ step: "deploy resolver", hash: d.hash, gasUsed: d.gasUsed });
    }
  } catch (e) { fail("deploy resolver", e); }

  await send("grant publisher mergit.reputation", onResolver("grantSetterRoles", [setter("mergit.reputation"), cfg.publisher]));
  await send("grant publisher mergit.operator", onResolver("grantSetterRoles", [setter("mergit.operator"), cfg.publisher]));
  await send("grant publisher mergit.ledger", onResolver("grantSetterRoles", [setter("mergit.ledger"), cfg.publisher]));
  await send("grant editor agent-context", onResolver("grantSetterRoles", [setter("agent-context"), cfg.editor]));
  await send("grant editor agent-endpoint[web]", onResolver("grantSetterRoles", [setter("agent-endpoint[web]"), cfg.editor]));
  await send(`write ${calls.length} agent records`, onResolver("multicall", [calls]));
  const carry = parentCalls(parent);
  if (carry.length > 0) await send("copy mergit.eth's address and profile records", onResolver("multicall", [carry]));
  await send("point mergit.eth at the resolver", () =>
    ctx.wallet.writeContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "setResolver", args: [MERGIT_LABEL_ID, resolver!] } as never));
  return { resolver: resolver!, steps, parent };
}

export type VerifyRow = { key: string; name: string; ok: boolean; got: string | null };

/** Reads every planned record back through the ENSv2 Universal Resolver, plus the registry's resolver for `mergit.eth`. */
export async function verifyOneShot(pub: PublicClient, cfg: OneShotConfig, resolver: Address, parent?: ParentRecords): Promise<VerifyRow[]> {
  const rows: VerifyRow[] = [];
  for (const a of cfg.agents) {
    const name = ensNameOf(a.label);
    for (const r of agentRecords(a, cfg.chain)) {
      let got: string | null = null;
      try { got = (await pub.getEnsText({ name, key: r.key, universalResolverAddress: UR })) ?? null; } catch { got = null; }
      rows.push({ key: r.key, name, ok: got === r.value, got });
    }
  }
  if (parent?.address) {
    let got: string | null = null;
    try { got = (await pub.getEnsAddress({ name: "mergit.eth", universalResolverAddress: UR })) ?? null; } catch { got = null; }
    rows.push({ key: "address", name: "mergit.eth", ok: got?.toLowerCase() === parent.address.toLowerCase(), got });
  }
  for (const [key, value] of Object.entries(parent?.texts ?? {})) {
    let got: string | null = null;
    try { got = (await pub.getEnsText({ name: "mergit.eth", key, universalResolverAddress: UR })) ?? null; } catch { got = null; }
    rows.push({ key, name: "mergit.eth", ok: got === value, got });
  }
  const onChain = (await pub.readContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "getResolver", args: ["mergit"] })) as Address;
  rows.push({ key: "registry resolver", name: "mergit.eth", ok: onChain.toLowerCase() === resolver.toLowerCase(), got: onChain });
  return rows;
}
