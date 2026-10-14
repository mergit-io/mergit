import { createContext, useContext } from "react";
import type { Theme } from "./theme";

type ThemeContextValue = {
  theme: Theme;
  /** Flip the theme. Pass the click point to grow the reveal from there. */
  toggle: (origin?: { x: number; y: number }) => void;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
