import { createContext, useContext } from "react";
import type { Session } from "./session";

type AuthValue = {
  session: Session | null;
  /** Open the Connect window. After connecting, go to `next` (defaults to the dashboard). */
  openConnect: (next?: string) => void;
  signIn: (session: Session) => void;
  signOut: () => void;
};

export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
