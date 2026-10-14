import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../lib/motion";

/** Eases from 0 to `target` over `ms` once `start` is true. Reduced motion shows the target. */
export function useCountUp(target: number, ms = 1200, start = true) {
  // Reduced motion starts (and stays) at the target, so no animation runs.
  const [reduced] = useState(prefersReducedMotion);
  const [value, setValue] = useState(reduced ? target : 0);
  useEffect(() => {
    if (!start || reduced) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      setValue(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [target, ms, start, reduced]);
  return reduced ? target : value;
}
