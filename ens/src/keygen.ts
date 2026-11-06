import { chmodSync, mkdirSync, openSync, closeSync, writeSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

/**
 * Makes one private key per name, writes them to `path` as `NAME=0x...` lines with mode 0600, and returns only the
 * addresses, by name. Never overwrites a file; a failed write leaves no file behind.
 */
export function generateNamedKeys(path: string, names: string[]): Record<string, Address> {
  if (names.length === 0) throw new Error("name at least one key");
  for (const n of names) if (!/^[A-Z][A-Z0-9_]*$/.test(n)) throw new Error(`"${n}" is not a valid variable name (capitals, digits, underscores)`);
  if (new Set(names).size !== names.length) throw new Error("key names must be different");
  const keys = names.map((n) => [n, generatePrivateKey()] as const);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600); // "wx": fails if the file exists
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${path} already exists; refusing to overwrite keys`, { cause });
    throw cause;
  }
  try {
    writeSync(fd, keys.map(([n, k]) => `${n}=${k}\n`).join(""));
    closeSync(fd);
    chmodSync(path, 0o600);
  } catch (cause) {
    try { unlinkSync(path); } catch { /* nothing to remove */ }
    throw cause;
  }
  return Object.fromEntries(keys.map(([n, k]) => [n, privateKeyToAccount(k).address]));
}

/** The writer's two keys (publisher and editor). */
export function generateKeyFile(path: string): { publisher: Address; editor: Address } {
  const a = generateNamedKeys(path, ["ENS_PUBLISHER_PRIVATE_KEY", "ENS_EDITOR_PRIVATE_KEY"]);
  return { publisher: a.ENS_PUBLISHER_PRIVATE_KEY!, editor: a.ENS_EDITOR_PRIVATE_KEY! };
}
