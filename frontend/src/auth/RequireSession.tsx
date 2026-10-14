import type { ReactNode } from "react";
import { useAuth } from "./context";
import { ConnectDialog } from "./ConnectDialog";

/**
 * Dashboard gate. Signed out, the dashboard renders behind a blur, inert and
 * hidden from assistive tech, with the Connect window on top.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return (
    <div className={`app-gate${session ? " unlocked" : " locked"}`}>
      <div className="app-gate-content" inert={!session} aria-hidden={session ? undefined : true}>
        {children}
      </div>
      {!session && <ConnectDialog />}
    </div>
  );
}
