import { Outlet, useLocation } from "react-router-dom";
import { TopNav } from "./TopNav";

export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className="shell">
      <TopNav />
      {/* Keyed on the path so each route plays the enter animation. */}
      <main key={pathname} className="main page-enter">
        <Outlet />
      </main>
    </div>
  );
}
