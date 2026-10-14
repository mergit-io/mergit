import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { approvals as initial } from "../mock/data";
import { useToast } from "../toast/context";
import { ApprovalsContext, type ApprovalItem } from "./approvals";

/**
 * Pending approval asks, shared by the nav badge and the Overview list. Each ask
 * counts down; at zero it expires and the task stops instead of guessing.
 */
export function ApprovalsProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [items, setItems] = useState<ApprovalItem[]>(() => initial.map((a) => ({ ...a, remaining: a.expires })));
  const waiting = items.filter((a) => a.remaining > 0).length;

  useEffect(() => {
    if (waiting === 0) return;
    const id = window.setInterval(() => {
      setItems((list) => list.map((a) => (a.remaining > 0 ? { ...a, remaining: a.remaining - 1 } : a)));
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [waiting]);

  const resolve = useCallback(
    (id: string, approved: boolean) => {
      setItems((list) => list.filter((a) => a.id !== id));
      toast(approved ? "Approved, the agent will continue" : "Denied, the task will stop");
    },
    [toast],
  );

  const dismiss = useCallback((id: string) => {
    setItems((list) => list.filter((a) => a.id !== id));
  }, []);

  const value = useMemo(() => ({ items, waiting, resolve, dismiss }), [items, waiting, resolve, dismiss]);
  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}
