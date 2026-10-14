import type { CSSProperties } from "react";

/** Inline style for a `.rise` item: it enters `index` steps after the first. */
export function stagger(index: number, style?: CSSProperties): CSSProperties {
  return { ...style, "--i": index } as CSSProperties;
}
