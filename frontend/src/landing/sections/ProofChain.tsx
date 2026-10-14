import { useEffect, useState } from "react";
import { FIRST_BLOCK } from "../content";
import { LIcon } from "../LIcon";
import { prefersReducedMotion } from "../motion";

const VISIBLE = 6;
const BLOCK_MS = 1600;

/** A strip of settled blocks that moves along like a chain as new proofs land. */
export function ProofChain({ start }: { start: boolean }) {
  const [head, setHead] = useState(FIRST_BLOCK + 6);

  useEffect(() => {
    if (!start || prefersReducedMotion()) return;
    const timer = window.setInterval(() => {
      setHead((h) => h + 1);
    }, BLOCK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [start]);

  // One extra block on the left, fading out as the row shifts.
  const blocks = Array.from({ length: VISIBLE + 1 }, (_, i) => head - VISIBLE + i);

  return (
    <div className="proof-chain" aria-label={`Latest settled block ${head.toLocaleString("en-US")}`} role="img">
      <div className="proof-chain-track" key={head}>
        {blocks.map((n, i) => (
          <div key={n} className={`proof-block${i === blocks.length - 1 ? " fresh" : ""}${i === 0 ? " leaving" : ""}`}>
            <span className={`proof-tile ${n % 2 ? "purple" : "green"}`}>
              <LIcon name="cube" size={22} stroke={1.5} />
            </span>
            <span className="proof-num">#{n.toLocaleString("en-US")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
