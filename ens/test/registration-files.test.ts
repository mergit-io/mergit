import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { writeRegistrationFiles } from "../src/registration-files.ts";

const EXAMPLE = new URL("../agents.example.json", import.meta.url).pathname;

test("one registration file per agent is written, named <label>.json, with the registration listed", () => {
  const cfg = loadConfig(EXAMPLE, { allowTestAddresses: true });
  const out = mkdtempSync(join(tmpdir(), "ens-reg-"));
  const paths = writeRegistrationFiles(cfg, out);
  assert.deepEqual(readdirSync(out).sort(), ["coder-0.json", "coder-1.json", "coder-2.json"]);
  assert.equal(paths.length, 3);
  const f = JSON.parse(readFileSync(join(out, "coder-1.json"), "utf8"));
  assert.deepEqual(f.registrations, [{ agentId: 3, agentRegistry: `eip155:84532:${cfg.chain.identity}` }]);
  assert.equal(f.services[0].endpoint, "coder-1.mergit.eth");
});

test("with ids disabled (HLD 8.1 step 1, before registerAgent) the files carry no registrations at all", () => {
  const cfg = loadConfig(EXAMPLE, { allowTestAddresses: true });
  const out = mkdtempSync(join(tmpdir(), "ens-reg-pre-"));
  writeRegistrationFiles(cfg, out, { withIds: false });
  for (const label of ["coder-0", "coder-1", "coder-2"]) {
    const f = JSON.parse(readFileSync(join(out, `${label}.json`), "utf8"));
    assert.equal("registrations" in f, false, label);
    assert.equal(f.services[0].endpoint, `${label}.mergit.eth`);
  }
});
