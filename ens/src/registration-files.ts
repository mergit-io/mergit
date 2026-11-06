import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OneShotConfig } from "./oneshot.ts";
import { registrationFile, serializeRegistration } from "./registration.ts";

/**
 * Writes `<label>.json` for every agent, for the user to host (O5). By default the registration (agent id) is listed;
 * `withIds: false` leaves it out, for the file that must exist before `registerAgent` (HLD 8.1 step 1). Returns the paths.
 */
export function writeRegistrationFiles(cfg: OneShotConfig, outDir: string, opts: { withIds?: boolean } = {}): string[] {
  mkdirSync(outDir, { recursive: true });
  return cfg.agents.map((a) => {
    const path = join(outDir, `${a.label}.json`);
    writeFileSync(path, serializeRegistration(registrationFile(opts.withIds === false ? { ...a, agentId: undefined } : a, cfg.chain)));
    return path;
  });
}
