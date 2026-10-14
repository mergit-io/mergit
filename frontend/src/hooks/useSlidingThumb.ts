import { useLayoutEffect, useState, type RefObject } from "react";

type Thumb = { x: number; w: number };

/**
 * Position of the pill that slides under the selected item of a tab group or
 * segmented control. Re-measures when `key` changes and when items resize,
 * which happens once web fonts load.
 */
export function useSlidingThumb(ref: RefObject<HTMLElement | null>, selector: string, key: unknown): Thumb | null {
  const [thumb, setThumb] = useState<Thumb | null>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>(selector);
      const next = el ? { x: el.offsetLeft, w: el.offsetWidth } : null;
      setThumb((prev) => (prev?.x === next?.x && prev?.w === next?.w ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    // Watch the items, not the thumb itself: its width animates.
    for (const item of Array.from(root.querySelectorAll(":scope > :not([data-thumb])"))) ro.observe(item);
    return () => {
      ro.disconnect();
    };
  }, [ref, selector, key]);

  return thumb;
}
