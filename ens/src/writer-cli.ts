import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, mainnet } from "viem/chains";
import { memoryNonceStore } from "./edit-request.ts";
import { newOutcomeCache, publishPass } from "./publisher.ts";
import { loadWriterConfig, parseWriterEnv, redact } from "./writer-env.ts";
import { newServiceState, startService } from "./writer-service.ts";

// The writer service: POST /edit (operator-signed edits, written with the editor key) and a periodic publish pass
// (reputation mirror and operator record, written with the publisher key). See ens/RUNBOOK.md.
let secrets: string[] = [];
const log = (m: string) => console.error(`[${new Date().toISOString()}] ${redact(m, secrets)}`);

try {
  const env = parseWriterEnv(process.env);
  secrets = [env.ensRpc, env.baseRpc, env.publisherKey, env.editorKey];
  const cfg = loadWriterConfig(env.configPath);
  const base = createPublicClient({ chain: baseSepolia, transport: http(env.baseRpc) }) as PublicClient;
  const ens = createPublicClient({ chain: mainnet, transport: http(env.ensRpc) }) as PublicClient;
  const publisher = privateKeyToAccount(env.publisherKey);
  const editor = privateKeyToAccount(env.editorKey);
  const cache = newOutcomeCache(cfg.fromBlock);

  const svc = await startService({
    base: base as never, ens: ens as never, wallet: createWalletClient({ account: editor, chain: mainnet, transport: http(env.ensRpc) }) as never,
    identity: cfg.chain.identity, chainId: cfg.chain.chainId, resolver: cfg.resolver, agents: cfg.agents,
    seenNonces: memoryNonceStore(), startedAt: Math.floor(Date.now() / 1000), now: () => Math.floor(Date.now() / 1000), secrets, log,
    state: newServiceState(), limits: { perAgentPerHour: env.editsPerAgentPerHour, perHour: env.editsPerHour, requestsPerMinute: env.requestsPerMinute },
    port: env.port, intervalSeconds: env.intervalSeconds,
    publish: async () => {
      const r = await publishPass({ base, ens, wallet: createWalletClient({ account: publisher, chain: mainnet, transport: http(env.ensRpc) }) }, cfg, cache);
      log(`publish pass: Base block ${r.asOfBlock}, ${r.changed.length} record(s) changed${r.hash ? `, tx ${r.hash}` : ""}`);
    },
  });
  log(`writer service on 127.0.0.1:${svc.port}; publisher ${publisher.address}; editor ${editor.address}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void svc.close().then(() => process.exit(0)); });
} catch (e) {
  console.error(redact((e as Error).message, secrets));
  process.exit(1);
}
