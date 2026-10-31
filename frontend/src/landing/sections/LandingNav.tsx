import { Link } from "react-router-dom";
import { paths } from "../../app/paths";
import { useAuth } from "../../auth/context";
import { MergitLogo } from "../../components/MergitLogo";
import { ThemeToggle } from "../../components/ThemeToggle";
import { nav } from "../content";
import { LIcon } from "../LIcon";

export function LandingNav({ links = nav }: { links?: readonly { label: string; href: string }[] }) {
  const { session, openConnect } = useAuth();
  return (
    <header className="l-nav l-container">
      <Link
        to={paths.landing}
        className="l-brand"
        aria-label="Mergit home"
        onClick={() => {
          // Already on the landing page: go back to the very top, wherever the scroll story is.
          window.scrollTo({ top: 0, behavior: "instant" });
        }}
      >
        <MergitLogo title="" className="l-logo" />
      </Link>
      <nav className="l-nav-links" aria-label="Sections">
        {links.map((item) => (
          <a key={item.href} href={item.href}>
            {item.label}
          </a>
        ))}
      </nav>
      <div className="l-nav-actions">
        <ThemeToggle />
        {session ? (
          <Link to={paths.app} className="l-btn">
            Open dashboard <LIcon name="arrowUpRight" size={14} stroke={2} />
          </Link>
        ) : (
          <>
            <Link to={paths.signIn} className="l-signin">
              Sign in
            </Link>
            <button
              type="button"
              className="l-btn"
              onClick={() => {
                openConnect();
              }}
            >
              Try the demo <LIcon name="arrowUpRight" size={14} stroke={2} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
