import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/oneshot-args.ts";

const KEY = "0x" + "11".repeat(32);
const RPC = "https://rpc.example.test";

test("--fork needs only a config and an RPC", () => {
  assert.deepEqual(parseArgs(["agents.json", "--fork"], { ENS_MAINNET_RPC: RPC }), { mode: "fork", configPath: "agents.json", rpc: RPC });
});

test("--mainnet without --execute is a plan only and never carries a key, even if one is in the environment", () => {
  const r = parseArgs(["agents.json", "--mainnet"], { ENS_MAINNET_RPC: RPC, ENS_OWNER_PRIVATE_KEY: KEY });
  assert.equal(r.mode, "mainnet-plan");
  assert.equal("privateKey" in r, false);
});

test("--mainnet --execute needs a well-formed key from the environment and carries it", () => {
  const r = parseArgs(["agents.json", "--mainnet", "--execute"], { ENS_MAINNET_RPC: RPC, ENS_OWNER_PRIVATE_KEY: KEY });
  assert.equal(r.mode, "mainnet-execute");
  assert.equal((r as { privateKey: string }).privateKey, KEY);
});

test("a missing or malformed key is refused and the message never contains the key", () => {
  assert.throws(() => parseArgs(["a.json", "--mainnet", "--execute"], { ENS_MAINNET_RPC: RPC }), /ENS_OWNER_PRIVATE_KEY/);
  for (const bad of ["0xabc", "not-a-key", "0x" + "zz".repeat(32), KEY + "00"]) {
    assert.throws(() => parseArgs(["a.json", "--mainnet", "--execute"], { ENS_MAINNET_RPC: RPC, ENS_OWNER_PRIVATE_KEY: bad }), (e: unknown) => {
      assert.match((e as Error).message, /ENS_OWNER_PRIVATE_KEY/);
      assert.ok(!(e as Error).message.includes(bad), "the error must not echo the key");
      return true;
    });
  }
});

test("conflicting or incomplete arguments are refused with a usage message", () => {
  assert.throws(() => parseArgs(["a.json", "--fork", "--mainnet"], { ENS_MAINNET_RPC: RPC }), /usage/i);
  assert.throws(() => parseArgs(["a.json", "--execute"], { ENS_MAINNET_RPC: RPC }), /--execute/);
  assert.throws(() => parseArgs(["a.json"], { ENS_MAINNET_RPC: RPC }), /usage/i);
  assert.throws(() => parseArgs(["--fork"], { ENS_MAINNET_RPC: RPC }), /usage/i);
  assert.throws(() => parseArgs(["a.json", "--fork"], {}), /ENS_MAINNET_RPC/);
  assert.throws(() => parseArgs(["a.json", "--fork", "--wat"], { ENS_MAINNET_RPC: RPC }), /usage/i);
});
