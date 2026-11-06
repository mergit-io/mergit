import { homedir } from "node:os";
import { join } from "node:path";
import { generateKeyFile, generateNamedKeys } from "./keygen.ts";

// Makes private keys and saves them to a file only you can read; prints only the addresses.
//   node src/keygen-cli.ts [file]                    the writer's publisher and editor keys
//                                                    (default ~/.config/mergit/writer-keys.env)
//   node src/keygen-cli.ts <file> NAME1 NAME2 ...    one key per NAME, e.g. MERGIT_AGENT_KEY_2 (agents' runtime keys)
// The file is mode 0600 and is never overwritten.
const [fileArg, ...names] = process.argv.slice(2);
const path = fileArg ?? join(homedir(), ".config", "mergit", "writer-keys.env");
try {
  if (names.length === 0) {
    const a = generateKeyFile(path);
    console.log(`keys saved to ${path} (mode 600). They were not printed.\npublisher: ${a.publisher}\neditor:    ${a.editor}`);
  } else {
    const a = generateNamedKeys(path, names);
    console.log(`keys saved to ${path} (mode 600). They were not printed.`);
    for (const [n, address] of Object.entries(a)) console.log(`${n}: ${address}`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
