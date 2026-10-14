import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";

/**
 * Screen title row. Top-level screens use the large display title; detail
 * screens pass `crumb` and get the smaller heading with a back link.
 */
export function PageHeader({
  title,
  subtitle,
  crumb,
  badge,
  actions,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  /** Back link above a detail title. Without `to` it is plain text, for sections with no list page yet. */
  crumb?: { label: string; to?: string; id: string };
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className={`col ${crumb ? "g6" : "g4"}`}>
        {crumb &&
          (crumb.to ? (
            <Link to={crumb.to} className="row g6 small c3 crumb">
              <Icon name="chevronLeft" size={14} />
              {crumb.label}
              <span className="mono-s">/ {crumb.id}</span>
            </Link>
          ) : (
            <span className="row g6 small c3 crumb">
              <Icon name="chevronLeft" size={14} />
              {crumb.label}
              <span className="mono-s">/ {crumb.id}</span>
            </span>
          ))}
        {crumb ? (
          <div className="row g12">
            <h1 className="heading">{title}</h1>
            {badge}
          </div>
        ) : (
          <h1 className="display">{title}</h1>
        )}
        <p className="c2">{subtitle}</p>
      </div>
      {actions && <div className="row g10 page-actions">{actions}</div>}
    </div>
  );
}
