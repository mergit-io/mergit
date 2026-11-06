import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLedgerArgs } from "../src/ledger-args.ts";

const KEY = "0x" + "11".repeat(32);

test("snapshot needs the Base RPC and a config; its defaults point at the site's ledger folder", () => {
  const a = parseLedgerArgs(["snapshot"], { BASE_SEPOLIA_RPC: "https://b.example", WRITER_CONFIG: "writer.json" });
  assert.equal(a.command, "snapshot");
  assert.equal((a as { uriBase: string }).uriBase, "https://mergit.site/ledger");
  assert.match((a as { outDir: string }).outDir, /frontend\/public\/ledger$/);
  const b = parseLedgerArgs(["snapshot", "--out", "x", "--uri-base", "https://other.example/l", "--commitments", "c.json", "--terms", "t.json"], { BASE_SEPOLIA_RPC: "https://b.example", WRITER_CONFIG: "w.json" });
  assert.deepEqual([(b as any).outDir, (b as any).uriBase, (b as any).commitmentsPath, (b as any).termsPath], ["x", "https://other.example/l", "c.json", "t.json"]);
});

test("publish is a dry run unless --execute, carries the key only with --execute, and never echoes it", () => {
  const env = { ENS_MAINNET_RPC: "https://e.example", WRITER_CONFIG: "w.json", ENS_PUBLISHER_PRIVATE_KEY: KEY };
  const dry = parseLedgerArgs(["publish", "--record", "r.json"], env);
  assert.equal(dry.command, "publish");
  assert.equal("privateKey" in dry, false, "a dry run must not even carry the key");
  const run = parseLedgerArgs(["publish", "--record", "r.json", "--execute"], env);
  assert.equal((run as { privateKey: string }).privateKey, KEY);
  for (const bad of ["0xabc", "nope", "0x" + "ff".repeat(32)]) {
    assert.throws(() => parseLedgerArgs(["publish", "--record", "r.json", "--execute"], { ...env, ENS_PUBLISHER_PRIVATE_KEY: bad }), (e: unknown) => {
      assert.match((e as Error).message, /ENS_PUBLISHER_PRIVATE_KEY/);
      assert.ok(!(e as Error).message.includes(bad));
      return true;
    });
  }
  assert.throws(() => parseLedgerArgs(["publish", "--execute"], env), /--record/);
  assert.throws(() => parseLedgerArgs(["publish", "--record", "r.json", "--execute"], { ...env, ENS_PUBLISHER_PRIVATE_KEY: undefined }), /ENS_PUBLISHER_PRIVATE_KEY/);
});

test("unknown commands, options and missing environment are refused with a usage message", () => {
  assert.throws(() => parseLedgerArgs([], {}), /usage/i);
  assert.throws(() => parseLedgerArgs(["wat"], {}), /usage/i);
  assert.throws(() => parseLedgerArgs(["snapshot", "--wat"], { BASE_SEPOLIA_RPC: "x", WRITER_CONFIG: "w" }), /usage/i);
  assert.throws(() => parseLedgerArgs(["snapshot"], { WRITER_CONFIG: "w" }), /BASE_SEPOLIA_RPC/);
  assert.throws(() => parseLedgerArgs(["publish", "--record", "r"], { WRITER_CONFIG: "w" }), /ENS_MAINNET_RPC/);
  assert.throws(() => parseLedgerArgs(["snapshot", "--uri-base", "http://insecure.example"], { BASE_SEPOLIA_RPC: "x", WRITER_CONFIG: "w" }), /https/);
});
