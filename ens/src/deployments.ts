import { getAddress, type Address } from "viem";

// ENSv2 contracts on Ethereum mainnet, from https://docs.ens.domains/learn/deployments (read 2026-11-06).
// Each address is checked for code by test/deployments.test.ts. ABIs in ./abi were taken from Sourcify's exact-match verified source.
export const MAINNET = {
  permissionedResolverImpl: getAddress("0x565b0f456a04ac9b48758190e90030623cff57c5"),
  verifiableFactory: getAddress("0x77510ba162dfea3d8989e3f0928a691b345730d2"),
  ethRegistry: getAddress("0xf60aba43e1f7f3dab1186ff03b561401c9df85e2"),
  universalResolverV2: getAddress("0x06fdd07f007adac667177b46ab2eb9a75132cfd5"),
} as const satisfies Record<string, Address>;

export type Deployments = typeof MAINNET;
