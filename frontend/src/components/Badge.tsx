import type { Status } from "../mock/data";
import { Icon, type IconName } from "./Icon";

const BADGE: Record<Status, [className: string, icon: IconName, label: string]> = {
  Completed: ["b-ok", "check", "Completed"],
  Verified: ["b-ok", "proofs", "Verified"],
  Running: ["b-run", "running", "Running"],
  Waiting: ["b-wait", "hand", "Needs approval"],
  Failed: ["b-fail", "fail", "Failed"],
  Neutral: ["b-n", "clock", "Queued"],
};

/** Status pill. Always an icon plus a word, never colour alone. */
export function Badge({ status, label, className }: { status: Status; label?: string; className?: string }) {
  const [cls, icon, fallback] = BADGE[status];
  return (
    <span className={`badge ${cls}${className ? ` ${className}` : ""}`}>
      <Icon name={icon} size={13} stroke={2} className={status === "Running" ? "spin" : undefined} />
      {label ?? fallback}
    </span>
  );
}
