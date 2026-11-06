import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWriterConfig, parseWriterEnv, redact } from "../src/writer-env.ts";

const PUB = "0x" + "11".repeat(32);
const EDT = "0x" + "22".repeat(32);
const good = () => ({ ENS_MAINNET_RPC: "https://eth.example/v2/KEY1", BASE_SEPOLIA_RPC: "https://base.example/v2/KEY2",
  ENS_PUBLISHER_PRIVATE_KEY: PUB, ENS_EDITOR_PRIVATE_KEY: EDT, WRITER_CONFIG: "writer.json" });

test("a complete environment parses, with defaults for port and interval", () => {
  const e = parseWriterEnv(good());
  assert.equal(e.publisherKey, PUB);
  assert.equal(e.editorKey, EDT);
  assert.equal(e.port, 8787);
  assert.equal(e.intervalSeconds, 300);
  assert.equal(e.configPath, "writer.json");
});

test("a missing or malformed key is refused with the variable's name and never the value", () => {
  for (const [name, bad] of [["ENS_PUBLISHER_PRIVATE_KEY", "0xabc"], ["ENS_EDITOR_PRIVATE_KEY", "nope"], ["ENS_PUBLISHER_PRIVATE_KEY", "0x" + "zz".repeat(32)], ["ENS_EDITOR_PRIVATE_KEY", PUB + "00"]] as const) {
    const env = { ...good(), [name]: bad };
    assert.throws(() => parseWriterEnv(env), (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, new RegExp(name));
      assert.ok(!m.includes(bad), "the error must not echo the key");
      return true;
    });
  }
  for (const name of ["ENS_PUBLISHER_PRIVATE_KEY", "ENS_EDITOR_PRIVATE_KEY", "ENS_MAINNET_RPC", "BASE_SEPOLIA_RPC", "WRITER_CONFIG"] as const) {
    const env: Record<string, string | undefined> = { ...good() }; delete env[name];
    assert.throws(() => parseWriterEnv(env), new RegExp(name));
  }
});

test("a key outside the curve order is refused with a fixed message that has no number in it", () => {
  const bad = "0x" + "ff".repeat(32);
  assert.throws(() => parseWriterEnv({ ...good(), ENS_PUBLISHER_PRIVATE_KEY: bad }), (e: unknown) => {
    const m = (e as Error).message;
    assert.match(m, /ENS_PUBLISHER_PRIVATE_KEY/);
    assert.ok(!/\d{12,}/.test(m), "no long decimal (the curve error would print the key as a decimal)");
    return true;
  });
});

test("the same account for publisher and editor is refused (R13: keep the keys separate)", () => {
  assert.throws(() => parseWriterEnv({ ...good(), ENS_EDITOR_PRIVATE_KEY: PUB }), /must be different accounts/);
});

test("port and interval must be sensible numbers", () => {
  for (const [k, v] of [["WRITER_PORT", "abc"], ["WRITER_PORT", "70000"], ["WRITER_PORT", "-1"], ["WRITER_INTERVAL_SECONDS", "0"], ["WRITER_INTERVAL_SECONDS", "x"]] as const) {
    assert.throws(() => parseWriterEnv({ ...good(), [k]: v }), new RegExp(k));
  }
  assert.equal(parseWriterEnv({ ...good(), WRITER_PORT: "0" }).port, 0);
});

test("redact removes every secret and RPC URL from a message, including repeats", () => {
  const e = parseWriterEnv(good());
  const msg = `HTTP request failed. URL: ${e.ensRpc} and again ${e.ensRpc}; key ${e.publisherKey}; base ${e.baseRpc}; editor ${e.editorKey}`;
  const out = redact(msg, [e.ensRpc, e.baseRpc, e.publisherKey, e.editorKey]);
  for (const s of [e.ensRpc, e.baseRpc, e.publisherKey, e.editorKey, "KEY1", "KEY2"]) assert.ok(!out.includes(s), `still contains ${s}`);
  assert.ok(out.includes("[redacted]"));
});

const dir = mkdtempSync(join(tmpdir(), "ens-writer-"));
const writeCfg = (o: unknown) => { const p = join(dir, `w${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(o)); return p; };
const cfgObj = () => ({ chain: { chainId: 84532, identity: "0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6", anchor: "0xf9DBfF75887361A67269765DA6F8732b233Fda76" },
  resolver: "0x13C6c51B109972043DD487d97961D9f141e846c9", agents: [{ label: "coder-0", agentId: 2 }], knownCategories: ["test-repair"], fromBlock: "51760675" });

test("the writer config loads into a PublisherConfig with a bigint fromBlock", () => {
  const c = loadWriterConfig(writeCfg(cfgObj()));
  assert.equal(c.fromBlock, 51760675n);
  assert.equal(c.agents[0].label, "coder-0");
  assert.equal(c.chain.chainId, 84532);
});

test("each bad writer config field is rejected with its name", () => {
  const cases: [string, (c: any) => void, RegExp][] = [
    ["bad resolver", (c) => { c.resolver = "0x12"; }, /resolver/],
    ["bad anchor", (c) => { c.chain.anchor = "nope"; }, /anchor/],
    ["duplicate label", (c) => { c.agents.push({ label: "coder-0", agentId: 3 }); }, /duplicate label/i],
    ["duplicate agent id", (c) => { c.agents.push({ label: "coder-1", agentId: 2 }); }, /duplicate agent id/i],
    ["agent without id", (c) => { c.agents[0].agentId = undefined; }, /agentId/],
    ["negative fromBlock", (c) => { c.fromBlock = "-5"; }, /fromBlock/],
    ["non-numeric fromBlock", (c) => { c.fromBlock = "abc"; }, /fromBlock/],
    ["no agents", (c) => { c.agents = []; }, /agents/],
  ];
  for (const [name, mutate, re] of cases) { const c = cfgObj(); mutate(c); assert.throws(() => loadWriterConfig(writeCfg(c)), re, name); }
});

test("confirmations is optional, defaults to 5 and must be a small non-negative integer", () => {
  assert.equal(loadWriterConfig(writeCfg(cfgObj())).confirmations, 5);
  assert.equal(loadWriterConfig(writeCfg({ ...cfgObj(), confirmations: 0 })).confirmations, 0);
  for (const bad of [-1, 1.5, "x", 1000]) assert.throws(() => loadWriterConfig(writeCfg({ ...cfgObj(), confirmations: bad })), /confirmations/);
});

test("the edit limits have defaults and must be positive integers", () => {
  const e = parseWriterEnv(good());
  assert.deepEqual([e.editsPerAgentPerHour, e.editsPerHour, e.requestsPerMinute], [6, 60, 120]);
  assert.equal(parseWriterEnv({ ...good(), WRITER_EDITS_PER_HOUR: "10" }).editsPerHour, 10);
  for (const k of ["WRITER_EDITS_PER_AGENT_PER_HOUR", "WRITER_EDITS_PER_HOUR", "WRITER_REQUESTS_PER_MINUTE"]) {
    for (const v of ["0", "-1", "x"]) assert.throws(() => parseWriterEnv({ ...good(), [k]: v }), new RegExp(k));
  }
});
