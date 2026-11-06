import type { AgentEns } from "./agentEns.ts";

/** Reads one agent's ENS state (the live loader is `loadAgentEns` bound to the app's clients and config). */
export type EnsLoader = (agent: { agentId: bigint; label: string }) => Promise<AgentEns>;

/**
 * Puts a bound and a short cache in front of `load`, so a list page of N agents does not fire N times nine reads at
 * once on every mount: at most `concurrency` loads run at a time (the rest wait their turn), concurrent calls for the
 * same agent share one load, and a result is reused for `ttlMs`. A failed load is not kept, so the next call retries.
 * Results are keyed by label and agent id together, so two agents never share a value.
 */
export function cachedEns(
  load: EnsLoader,
  opts: { ttlMs?: number; concurrency?: number; now?: () => number } = {},
): EnsLoader {
  const ttlMs = opts.ttlMs ?? 60_000;
  const limit = Math.max(1, Math.floor(opts.concurrency ?? 3));
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: Promise<AgentEns>; expires: number }>();
  let active = 0;
  const waiting: (() => void)[] = [];

  async function run(agent: { agentId: bigint; label: string }): Promise<AgentEns> {
    // A finishing load hands its slot straight to the next waiter, so `active` never goes over the limit.
    if (active < limit) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await load(agent);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  return (agent) => {
    const key = `${agent.label}:${String(agent.agentId)}`;
    const t = now();
    const hit = cache.get(key);
    if (hit && t < hit.expires) return hit.value;
    for (const [k, entry] of cache) if (entry.expires <= t) cache.delete(k);

    const entry = { value: run(agent), expires: Number.POSITIVE_INFINITY };
    cache.set(key, entry);
    entry.value.then(
      () => {
        if (cache.get(key) === entry) entry.expires = now() + ttlMs;
      },
      () => {
        if (cache.get(key) === entry) cache.delete(key);
      },
    );
    return entry.value;
  };
}
