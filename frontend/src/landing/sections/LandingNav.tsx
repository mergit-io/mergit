import { Link } from "react-router-dom";
import { paths } from "../../app/paths";
import { useAuth } from "../../auth/context";
import { BrandMark } from "../../components/Icon";
import { ThemeToggle } from "../../components/ThemeToggle";
import { nav } from "../content";
import { LIcon } from "../LIcon";

export function LandingNav() {
  const { session, openConnect } = useAuth();
  return (
    <header className="l-nav l-container">
      <Link to={paths.landing} className="l-brand" aria-label="Mergit home">
        <BrandMark size={48} />
        <span>Mergit</span>
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
