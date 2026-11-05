import { mnemonicToAccount, type HDAccount } from "viem/accounts";

// anvil's public test mnemonic. Its accounts hold 10,000 ETH on every anvil chain and their private keys are public,
// so they must never be given any role on a real chain (config.ts refuses them outside fork runs).
const MNEMONIC = "test test test test test test test test test test test junk";

export const testAccount = (addressIndex: number): HDAccount => mnemonicToAccount(MNEMONIC, { addressIndex });

const TEST_ADDRESSES = new Set(Array.from({ length: 20 }, (_, i) => testAccount(i).address.toLowerCase()));
export const isTestAddress = (address: string): boolean => TEST_ADDRESSES.has(address.toLowerCase());
