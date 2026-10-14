import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { paths } from "../app/paths";
import { AuthContext } from "./context";
import { readSession, writeSession, type Session } from "./session";

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(readSession);

  const signIn = useCallback((next: Session) => {
    writeSession(next);
    setSession(next);
  }, []);

  const signOut = useCallback(() => {
    writeSession(null);
    setSession(null);
    void navigate(paths.landing);
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
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
