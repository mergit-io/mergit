import { describe, expect, it } from "vitest";
import type { AgentEns } from "./agentEns.ts";
import { cachedEns, type EnsLoader } from "./ensCache.ts";

type Agent = Parameters<EnsLoader>[0];

const result = (agent: Agent): AgentEns => ({
  name: `${agent.label}.mergit.eth`,
  agentId: agent.agentId,
  parentOwner: null,
  resolver: null,
  records: { context: null, endpointWeb: null, registration: null },
  verification: { status: "verified" },
  operator: { state: "current", onBase: null, onEns: null },
  mirror: { status: "absent" },
  badge: "verified",
  unreadable: [],
});

/** A loader whose calls stay pending until the test settles them, counting calls and how many run at once. */
function manual() {
  const pending: { agent: Agent; resolve: (v: AgentEns) => void; reject: (e: Error) => void }[] = [];
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const load: EnsLoader = (agent) => {
    stats.calls++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    return new Promise<AgentEns>((resolve, reject) => {
      pending.push({
        agent,
        resolve: (v) => {
          stats.inFlight--;
          resolve(v);
        },
        reject: (e) => {
          stats.inFlight--;
          reject(e);
        },
      });
    });
  };
  const settleNext = async () => {
    const p = pending.shift();
    p?.resolve(result(p.agent));
    await flush();
  };
  return { load, stats, pending, settleNext };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const A = { agentId: 1n, label: "coder-0" };
const B = { agentId: 2n, label: "coder-1" };

describe("cachedEns", () => {
  it("calls the loader once for two concurrent calls for one agent", async () => {
    const m = manual();
    const get = cachedEns(m.load);
    const first = get(A);
    const second = get(A);
    await flush();
    expect(m.stats.calls).toBe(1);
    await m.settleNext();
    expect(await first).toBe(await second);
  });

  it("serves a second call within the TTL from the cache, and reloads after it", async () => {
    let t = 1_000;
    let calls = 0;
    const get = cachedEns(
      (agent) => {
        calls++;
        return Promise.resolve(result(agent));
      },
      { ttlMs: 60_000, now: () => t },
    );
    await get(A);
    t += 59_999;
    await get(A);
    expect(calls).toBe(1);
    t += 2;
    await get(A);
    expect(calls).toBe(2);
  });

  it("does not cache a rejected load, so the next call retries", async () => {
    let calls = 0;
    const get = cachedEns((agent) => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("rpc down")) : Promise.resolve(result(agent));
    });
    await expect(get(A)).rejects.toThrow("rpc down");
    await expect(get(A)).resolves.toMatchObject({ name: "coder-0.mergit.eth" });
    expect(calls).toBe(2);
  });

  it("keeps at most `concurrency` loads in flight and still finishes every one", async () => {
    const m = manual();
    const get = cachedEns(m.load, { concurrency: 2 });
    const agents = [0, 1, 2, 3, 4].map((i) => ({ agentId: BigInt(i), label: `coder-${String(i)}` }));
    const all = Promise.all(agents.map((a) => get(a)));
    await flush();
    expect(m.stats.calls).toBe(2);
    for (let i = 0; i < 5; i++) {
      expect(m.stats.inFlight).toBeLessThanOrEqual(2);
      await m.settleNext();
    }
    const values = await all;
    expect(m.stats.calls).toBe(5);
    expect(m.stats.maxInFlight).toBe(2);
    expect(values.map((v) => v.name)).toEqual(agents.map((a) => `${a.label}.mergit.eth`));
  });

  it("frees the slot of a failed load for the next one", async () => {
    const m = manual();
    const get = cachedEns(m.load, { concurrency: 1 });
    const first = get(A);
    const second = get(B);
    await flush();
    expect(m.stats.calls).toBe(1);
    m.pending.shift()?.reject(new Error("rpc down"));
    await expect(first).rejects.toThrow();
    await flush();
    expect(m.stats.calls).toBe(2);
    await m.settleNext();
    await expect(second).resolves.toMatchObject({ agentId: 2n });
  });

  it("keys results by label and agent id, so two agents never share a value", async () => {
    let calls = 0;
    const get = cachedEns((agent) => {
      calls++;
      return Promise.resolve(result(agent));
    });
    const sameLabel = await get({ agentId: 9n, label: "coder-0" });
    const sameId = await get({ agentId: 1n, label: "coder-9" });
    const a = await get(A);
    expect(calls).toBe(3);
    expect(a.agentId).toBe(1n);
    expect(a.name).toBe("coder-0.mergit.eth");
    expect(sameLabel.agentId).toBe(9n);
    expect(sameId.name).toBe("coder-9.mergit.eth");
  });
});
