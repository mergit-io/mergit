import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { generateKeyFile, generateNamedKeys } from "../src/keygen.ts";

const dir = () => mkdtempSync(join(tmpdir(), "keygen-"));

test("it writes two different keys to a file only the owner can read, and returns only their addresses", () => {
  const path = join(dir(), "sub", "keys.env");
  const out = generateKeyFile(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const text = readFileSync(path, "utf8");
  const publisher = /^ENS_PUBLISHER_PRIVATE_KEY=(0x[0-9a-f]{64})$/m.exec(text)?.[1];
  const editor = /^ENS_EDITOR_PRIVATE_KEY=(0x[0-9a-f]{64})$/m.exec(text)?.[1];
  assert.ok(publisher && editor && publisher !== editor);
  assert.equal(privateKeyToAccount(publisher as `0x${string}`).address, out.publisher);
  assert.equal(privateKeyToAccount(editor as `0x${string}`).address, out.editor);
  assert.ok(!JSON.stringify(out).includes(publisher) && !JSON.stringify(out).includes(editor), "the result must not carry a key");
});

test("it never overwrites an existing file", () => {
  const path = join(dir(), "keys.env");
  generateKeyFile(path);
  const before = readFileSync(path, "utf8");
  assert.throws(() => generateKeyFile(path), /already exists/);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("it can make any named keys (the agents' runtime keys), each different, and returns only addresses", () => {
  const path = join(dir(), "agents.env");
  const out = generateNamedKeys(path, ["MERGIT_AGENT_KEY_2", "MERGIT_AGENT_KEY_3"]);
  assert.deepEqual(Object.keys(out), ["MERGIT_AGENT_KEY_2", "MERGIT_AGENT_KEY_3"]);
  const text = readFileSync(path, "utf8");
  const k2 = /^MERGIT_AGENT_KEY_2=(0x[0-9a-f]{64})$/m.exec(text)?.[1];
  const k3 = /^MERGIT_AGENT_KEY_3=(0x[0-9a-f]{64})$/m.exec(text)?.[1];
  assert.ok(k2 && k3 && k2 !== k3);
  assert.equal(privateKeyToAccount(k2 as `0x${string}`).address, out.MERGIT_AGENT_KEY_2);
  assert.throws(() => generateNamedKeys(join(dir(), "x.env"), ["bad name"]), /not a valid variable name/);
  assert.throws(() => generateNamedKeys(join(dir(), "y.env"), []), /at least one/);
});
