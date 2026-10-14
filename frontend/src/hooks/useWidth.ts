import { useLayoutEffect, useRef, useState } from "react";

/**
 * Content width of the element the ref is attached to, kept current as it
 * resizes. Lets an SVG chart redraw at its real width instead of scaling its
 * strokes and labels. Starts at `fallback` until the first measurement.
 */
export function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = Math.floor(el.clientWidth);
      if (next > 0) setWidth(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  return [ref, width] as const;
}
