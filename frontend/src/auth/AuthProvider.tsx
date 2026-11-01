import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { paths } from "../app/paths";
import { prefersReducedMotion } from "../lib/motion";
import { AuthContext } from "./context";
import type { Address } from "viem";
import { onSessionEnded } from "../api/client";
import { signOutLive, watchAccount } from "../chain/wallet";
import { DATA_MODE, IN_DEMO } from "../config/live";
import {
  fetchAccount,
  isTrialSession,
  sameAddress,
  sessionFromAccount,
  type Account,
  type AccountCheck,
} from "./account";
import { demoSession, readSession, writeSession, type Session } from "./session";
import { SignOutSplash } from "./SignOutSplash";

/** Sign-out splash timing, from the landing design video: fade in, hold, then hand over to the landing page. */
const SPLASH = { holdMs: 1700, reducedHoldMs: 500, fadeOutMs: 450 };

type SplashPhase = "hidden" | "in" | "out";

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  // The demo needs no sign-in: it opens signed in as the sample account. (Signing out ends it and returns to the home
  // page.) Everywhere else the remembered session, if there is one.
  const [session, setSession] = useState<Session | null>(() =>
    IN_DEMO ? (readSession() ?? demoSession("browser")) : readSession(),
  );
  const [account, setAccount] = useState<Account | null>(null);
  // On live data the server is asked once, at load, whether this browser already holds a session cookie (it does
  // after GitHub or Google sends the browser back). Until then the dashboard must not offer the Connect window.
  const [ready, setReady] = useState(DATA_MODE !== "live");
  const [splash, setSplash] = useState<SplashPhase>("hidden");
  const timers = useRef<number[]>([]);
  const sessionRef = useRef(session);
  const asked = useRef(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

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

  const endSession = useCallback(() => {
    writeSession(null);
    setSession(null);
    setAccount(null);
  }, []);

  // The server is the truth about who is signed in. A session it does not know ends here; one it describes
  // differently (a wallet was connected, or the cookie belongs to someone else) replaces what the browser remembered.
  const adopt = useCallback(
    (check: AccountCheck) => {
      if (check.status === "expired") {
        endSession();
        return;
      }
      if (check.status !== "valid") return; // the API cannot be asked: keep what the browser remembers
      setAccount(check.account);
      const current = sessionRef.current;
      if (current && sameAddress(current.address, check.account.address)) return;
      const next = sessionFromAccount(check.account, current?.since);
      writeSession(next);
      setSession(next);
    },
    [endSession],
  );

  const refreshAccount = useCallback(async () => {
    if (DATA_MODE !== "live") return;
    adopt(await fetchAccount());
  }, [adopt]);

  const signOut = useCallback(() => {
    if (DATA_MODE === "live") void signOutLive();
    // The splash covers the dashboard; the session ends behind it, then the
    // splash fades away over the landing page.
    setSplash("in");
    const reduced = prefersReducedMotion();
    const hold = reduced ? SPLASH.reducedHoldMs : SPLASH.holdMs;
    timers.current.push(
      window.setTimeout(() => {
        void navigate(paths.landing);
        endSession();
        setSplash("out");
      }, hold),
      window.setTimeout(
        () => {
          setSplash("hidden");
        },
        hold + (reduced ? 0 : SPLASH.fadeOutMs),
      ),
    );
  }, [navigate, endSession]);

  // On live data the remembered session must still exist on the server: its cookie expires after 12 hours and
  // does not survive the API losing its database. Asked at load, and again when the session's address changes (a
  // wallet was connected). A signed-out browser is not asked again: only `refreshAccount` restores a session.
  const address = session?.address ?? null;
  useEffect(() => {
    if (DATA_MODE !== "live") return;
    if (address === null && asked.current) return;
    asked.current = true;
    let cancelled = false;
    let answered = false;
    void fetchAccount().then((check) => {
      if (cancelled) return;
      answered = true;
      adopt(check);
      setReady(true);
    });
    return () => {
      cancelled = true;
      // Cancelled before the server answered (React StrictMode runs effects twice in development): ask again,
      // or `ready` would never become true and the Connect window would never open.
      if (!answered) asked.current = false;
    };
  }, [address, adopt]);

  // Any API call that comes back 401 means the server dropped the session since the check above: end it here too,
  // quietly (no sign-out splash, which is for someone choosing to leave).
  useEffect(() => {
    if (DATA_MODE !== "live") return;
    onSessionEnded(endSession);
    return () => {
      onSessionEnded(null);
    };
  }, [endSession]);

  // On live data, a different wallet account ends the session: the signed-in address must be the one that funds.
  // A session with no wallet (the free trial) has no wallet account to watch.
  const actsAsWallet =
    !!session && (account ? !isTrialSession(account, session.address) : session.method === "browser");
  useEffect(() => {
    if (DATA_MODE !== "live" || !address || !actsAsWallet) return;
    return watchAccount(address as Address, signOut);
  }, [address, actsAsWallet, signOut]);

  // The dashboard routes show the Connect window themselves while signed out,
  // so opening it is just a navigation.
  const openConnect = useCallback(
    (next: string = paths.app) => {
      void navigate(next);
    },
    [navigate],
  );

  const value = useMemo(
    () => ({ session, account, ready, refreshAccount, signIn, signOut, openConnect }),
    [session, account, ready, refreshAccount, signIn, signOut, openConnect],
  );
  return (
    <AuthContext.Provider value={value}>
      {children}
      {splash !== "hidden" && <SignOutSplash leaving={splash === "out"} />}
    </AuthContext.Provider>
  );
}
