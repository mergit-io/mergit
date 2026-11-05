import { createServer } from "node:http";
import type { Address, Hex } from "viem";
import { permissionedResolverAbi } from "./abi/permissionedResolver.ts";
import { dnsName } from "./dns.ts";
import { EditRefused, verifyEdit, type EditRequest, type NonceStore } from "./edit-request.ts";
import { agentRegistrationKey } from "./ensip25.ts";
import { ensNameOf } from "./registration.ts";
import { readTextRecord } from "./resolver-read.ts";
import { redact } from "./writer-env.ts";

export type EditDeps = {
  base: { readContract(args: { address: Address; abi: readonly unknown[]; functionName: "operatorOf"; args: readonly unknown[] }): Promise<unknown> };
  ens: { waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: string }>; readContract(args: any): Promise<unknown> };
  wallet: { writeContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<Hex> };
  identity: Address; chainId: number; resolver: Address;
  agents: { label: string; agentId: number }[];
  seenNonces: NonceStore; startedAt: number; now(): number;
  state: ServiceState; limits: Limits;
  secrets: string[]; log(message: string): void;
};

/** What the service remembers between requests: a lock so the one editor account sends one transaction at a time, and sliding-window counters. */
export type ServiceState = { lock: Promise<void>; edits: Map<number, number[]>; allEdits: number[]; requests: number[] };
export const newServiceState = (): ServiceState => ({ lock: Promise.resolve(), edits: new Map(), allEdits: [], requests: [] });
/** Caps on what the hot editor key can spend (per agent and in total per hour) and on requests per minute (each valid-looking one costs an RPC read). */
export type Limits = { perAgentPerHour: number; perHour: number; requestsPerMinute: number };

async function serialized<T>(st: ServiceState, work: () => Promise<T>): Promise<T> {
  const previous = st.lock;
  let release!: () => void;
  st.lock = new Promise<void>((r) => { release = r; });
  await previous;
  try { return await work(); } finally { release(); }
}
export type EditResult = { status: number; body: object };

const MAX_BODY_BYTES = 16 * 1024;

/** Handles one edit request: verify the signature and the operator on Base, then write the record with the editor key. Refusals send nothing. */
export async function handleEdit(raw: unknown, deps: EditDeps): Promise<EditResult> {
  const fail = (status: number, error: string): EditResult => ({ status, body: { error } });
  const t = deps.now();
  deps.state.requests = deps.state.requests.filter((x) => x > t - 60);
  if (deps.state.requests.length >= deps.limits.requestsPerMinute) return fail(429, "too many requests");
  deps.state.requests.push(t);
  if (!raw || typeof raw !== "object") return fail(400, "body must be a JSON object");
  const { request, signature } = raw as { request?: unknown; signature?: unknown };
  if (!request || typeof request !== "object") return fail(400, "request is required");
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return fail(400, "signature must be a 0x-prefixed hex string");
  const req = request as EditRequest;
  const agent = Number.isSafeInteger(req.agentId) ? deps.agents.find((a) => a.agentId === req.agentId) : undefined;
  if (Number.isSafeInteger(req.agentId) && !agent) return fail(404, "unknown agent");
  try {
    const { operator } = await verifyEdit(req, signature as Hex, { base: deps.base, identity: deps.identity, chainId: deps.chainId, now: deps.now(), seenNonces: deps.seenNonces, startedAt: deps.startedAt });
    const name = ensNameOf(agent!.label);
    // one transaction at a time from the editor account; the budget check, the registration check and the write are one critical section
    return await serialized(deps.state, async (): Promise<EditResult> => {
      const now = deps.now();
      const mine = (deps.state.edits.get(agent!.agentId) ?? []).filter((x) => x > now - 3600);
      deps.state.allEdits = deps.state.allEdits.filter((x) => x > now - 3600);
      if (mine.length >= deps.limits.perAgentPerHour || deps.state.allEdits.length >= deps.limits.perHour) return fail(429, "edit limit reached; try again later");
      const regKey = agentRegistrationKey(deps.identity, deps.chainId, agent!.agentId);
      if (!(await readTextRecord(deps.ens, deps.resolver, name, regKey))) {
        deps.log(redact(`agent ${agent!.agentId}: ${name} has no ${regKey} record; edits refused (wrong label or agent id in the config?)`, deps.secrets));
        return fail(503, "agent is not set up for edits");
      }
      mine.push(now); deps.state.edits.set(agent!.agentId, mine); deps.state.allEdits.push(now); // counted when sent: the gas is spent even if it reverts
      const hash = await deps.wallet.writeContract({ address: deps.resolver, abi: permissionedResolverAbi, functionName: "setText", args: [dnsName(name), req.key, req.value] });
      const receipt = await deps.ens.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
      return { status: 200, body: { ok: true, hash, operator, name } };
    });
  } catch (e) {
    if (e instanceof EditRefused) return fail(e.status, e.message);
    deps.log(redact(`edit failed: ${(e as Error).message}`, deps.secrets));
    return fail(500, "internal error");
  }
}

/** The HTTP service: POST /edit, GET /healthz, and a publish pass at start and then every `intervalSeconds`. A failing pass is logged (redacted) and retried. */
export async function startService(deps: EditDeps & { port: number; intervalSeconds: number; publish?: () => Promise<unknown> }): Promise<{ port: number; close(): Promise<void> }> {
  const json = (res: import("node:http").ServerResponse, status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
      if (req.method === "POST" && path === "/edit") {
        const chunks: Buffer[] = []; let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY_BYTES) { json(res, 413, { error: "body too large" }); req.destroy(); return; }
          chunks.push(c as Buffer);
        }
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "body must be valid JSON" }); }
        const r = await handleEdit(parsed, deps);
        return json(res, r.status, r.body);
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      deps.log(redact(`request failed: ${(e as Error).message}`, deps.secrets));
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(deps.port, "127.0.0.1", () => resolve()); });

  let running = false;
  const pass = async () => {
    if (running || !deps.publish) return;
    running = true;
    try { await deps.publish(); } catch (e) { deps.log(redact(`publish pass failed: ${(e as Error).message}`, deps.secrets)); } finally { running = false; }
  };
  void pass();
  const timer = setInterval(() => void pass(), deps.intervalSeconds * 1000);
  timer.unref();
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => { clearInterval(timer); server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
