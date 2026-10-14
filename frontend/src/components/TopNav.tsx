import { paths } from "../app/paths";
import { useRef } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useSlidingThumb } from "../hooks/useSlidingThumb";
import { me } from "../mock/data";
import { useApprovals } from "../state/approvals";
import { useNotWired } from "../hooks/useNotWired";
import { BrandMark, Icon, type IconName } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { AccountMenu } from "./AccountMenu";

const TABS: { label: string; icon: IconName; to: string }[] = [
  { label: "Overview", icon: "overview", to: paths.app },
  { label: "Runs", icon: "runs", to: paths.runs },
  { label: "Agents", icon: "agents", to: paths.agents },
  { label: "Proofs", icon: "proofs", to: paths.proofs },
  { label: "Leaderboard", icon: "trophy", to: paths.leaderboard },
  { label: "Integrations", icon: "plug", to: paths.integrations },
];

function activeTab(pathname: string) {
  if (pathname === paths.app) return paths.app;
  return TABS.find((t) => t.to !== paths.app && pathname.startsWith(t.to))?.to ?? null;
}

export function TopNav() {
  const { pathname } = useLocation();
  const active = activeTab(pathname);
  const tabsRef = useRef<HTMLElement>(null);
  const thumb = useSlidingThumb(tabsRef, ".tab.on", active);
  const { waiting } = useApprovals();
  const notWired = useNotWired();

  return (
    <header className="nav">
      <div className="brand">
        <Link to={paths.app} className="row g10" aria-label="Mergit overview">
          <BrandMark />
          Mergit
        </Link>
        <span className="chip repo-chip">{me.repo}</span>
      </div>

      <nav className="tabs" ref={tabsRef} aria-label="Primary">
        {thumb && (
          <span
            className="tab-thumb"
            data-thumb
            aria-hidden="true"
            style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
          />
        )}
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={`tab${active === tab.to ? " on" : ""}`}
            aria-current={active === tab.to ? "page" : undefined}
          >
            <Icon name={tab.icon} size={15} />
            <span className="tab-label">{tab.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="navr">
        <button type="button" className="iconbtn nav-search" aria-label="Search" onClick={notWired}>
          <Icon name="search" size={16} />
        </button>
        <Link
          to={paths.app}
          className="iconbtn"
          aria-label={waiting > 0 ? `Notifications, ${waiting} waiting` : "Notifications"}
        >
          <Icon name="bell" size={16} />
          {waiting > 0 && <span className="dotn">{waiting}</span>}
        </Link>
        <ThemeToggle />
        <NavLink
          to={paths.wallet}
          className={({ isActive }) => `pill wallet-pill${isActive ? " on" : ""}`}
          aria-label="Wallet and identity"
        >
          <span className="orb" />
          <span className="mono">{me.address}</span>
        </NavLink>
        <AccountMenu />
      </div>
    </header>
  );
}
