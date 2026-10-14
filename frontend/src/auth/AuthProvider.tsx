import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { paths } from "../app/paths";
import { prefersReducedMotion } from "../lib/motion";
import { AuthContext } from "./context";
import { readSession, writeSession, type Session } from "./session";
import { SignOutSplash } from "./SignOutSplash";

/** Sign-out splash timing, from the landing design video: fade in, hold, then hand over to the landing page. */
const SPLASH = { holdMs: 1700, reducedHoldMs: 500, fadeOutMs: 450 };

type SplashPhase = "hidden" | "in" | "out";

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(readSession);
  const [splash, setSplash] = useState<SplashPhase>("hidden");
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((t) => {
        window.clearTimeout(t);
      });
    },
    [],
  );

  const signIn = useCallback((next: Session) => {
    writeSession(next);
    setSession(next);
  }, []);

  const signOut = useCallback(() => {
    // The splash covers the dashboard; the session ends behind it, then the
    // splash fades away over the landing page.
    setSplash("in");
    const reduced = prefersReducedMotion();
    const hold = reduced ? SPLASH.reducedHoldMs : SPLASH.holdMs;
    timers.current.push(
      window.setTimeout(() => {
        void navigate(paths.landing);
        writeSession(null);
        setSession(null);
        setSplash("out");
      }, hold),
      window.setTimeout(
        () => {
          setSplash("hidden");
        },
        hold + (reduced ? 0 : SPLASH.fadeOutMs),
      ),
    );
  }, [navigate]);

  // The dashboard routes show the Connect window themselves while signed out,
  // so opening it is just a navigation.
  const openConnect = useCallback(
    (next: string = paths.app) => {
      void navigate(next);
    },
    [navigate],
  );

  const value = useMemo(() => ({ session, signIn, signOut, openConnect }), [session, signIn, signOut, openConnect]);
  return (
    <AuthContext.Provider value={value}>
      {children}
      {splash !== "hidden" && <SignOutSplash leaving={splash === "out"} />}
    </AuthContext.Provider>
  );
}
