import { createContext, useContext } from "react";
import type { Approval } from "../mock/data";

export type ApprovalItem = Approval & {
  /** Seconds left before the ask expires and the task stops. */
  remaining: number;
};

type ApprovalsValue = {
  items: ApprovalItem[];
  /** Asks still waiting on the user. */
  waiting: number;
  resolve: (id: string, approved: boolean) => void;
  /** Clear an expired ask from the list. */
  dismiss: (id: string) => void;
};

export const ApprovalsContext = createContext<ApprovalsValue | null>(null);

export function useApprovals() {
  const ctx = useContext(ApprovalsContext);
  if (!ctx) throw new Error("useApprovals must be used inside ApprovalsProvider");
  return ctx;
}
