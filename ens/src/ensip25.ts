import { isAddress, type Address, type Hex } from "viem";

/**
 * ERC-7930 interoperable address of an EVM contract: version `0001`, chain type `0000` (EIP-155),
 * chain-reference length, chain reference (minimal big-endian bytes), address length `14`, address.
 */
export function erc7930Address(chainId: number, address: Address): Hex {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`erc7930: invalid chain id ${chainId}`);
  if (!isAddress(address)) throw new Error(`erc7930: invalid address ${address}`);
  let ref = chainId.toString(16);
  if (ref.length % 2) ref = "0" + ref;
  const refLen = (ref.length / 2).toString(16).padStart(2, "0");
  return `0x00010000${refLen}${ref}14${address.slice(2).toLowerCase()}`;
}

/** ENSIP-25 text record key: `agent-registration[<ERC-7930 registry>][<agentId>]`. The record value is `"1"`. */
export function agentRegistrationKey(registry: Address, chainId: number, agentId: string | number | bigint): string {
  const id = String(agentId);
  if (id === "" || /[\[\]]/.test(id)) throw new Error(`ensip25: invalid agent id "${id}" (must be non-empty and contain no brackets)`);
  return `agent-registration[${erc7930Address(chainId, registry)}][${id}]`;
}
