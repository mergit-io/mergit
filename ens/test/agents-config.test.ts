import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The web app shows an agent under the ENS label equal to its platform name (frontend/src/chain/ens/names.ts,
// labelForAgent: it never rewrites a name), so the label registered on mainnet must be the platform name, or every
// badge reads "not verified". These tests read the real config files of the repository.
const here = new URL(".", import.meta.url).pathname;
const agents = JSON.parse(readFileSync(join(here, "..", "agents.json"), "utf8")).agents as { label: string; name: string; profileUrl: string; agentId?: number }[];
const toml = readFileSync(join(here, "..", "..", "control-plane", "agents.toml"), "utf8");
const platformNames = new Set([...toml.matchAll(/^\[agents\.([a-z0-9-]+)\]/gm)].map((m) => m[1]!));
const registrations = join(here, "..", "..", "frontend", "public", "registrations");
const files = readdirSync(registrations).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(registrations, f), "utf8")));

test("every ENS label in agents.json is the name of an agent the platform runs (agents.toml)", () => {
  assert.ok(agents.length > 0);
  for (const a of agents) assert.ok(platformNames.has(a.label), `${a.label} is not an agent in control-plane/agents.toml (have: ${[...platformNames].join(", ")})`);
});

test("each agent's name and public page use the same label, and a registration file names that ENS name back", () => {
  for (const a of agents) {
    assert.equal(a.name, a.label);
    assert.equal(a.profileUrl, `https://mergit.site/agents/${a.label}.mergit.eth`);
    const file = files.find((f) => f.services?.some((s: { name: string; endpoint: string }) => s.name === "ENS" && s.endpoint === `${a.label}.mergit.eth`));
    assert.ok(file, `no file in frontend/public/registrations names ${a.label}.mergit.eth`);
    if (a.agentId !== undefined) assert.deepEqual(file.registrations?.map((r: { agentId: number }) => r.agentId), [a.agentId]);
  }
});
