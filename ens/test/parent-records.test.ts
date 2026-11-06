import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, getAddress } from "viem";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { dnsName } from "../src/dns.ts";
import { parentCalls, readParentRecords, PARENT_TEXT_KEYS } from "../src/parent-records.ts";

const OWNER = getAddress("0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D");
const UR = getAddress("0x06fdd07f007adac667177b46ab2eb9a75132cfd5");

const client = (over: { address?: string | null; texts?: Record<string, string | null>; failOn?: string } = {}) => ({
  async getEnsAddress(a: { name: string; universalResolverAddress: string }) {
    assert.equal(a.name, "mergit.eth");
    assert.equal(a.universalResolverAddress, UR);
    if (over.failOn === "address") throw new Error("HTTP request failed. 429");
    return over.address === undefined ? OWNER : over.address;
  },
  async getEnsText(a: { name: string; key: string; universalResolverAddress: string }) {
    assert.equal(a.name, "mergit.eth");
    if (over.failOn === a.key) throw new Error("boom " + a.key);
    return over.texts?.[a.key] ?? null;
  },
});

test("readParentRecords returns the address and only the profile texts that are set", async () => {
  const p = await readParentRecords(client({ texts: { description: "Mergit", url: "https://mergit.site", avatar: "", name: null } }) as never, UR);
  assert.equal(p.address, OWNER);
  assert.deepEqual(p.texts, { description: "Mergit", url: "https://mergit.site" });
});

test("a name with no address record reads as address null", async () => {
  const p = await readParentRecords(client({ address: null }) as never, UR);
  assert.equal(p.address, null);
  assert.deepEqual(p.texts, {});
});

test("a failing read rejects loudly: losing mergit.eth's records silently is the bug this guards against", async () => {
  await assert.rejects(readParentRecords(client({ failOn: "address" }) as never, UR), /could not read the current records of mergit\.eth: .*429/);
  await assert.rejects(readParentRecords(client({ failOn: "description" }) as never, UR), /could not read the current records of mergit\.eth: .*description/);
});

test("parentCalls writes the ETH address (coin type 60, 20 raw bytes) and each text for mergit.eth, and nothing when there is nothing to copy", () => {
  const calls = parentCalls({ address: OWNER, texts: { description: "Mergit", url: "https://mergit.site" } });
  assert.equal(calls.length, 3);
  const d0 = decodeFunctionData({ abi: permissionedResolverAbi, data: calls[0] });
  assert.equal(d0.functionName, "setAddress");
  assert.deepEqual(d0.args, [dnsName("mergit.eth"), 60n, OWNER.toLowerCase()]);
  const d1 = decodeFunctionData({ abi: permissionedResolverAbi, data: calls[1] });
  assert.equal(d1.functionName, "setText");
  assert.deepEqual(d1.args, [dnsName("mergit.eth"), "description", "Mergit"]);
  assert.deepEqual(parentCalls({ address: null, texts: {} }), []);
  assert.equal(parentCalls({ address: null, texts: { url: "https://x.example" } }).length, 1);
});

test("the copied profile keys are fixed and never include anything the one-shot writes itself", () => {
  for (const k of PARENT_TEXT_KEYS) assert.ok(!/^(agent-|mergit\.)/.test(k), k);
  assert.ok(PARENT_TEXT_KEYS.includes("description"));
});
