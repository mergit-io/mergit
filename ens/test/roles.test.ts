import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionResult, encodeFunctionData, namehash, parseAbi, type Address } from "viem";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { ACCOUNTS, deployResolver, dnsName, startFork, type Fork } from "./fork.ts";

// M1 role spike (issue #66): what the deployed PermissionedResolver really enforces. Findings, not wishes.
const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
const textAbi = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);
const ALICE_AGENT = "coder-0.mergit.eth";
const BOB_AGENT = "coder-1.mergit.eth";
const REPUTATION = "mergit.reputation";
const ENDPOINT = "agent-endpoint[web]";

let fork: Fork;
before(async () => { if (!skip) fork = await startFork(); });
after(async () => { if (fork) await fork.stop(); });

type Who = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];

/** The `setter` argument of grantSetterRoles: an ABI-encoded setText call. Only the key matters; name and value are ignored. */
const setter = (key: string) =>
  encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsName("ignored.eth"), key, ""] });

async function send(resolver: Address, from: Who, functionName: "setText" | "grantSetterRoles" | "grantRoles", args: unknown[]) {
  const hash = await fork.wallet(from).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName, args } as never);
  const r = await fork.pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success");
}
const grantKey = (resolver: Address, account: Who, key: string) => send(resolver, ACCOUNTS.admin, "grantSetterRoles", [setter(key), account.address]);
const write = (resolver: Address, from: Who, name: string, key: string, value = "v") => send(resolver, from, "setText", [dnsName(name), key, value]);

async function read(resolver: Address, name: string, key: string): Promise<string> {
  const raw = await fork.pub.readContract({
    address: resolver, abi: permissionedResolverAbi, functionName: "resolve",
    args: [dnsName(name), encodeFunctionData({ abi: textAbi, functionName: "text", args: [namehash(name), key] })],
  });
  return decodeFunctionResult({ abi: textAbi, functionName: "text", data: raw });
}

async function reverts(p: Promise<unknown>, errorName: string) {
  await assert.rejects(p, (e: unknown) => {
    const text = `${(e as Error).message} ${(e as { shortMessage?: string }).shortMessage ?? ""}`;
    assert.match(text, new RegExp(errorName), `expected revert ${errorName}, got: ${text.slice(0, 300)}`);
    return true;
  });
}

test("publisher can write mergit.reputation on every name", { skip }, async () => {
  const r = await deployResolver(fork, ACCOUNTS.admin.address);
  await grantKey(r, ACCOUNTS.publisher, REPUTATION);
  await write(r, ACCOUNTS.publisher, ALICE_AGENT, REPUTATION, "a");
  await write(r, ACCOUNTS.publisher, BOB_AGENT, REPUTATION, "b");
  assert.equal(await read(r, ALICE_AGENT, REPUTATION), "a");
  assert.equal(await read(r, BOB_AGENT, REPUTATION), "b");
});

test("publisher cannot write any other key", { skip }, async () => {
  const r = await deployResolver(fork, ACCOUNTS.admin.address);
  await grantKey(r, ACCOUNTS.publisher, REPUTATION);
  await reverts(write(r, ACCOUNTS.publisher, ALICE_AGENT, ENDPOINT), "EACUnauthorizedAccountRoles");
  await reverts(write(r, ACCOUNTS.publisher, ALICE_AGENT, "agent-context"), "EACUnauthorizedAccountRoles");
});

test("an account with no role cannot write mergit.reputation", { skip }, async () => {
  const r = await deployResolver(fork, ACCOUNTS.admin.address);
  await grantKey(r, ACCOUNTS.publisher, REPUTATION);
  await reverts(write(r, ACCOUNTS.alice, ALICE_AGENT, REPUTATION), "EACUnauthorizedAccountRoles");
});

test("role does not leak to a similar key", { skip }, async () => {
  const r = await deployResolver(fork, ACCOUNTS.admin.address);
  await grantKey(r, ACCOUNTS.publisher, REPUTATION);
  for (const key of [`${REPUTATION}2`, "Mergit.reputation", "mergit.reputatio", ""]) {
    await reverts(write(r, ACCOUNTS.publisher, ALICE_AGENT, key), "EACUnauthorizedAccountRoles");
  }
});

test("bracketed key scopes exactly", { skip }, async () => {
  const r = await deployResolver(fork, ACCOUNTS.admin.address);
  await grantKey(r, ACCOUNTS.mergit, ENDPOINT);
  await write(r, ACCOUNTS.mergit, ALICE_AGENT, ENDPOINT, "https://example.test/a");
  assert.equal(await read(r, ALICE_AGENT, ENDPOINT), "https://example.test/a");
  await reverts(write(r, ACCOUNTS.mergit, ALICE_AGENT, "agent-endpoint[api]"), "EACUnauthorizedAccountRoles");
  await reverts(write(r, ACCOUNTS.mergit, ALICE_AGENT, "agent-endpoint"), "EACUnauthorizedAccountRoles");
});

test("L1: a key role is per resolver, not per name (operator Alice can edit Bob's agent)", { skip }, async () => {
  const r = await deployResolver(fork, ACCOUNTS.admin.address);
  await grantKey(r, ACCOUNTS.alice, ENDPOINT); // Alice is Alice's operator, so she is given her own key
  await write(r, ACCOUNTS.alice, ALICE_AGENT, ENDPOINT, "https://alice.test");
  // The same grant also lets her write Bob's record. If this stops succeeding, L1 is closed and the HLD must change.
  await write(r, ACCOUNTS.alice, BOB_AGENT, ENDPOINT, "https://attacker.test");
  assert.equal(await read(r, BOB_AGENT, ENDPOINT), "https://attacker.test");
});

test("option (a): operators hold no role and Mergit's key writes every name", { skip }, async () => {
  const r = await deployResolver(fork, ACCOUNTS.admin.address);
  await reverts(write(r, ACCOUNTS.alice, ALICE_AGENT, ENDPOINT), "EACUnauthorizedAccountRoles");
  await reverts(write(r, ACCOUNTS.bob, BOB_AGENT, ENDPOINT), "EACUnauthorizedAccountRoles");
  await reverts(write(r, ACCOUNTS.alice, BOB_AGENT, ENDPOINT), "EACUnauthorizedAccountRoles"); // and Alice cannot touch Bob's agent
  await grantKey(r, ACCOUNTS.mergit, ENDPOINT);
  await write(r, ACCOUNTS.mergit, ALICE_AGENT, ENDPOINT, "https://a.test");
  await write(r, ACCOUNTS.mergit, BOB_AGENT, ENDPOINT, "https://b.test");
  assert.equal(await read(r, ALICE_AGENT, ENDPOINT), "https://a.test");
  assert.equal(await read(r, BOB_AGENT, ENDPOINT), "https://b.test");
  await reverts(write(r, ACCOUNTS.mergit, ALICE_AGENT, REPUTATION), "EACUnauthorizedAccountRoles"); // Mergit's endpoint key is not the reputation key
});

test("grantRoles is disabled", { skip }, async () => {
  const r = await deployResolver(fork, ACCOUNTS.admin.address);
  await reverts(send(r, ACCOUNTS.admin, "grantRoles", [0n, 1n << 4n, ACCOUNTS.alice.address]), "EACCannotGrantRoles");
});

test("control: the resolver owner (root roles) can write any key, so the reverts above are about missing roles", { skip }, async () => {
  const r = await deployResolver(fork, ACCOUNTS.admin.address);
  await write(r, ACCOUNTS.admin, ALICE_AGENT, REPUTATION, "x");
  await write(r, ACCOUNTS.admin, ALICE_AGENT, ENDPOINT, "y");
  assert.equal(await read(r, ALICE_AGENT, REPUTATION), "x");
  assert.equal(await read(r, ALICE_AGENT, ENDPOINT), "y");
});

test("the Mergit editor key holds agent-context and agent-endpoint[web] only: it cannot write reputation or registration records", { skip }, async () => {
  const r = await deployResolver(fork, ACCOUNTS.admin.address);
  await grantKey(r, ACCOUNTS.mergit, "agent-context");
  await grantKey(r, ACCOUNTS.mergit, ENDPOINT);
  await write(r, ACCOUNTS.mergit, ALICE_AGENT, "agent-context", "# coder-0");
  await write(r, ACCOUNTS.mergit, BOB_AGENT, ENDPOINT, "https://b.test");
  assert.equal(await read(r, ALICE_AGENT, "agent-context"), "# coder-0");
  const registration = "agent-registration[0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6][0]";
  await reverts(write(r, ACCOUNTS.mergit, ALICE_AGENT, REPUTATION), "EACUnauthorizedAccountRoles");
  await reverts(write(r, ACCOUNTS.mergit, ALICE_AGENT, registration), "EACUnauthorizedAccountRoles");
});
