import { paths } from "../app/paths";
import { useRef } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useSlidingThumb } from "../hooks/useSlidingThumb";
import { useIdentity } from "../auth/useIdentity";
import { DATA_MODE } from "../config/live";
import { useApprovals } from "../state/approvals";
import { useNotWired } from "../hooks/useNotWired";
import { Icon } from "./Icon";
import { MergitLogo } from "./MergitLogo";
import { ThemeToggle } from "./ThemeToggle";
import { AccountMenu } from "./AccountMenu";
import { navTabs, type NavTab } from "./navTabs";

function activeTab(tabs: NavTab[], pathname: string) {
  if (pathname === paths.app) return paths.app;
  return tabs.find((t) => t.to !== paths.app && pathname.startsWith(t.to))?.to ?? null;
}

export function TopNav() {
  const { pathname } = useLocation();
  const tabs = navTabs(DATA_MODE);
  const active = activeTab(tabs, pathname);
  const identity = useIdentity();
  const tabsRef = useRef<HTMLElement>(null);
  const thumb = useSlidingThumb(tabsRef, ".tab.on", active);
  const { waiting } = useApprovals();
  const notWired = useNotWired();
  // Search and the bell are only wired to the demo's mock data. On the live site they would do nothing (the bell
  // counts mock approvals, and Search says "not wired up"), so they are not offered there until they are real.
  const live = DATA_MODE === "live";

  return (
    <header className="nav">
      <div className="brand">
        <Link to={paths.app} className="row" aria-label="Mergit overview">
          <MergitLogo height={30} title="" />
        </Link>
        {identity.repo && <span className="chip repo-chip">{identity.repo}</span>}
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
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={`tab${active === tab.to ? " on" : ""}`}
            aria-current={active === tab.to ? "page" : undefined}
            // Below 1100px only the icon shows (shell.css hides .tab-label), so the name is given here too.
            aria-label={tab.label}
            title={tab.label}
          >
            <Icon name={tab.icon} size={15} />
            <span className="tab-label">{tab.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="navr">
        {!live && (
          <button type="button" className="iconbtn nav-search" aria-label="Search" onClick={notWired}>
            <Icon name="search" size={16} />
          </button>
        )}
        {!live && (
          <Link
            to={paths.app}
            className="iconbtn"
            aria-label={waiting > 0 ? `Notifications, ${waiting} waiting` : "Notifications"}
          >
            <Icon name="bell" size={16} />
            {waiting > 0 && <span className="dotn">{waiting}</span>}
          </Link>
        )}
        <ThemeToggle />
        <NavLink
          to={paths.wallet}
          className={({ isActive }) => `pill wallet-pill${isActive ? " on" : ""}`}
          aria-label="Wallet and identity"
        >
          <span className="orb" />
          <span className="mono">{identity.addressShort}</span>
        </NavLink>
        <AccountMenu />
      </div>
    </header>
  );
}
