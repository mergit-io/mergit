import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeContext } from "./context";
import {
  DARK_QUERY,
  STORAGE_KEY,
  currentTheme,
  fadeTo,
  persistTheme,
  revealTo,
  storedTheme,
  systemTheme,
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
      if (event.key === STORAGE_KEY || event.key === null) follow(storedTheme() ?? systemTheme());
    };
    // The OS switched. Only matters while the user has not picked a theme here.
    const media = window.matchMedia(DARK_QUERY);
    const onSystem = () => {
      if (storedTheme() === null) follow(systemTheme());
    };

    window.addEventListener("storage", onStorage);
    media.addEventListener("change", onSystem);
    return () => {
      window.removeEventListener("storage", onStorage);
      media.removeEventListener("change", onSystem);
    };
  }, []);

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
