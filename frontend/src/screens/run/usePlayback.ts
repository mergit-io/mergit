import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../../lib/motion";
import type { LogEntry, RunTask, Status } from "../../mock/data";

/** Wall-clock length of the replay, in ms: the video plays the 134s run at about 20x. */
const REPLAY_MS = 6700;
const TICK_MS = 100;

/**
 * Replays a finished run from 0 to `total` seconds once, as the design video
 * does when the run opens. Reduced motion jumps straight to the end.
 */
export function usePlayback(total: number) {
  const [reduced] = useState(prefersReducedMotion);
  const [elapsed, setElapsed] = useState(reduced ? total : 0);

  useEffect(() => {
    if (reduced) return;
    const t0 = performance.now();
    const timer = window.setInterval(() => {
      const next = Math.min(total, ((performance.now() - t0) / REPLAY_MS) * total);
      setElapsed(next);
      if (next >= total) window.clearInterval(timer);
    }, TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [total, reduced]);

  return elapsed;
}

/** A task's status at `elapsed` seconds into the run. Neutral = not started yet. */
export function statusAt(task: RunTask, elapsed: number): Status {
  if (elapsed < task.start) return "Neutral";
  if (elapsed < task.start + task.seconds) return "Running";
  return "Completed";
}

export const logSeconds = (entry: LogEntry) => {
  const [m = "0", s = "0"] = entry.t.split(":");
  return Number(m) * 60 + Number(s);
};

export const clock = (seconds: number) => {
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60))}m ${String(s % 60).padStart(2, "0")}s`;
};
