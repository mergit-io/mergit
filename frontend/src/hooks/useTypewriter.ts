import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../lib/motion";

/**
 * Types `text` out once `start` is true. Reduced motion shows it whole.
 * Returns the visible text and whether typing has finished.
 */
export function useTypewriter(text: string, start: boolean, msPerChar = 38, delay = 0) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!start) return;
    if (prefersReducedMotion()) {
      setCount(text.length);
      return;
    }
    let i = 0;
    let timer = window.setTimeout(function tick() {
      i += 1;
      setCount(i);
      if (i < text.length) timer = window.setTimeout(tick, msPerChar);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [text, start, msPerChar, delay]);
  return [text.slice(0, count), count >= text.length] as const;
}
