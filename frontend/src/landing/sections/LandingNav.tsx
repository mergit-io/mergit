import { Link } from "react-router-dom";
import { paths } from "../../app/paths";
import { useAuth } from "../../auth/context";
import { MergitLogo } from "../../components/MergitLogo";
import { ThemeToggle } from "../../components/ThemeToggle";
import { nav } from "../content";
import { LIcon } from "../LIcon";

export function LandingNav() {
  const { session, openConnect } = useAuth();
  return (
    <header className="l-nav l-container">
      <Link to={paths.landing} className="l-brand" aria-label="Mergit home">
        <MergitLogo title="" className="l-logo" />
      </Link>
      <nav className="l-nav-links" aria-label="Sections">
        {nav.map((item) => (
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
            <a href={paths.demo} className="l-signin">
              View demo
            </a>
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
              Get started <LIcon name="arrowUpRight" size={14} stroke={2} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
