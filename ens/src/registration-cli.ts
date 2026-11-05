import { loadConfig } from "./config.ts";
import { writeRegistrationFiles } from "./registration-files.ts";

const withIds = !process.argv.includes("--without-ids");
const [configPath, outDir] = process.argv.slice(2).filter((a) => a !== "--without-ids");
if (!configPath || !outDir) { console.error("usage: node src/registration-cli.ts <config.json> <outDir> [--without-ids]"); process.exit(1); }
try {
  // publisher and editor are not used here, so test addresses in an example config are fine
  const paths = writeRegistrationFiles(loadConfig(configPath, { allowTestAddresses: true }), outDir, { withIds });
  for (const p of paths) console.log(p);
} catch (e) { console.error((e as Error).message); process.exit(1); }
