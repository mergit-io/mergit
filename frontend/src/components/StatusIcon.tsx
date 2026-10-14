import type { Status } from "../mock/data";
import { Icon, type IconName } from "./Icon";

const ICON: Record<Status, { name: IconName; color: string; label: string }> = {
  Completed: { name: "check", color: "var(--mint)", label: "Completed" },
  Verified: { name: "check", color: "var(--mint)", label: "Verified" },
  Running: { name: "running", color: "var(--azure)", label: "Running" },
  Waiting: { name: "hand", color: "var(--amber)", label: "Needs approval" },
  Failed: { name: "fail", color: "var(--red)", label: "Failed" },
  Neutral: { name: "clock", color: "var(--ink3)", label: "Queued" },
};

/** Compact status mark for tight spots like graph nodes; labelled for screen readers. */
export function StatusIcon({ status, size = 16 }: { status: Status; size?: number }) {
  const { name, color, label } = ICON[status];
  return (
    <span className="row" role="img" aria-label={label}>
      <Icon name={name} size={size} color={color} stroke={2} />
    </span>
  );
}
