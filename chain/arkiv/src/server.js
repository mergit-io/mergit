// The one thing this sidecar exists for: a single `executeBatch` write per call, so every task's
// routing decision for one `explore=true` suggestions call lands in ONE transaction, not one per
// task. Reads never come through here — they're plain JSON-RPC `arkiv_query` calls the control
// plane makes itself (see control-plane/mergit_cp/arkiv_mirror.py); only a write needs real
// transaction encoding, which only the JS SDK demonstrably supports against Rabdi (verified live:
// the Python `arkiv-sdk` targets a different, incompatible processor address/query shape).
//
// The private key lives only here, never in the control plane's own process or env.
import { createServer } from "node:http";
import { createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { u64 } from "@arkiv-network/sdk/schema";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RoutingDecision } from "./schema.js";

const PORT = Number(process.env.PORT ?? 8088);
const ACCESS_KEY = process.env.ARKIV_ACCESS_KEY ?? "";
const PRIVATE_KEY = process.env.ARKIV_PRIVATE_KEY;
const TOKEN = process.env.ARKIV_SIDECAR_TOKEN;

if (!PRIVATE_KEY) throw new Error("ARKIV_PRIVATE_KEY is required");
if (!TOKEN) throw new Error("ARKIV_SIDECAR_TOKEN is required");

// MetaMask's "Show private key" exports 64 hex characters without the 0x prefix viem requires; the
// first live deploy crash-looped on exactly that. Accept either form, and say clearly what is wrong
// with anything else instead of dying on viem's own error.
const key = PRIVATE_KEY.trim().startsWith("0x") ? PRIVATE_KEY.trim() : `0x${PRIVATE_KEY.trim()}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  throw new Error("ARKIV_PRIVATE_KEY must be 64 hex characters, with or without a 0x prefix");
}
const account = privateKeyToAccount(key);

// u64 fields must arrive as decimal strings. A JSON number past 2^53 has already been rounded by
// JSON.parse before this code sees it (a 62-bit seed landed on chain 15 off), and a wrong seed makes
// the draw impossible to replay, so refuse it rather than store it.
function u64Of(value, name) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TypeError(`${name} must be a decimal string, got ${JSON.stringify(value)}`);
  }
  return u64(BigInt(value));
}
const walletClient = createWalletClient({
  account,
  chain: rabdi({ accessKey: ACCESS_KEY }),
  transport: viemHttp(),
});

// Serializes every write through this one account: two concurrent explore calls (different plans,
// different HTTP requests) must not send two transactions with the same nonce. A single-process
// promise chain is enough for one service wallet; it is not meant to survive a second replica.
let queue = Promise.resolve();
function enqueue(fn) {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method !== "POST" || req.url !== "/internal/mirror") {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    send(res, 400, { error: "invalid json" });
    return;
  }

  const { decisions, ttl_days: ttlDays } = payload;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    send(res, 400, { error: "decisions must be a non-empty array" });
    return;
  }

  let creates;
  try {
    creates = decisions.map((d) => ({
      schema: RoutingDecision,
      values: {
        planId: d.plan_id,
        decisionId: u64Of(d.decision_id, "decision_id"),
        taskIndex: d.task_index,
        category: d.category,
        seed: u64Of(d.seed, "seed"),
        budgetMicros: u64Of(d.budget_micros, "budget_micros"),
        decidedAt: d.decided_at,
        body: new TextEncoder().encode(JSON.stringify({ candidates: d.candidates, picks: d.picks })),
      },
      expiration: ExpirationTime.fromDays(ttlDays ?? 30),
    }));
  } catch (err) {
    send(res, 400, { error: String(err?.message ?? err) });
    return;
  }

  try {
    const { txHash, createdEntities } = await enqueue(() => walletClient.executeBatch({ creates }));
    // `createdEntities` is already `Hex[]` (the SDK's own type), not objects with a `.key` — an
    // earlier version mapped `.key` off each string here, which silently produced `[null, ...]`.
    send(res, 200, { tx_hash: txHash, entity_keys: createdEntities });
  } catch (err) {
    send(res, 502, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`arkiv sidecar listening on :${PORT}, wallet ${account.address}`);
});
