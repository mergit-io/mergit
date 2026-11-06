import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const EXAMPLE = new URL("../agents.example.json", import.meta.url).pathname;
const base = () => JSON.parse(readFileSync(EXAMPLE, "utf8"));

const dir = mkdtempSync(join(tmpdir(), "ens-config-"));
const write = (obj: unknown) => { const p = join(dir, `c${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(obj)); return p; };
const REAL = "0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D"; // any non-test address

test("the example file loads for a fork run (it uses anvil test addresses as placeholders)", () => {
  const c = loadConfig(EXAMPLE, { allowTestAddresses: true });
  assert.equal(c.agents.length, 3);
  assert.equal(c.chain.chainId, 84532);
  assert.deepEqual(c.agents.map((a) => a.agentId), [2, 3, 4]);
});

test("anvil's public test addresses are refused for publisher and editor unless a fork run allows them", () => {
  assert.throws(() => loadConfig(EXAMPLE), /publisher.*test/i);
  const c = base(); c.publisher = REAL;
  assert.throws(() => loadConfig(write(c)), /editor.*test/i);
  c.editor = "0x0000000000000000000000000000000000000abc";
  assert.equal(loadConfig(write(c)).editor.toLowerCase(), c.editor);
});

test("each bad field is rejected with an error that names it", () => {
  const cases: [string, (c: any) => void, RegExp][] = [
    ["bad publisher address", (c) => { c.publisher = "0x1234"; }, /publisher/],
    ["bad identity", (c) => { c.identity = "nope"; }, /identity/],
    ["bad chain id", (c) => { c.chainId = 0; }, /chainId/],
    ["duplicate label", (c) => { c.agents[1].label = c.agents[0].label; }, /duplicate label/i],
    ["duplicate agent id", (c) => { c.agents[1].agentId = c.agents[0].agentId; }, /duplicate agent id/i],
    ["missing profile url", (c) => { delete c.agents[0].profileUrl; }, /profileUrl/],
    ["http profile url", (c) => { c.agents[0].profileUrl = "http://mergit.site/agents/x"; }, /profileUrl.*https/i],
    ["uppercase label", (c) => { c.agents[0].label = "Coder-0"; }, /label/i],
    ["no agents", (c) => { c.agents = []; }, /agents/],
    ["missing label (a typo such as \"lable\")", (c) => { c.agents[0].lable = c.agents[0].label; delete c.agents[0].label; }, /label/i],
    ["agent id zero", (c) => { c.agents[0].agentId = 0; }, /agentId/],
    ["agent id negative", (c) => { c.agents[0].agentId = -1; }, /agentId/],
    ["agent id fractional", (c) => { c.agents[0].agentId = 1.5; }, /agentId/],
    ["agent id a string", (c) => { c.agents[0].agentId = "2"; }, /agentId/],
  ];
  for (const [name, mutate, re] of cases) {
    const c = base(); mutate(c);
    assert.throws(() => loadConfig(write(c), { allowTestAddresses: true }), re, name);
  }
});

test("an agent that is not registered yet may omit agentId (no placeholder needed), and the planner then refuses to run it", () => {
  const c = base(); delete c.agents[0].agentId;
  const loaded = loadConfig(write(c), { allowTestAddresses: true });
  assert.equal(loaded.agents[0].agentId, undefined);
  assert.equal(loaded.agents[1].agentId, 3);
});
