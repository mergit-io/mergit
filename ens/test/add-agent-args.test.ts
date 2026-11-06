import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddAgentArgs, MAX_DESCRIPTION } from "../src/add-agent-args.ts";

const KEY = "0x" + "11".repeat(32);
const ENV = { ENS_MAINNET_RPC: "https://eth.example.test/v2/secret-mainnet", BASE_SEPOLIA_RPC: "https://base.example.test/v2/secret-base" };
const ARGS = ["agents.json", "--label", "coder-3", "--description", "A third coding agent."];

test("a dry run needs a config, a label, a description and both RPC URLs, and never carries a key even if one is in the environment", () => {
  const a = parseAddAgentArgs(ARGS, { ...ENV, ENS_OWNER_PRIVATE_KEY: KEY });
  assert.deepEqual(a, { mode: "dry-run", configPath: "agents.json", label: "coder-3", description: "A third coding agent.", mainnetRpc: ENV.ENS_MAINNET_RPC, baseRpc: ENV.BASE_SEPOLIA_RPC });
  assert.equal("privateKey" in a, false, "a dry run must not even carry the key");
});

test("--execute carries the key from the environment, and refuses without a well-formed one without ever echoing it", () => {
  const a = parseAddAgentArgs([...ARGS, "--execute"], { ...ENV, ENS_OWNER_PRIVATE_KEY: KEY });
  assert.equal(a.mode, "execute");
  assert.equal((a as { privateKey: string }).privateKey, KEY);
  assert.throws(() => parseAddAgentArgs([...ARGS, "--execute"], ENV), /ENS_OWNER_PRIVATE_KEY/);
  for (const bad of ["0xabc", "not-a-key", "0x" + "zz".repeat(32), KEY + "00", "0x" + "00".repeat(32)]) {
    assert.throws(() => parseAddAgentArgs([...ARGS, "--execute"], { ...ENV, ENS_OWNER_PRIVATE_KEY: bad }), (e: unknown) => {
      assert.match((e as Error).message, /ENS_OWNER_PRIVATE_KEY/);
      assert.ok(!(e as Error).message.includes(bad), "the error must not echo the key");
      return true;
    });
  }
});

test("both RPC URLs are required, in a dry run too (the plan reads both chains)", () => {
  assert.throws(() => parseAddAgentArgs(ARGS, { BASE_SEPOLIA_RPC: ENV.BASE_SEPOLIA_RPC }), /ENS_MAINNET_RPC/);
  assert.throws(() => parseAddAgentArgs(ARGS, { ENS_MAINNET_RPC: ENV.ENS_MAINNET_RPC }), /BASE_SEPOLIA_RPC/);
});

test("the label follows the ENS label rules and the description is required and capped", () => {
  const withLabel = (l: string) => ["agents.json", "--label", l, "--description", "d"];
  for (const l of ["Coder", "a b", "-x", "x-", "a.b", "", "x".repeat(64)]) assert.throws(() => parseAddAgentArgs(withLabel(l), ENV), /label/i, `label ${JSON.stringify(l)}`);
  assert.equal(parseAddAgentArgs(withLabel("coder-12"), ENV).label, "coder-12");
  assert.throws(() => parseAddAgentArgs(["agents.json", "--label", "x"], ENV), /--description/);
  assert.throws(() => parseAddAgentArgs(["agents.json", "--description", "d"], ENV), /--label/);
  assert.throws(() => parseAddAgentArgs(["agents.json", "--label", "x", "--description", "   "], ENV), /--description/);
  assert.equal(MAX_DESCRIPTION, 300);
  assert.equal(parseAddAgentArgs(["agents.json", "--label", "x", "--description", "d".repeat(300)], ENV).description.length, 300);
  assert.throws(() => parseAddAgentArgs(["agents.json", "--label", "x", "--description", "d".repeat(301)], ENV), /300/);
});

test("--agent-id must be a positive integer and is the rerun switch", () => {
  assert.equal((parseAddAgentArgs([...ARGS, "--agent-id", "7"], ENV) as { agentId?: number }).agentId, 7);
  assert.equal("agentId" in parseAddAgentArgs(ARGS, ENV), false);
  for (const bad of ["0", "-1", "1.5", "abc", "", "1e3", "99999999999999999999"]) assert.throws(() => parseAddAgentArgs([...ARGS, "--agent-id", bad], ENV), /--agent-id/, `agent id ${JSON.stringify(bad)}`);
});

test("--registrations-dir and --agents-toml override where the CLI writes and reads (for tests and unusual checkouts), and are absent by default", () => {
  const a = parseAddAgentArgs([...ARGS, "--registrations-dir", "/tmp/reg", "--agents-toml", "/tmp/agents.toml"], ENV) as { registrationsDir?: string; agentsTomlPath?: string };
  assert.deepEqual([a.registrationsDir, a.agentsTomlPath], ["/tmp/reg", "/tmp/agents.toml"]);
  const d = parseAddAgentArgs(ARGS, ENV);
  assert.equal("registrationsDir" in d || "agentsTomlPath" in d, false);
  assert.throws(() => parseAddAgentArgs([...ARGS, "--agents-toml"], ENV), /--agents-toml needs a value/);
  assert.throws(() => parseAddAgentArgs([...ARGS, "--registrations-dir", "a", "--registrations-dir", "b"], ENV), /more than once/);
});

test("unknown flags, repeated flags, missing values and extra positionals are refused with the usage", () => {
  assert.throws(() => parseAddAgentArgs([...ARGS, "--wat"], ENV), /unknown option --wat.*usage/is);
  assert.throws(() => parseAddAgentArgs([...ARGS, "--label", "other"], ENV), /more than once/);
  assert.throws(() => parseAddAgentArgs([...ARGS, "--execute", "--execute"], { ...ENV, ENS_OWNER_PRIVATE_KEY: KEY }), /more than once/);
  assert.throws(() => parseAddAgentArgs(["agents.json", "--label"], ENV), /--label needs a value/);
  assert.throws(() => parseAddAgentArgs(["agents.json", "--label", "--description", "d"], ENV), /--label needs a value/);
  assert.throws(() => parseAddAgentArgs([...ARGS, "extra.json"], ENV), /usage/i);
  assert.throws(() => parseAddAgentArgs(["--label", "x", "--description", "d"], ENV), /usage/i);
  assert.throws(() => parseAddAgentArgs([], ENV), /usage/i);
});

test("a private key given on the command line is refused wherever it appears, and the message never contains it", () => {
  const pasted = "0x" + "ab".repeat(32);
  const cases = [["agents.json", pasted], ["agents.json", "--label", "x", "--description", `key ${pasted}`], ["agents.json", "--label", "x", "--description", "d", `--${pasted}`], ["agents.json", "--label", "x", "--description", "d", "--agent-id", pasted]];
  for (const argv of cases) {
    assert.throws(() => parseAddAgentArgs(argv, ENV), (e: unknown) => {
      assert.match((e as Error).message, /ENS_OWNER_PRIVATE_KEY/);
      assert.ok(!(e as Error).message.includes(pasted) && !(e as Error).message.includes("ab".repeat(32)), "the error must not echo the key");
      return true;
    });
  }
});

test("no error message contains an RPC URL or the key from the environment", () => {
  const env = { ...ENV, ENS_OWNER_PRIVATE_KEY: KEY };
  for (const argv of [[...ARGS, "--wat"], ["agents.json"], [...ARGS, "--agent-id", "x"], [...ARGS, "--execute", "--execute"]]) {
    assert.throws(() => parseAddAgentArgs(argv, env), (e: unknown) => {
      const m = (e as Error).message;
      for (const s of [KEY, KEY.slice(2), "secret-mainnet", "secret-base"]) assert.ok(!m.includes(s), `message leaks ${s}`);
      return true;
    });
  }
});
