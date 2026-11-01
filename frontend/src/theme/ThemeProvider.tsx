import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeContext } from "./context";
import {
  DEFAULT_THEME,
  STORAGE_KEY,
  currentTheme,
  fadeTo,
  persistTheme,
  revealTo,
  storedTheme,
  type Theme,
} from "./theme";

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The boot script in index.html already set the attribute, so read it instead of recomputing.
  const [theme, setTheme] = useState<Theme>(currentTheme);

  const toggle = useCallback((origin?: { x: number; y: number }) => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    persistTheme(next);
    const commit = () => {
      setTheme(next);
    };
    if (origin) revealTo(next, origin, commit);
    else fadeTo(next, commit);
  }, []);

  useEffect(() => {
    const follow = (next: Theme) => {
      if (next !== currentTheme()) {
        fadeTo(next, () => {
          setTheme(next);
        });
      }
    };

    // Another tab changed the setting.
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) follow(storedTheme() ?? DEFAULT_THEME);
    };

    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
