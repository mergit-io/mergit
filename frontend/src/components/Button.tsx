import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useNotWired } from "../hooks/useNotWired";
import { Icon, type IconName } from "./Icon";

type ButtonProps = {
  children: ReactNode;
  variant?: "primary" | "secondary" | "link";
  icon?: IconName;
  /** The smaller 32px button, or 12px text for a link. */
  compact?: boolean;
  /** Render as a router link. */
  to?: string;
  /** Without `to` or `onClick`, the button explains that its action needs the backend. */
  onClick?: () => void;
};

export function Button({ children, variant = "secondary", icon, compact, to, onClick }: ButtonProps) {
  const notWired = useNotWired();
  const cls =
    variant === "link"
      ? ["link", compact && "small"].filter(Boolean).join(" ")
      : ["btn", variant, compact && "compact"].filter(Boolean).join(" ");
  const content = (
    <>
      {variant !== "link" && icon && <Icon name={icon} size={16} />}
      {children}
      {variant === "link" && icon && <Icon name={icon} size={compact ? 13 : 14} />}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={cls}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick ?? notWired}>
      {content}
    </button>
  );
}
