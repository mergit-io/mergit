import { flushSync } from "react-dom";

export type Theme = "light" | "dark";

/** Must match the inline boot script in index.html. */
export const STORAGE_KEY = "mergit-theme";
/** What a first-time visitor gets, whatever their OS setting. Must match the inline boot script in index.html. */
export const DEFAULT_THEME: Theme = "light";
const FADE_CLASS = "theme-fade";
const FADE_MS = 320;

export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * Remember an explicit choice. Picking the default theme clears the override,
 * so the stored value only ever means "the visitor chose dark".
 */
export function persistTheme(theme: Theme) {
  try {
    if (theme === DEFAULT_THEME) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode or blocked storage: the switch still works for this page.
  }
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function setAttribute(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** Ends a fade still in progress, so a quick second switch starts clean. */
let endFade: (() => void) | null = null;

/** Cross-fade every colour for a moment. Used for changes that did not come from a click. */
export function fadeTo(theme: Theme, commit: () => void) {
  const root = document.documentElement;
  if (prefersReducedMotion()) {
    setAttribute(theme);
    commit();
    return;
  }
  endFade?.();
  root.classList.add(FADE_CLASS);
  setAttribute(theme);
  commit();

  // Drop the class when the page colour has actually finished moving. A fixed
  // timer alone races the transition and can cut it short on a busy main thread.
  const body = document.body;
  const finish = () => {
    window.clearTimeout(fallback);
    body.removeEventListener("transitionend", onEnd);
    root.classList.remove(FADE_CLASS);
    endFade = null;
  };
  const onEnd = (event: TransitionEvent) => {
    if (event.target === body && event.propertyName === "background-color") finish();
  };
  const fallback = window.setTimeout(finish, FADE_MS + 200);
  body.addEventListener("transitionend", onEnd);
  endFade = finish;
}

/**
 * Switch with a circular reveal that grows from the toggle. Falls back to the
 * cross-fade where the View Transitions API is missing.
 */
export function revealTo(theme: Theme, origin: { x: number; y: number }, commit: () => void) {
  if (prefersReducedMotion() || typeof document.startViewTransition !== "function") {
    fadeTo(theme, commit);
    return;
  }
  const { x, y } = origin;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const transition = document.startViewTransition(() => {
    flushSync(() => {
      setAttribute(theme);
      commit();
    });
  });
  transition.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: 560,
          easing: "cubic-bezier(0.3, 0.7, 0.2, 1)",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => {
      // Transition skipped (tab hidden, another transition started). The theme is already set.
    });
}
