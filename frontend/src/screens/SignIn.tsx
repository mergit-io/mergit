import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { paths } from "../app/paths";
import { useAuth } from "../auth/context";
import { SignInMethods } from "../auth/SignInMethods";
import { modeCopy, modeFromParams } from "../auth/authMode";
import { signInErrorMessage } from "../auth/signInOptions";
import { demoSession, type SignInMethod } from "../auth/session";
import { DATA_MODE } from "../config/live";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { MergitLogo } from "../components/MergitLogo";
import { ThemeToggle } from "../components/ThemeToggle";
import { SignInArt } from "./SignInArt";
import "../styles/screens/signin.css";

export function SignIn() {
  const navigate = useNavigate();
  const { signIn, openConnect } = useAuth();
  // No auth backend yet: account sign-ins go straight to the demo account,
  // and the wallet option opens the same Connect window as "Try the demo".
  const enter = (method: SignInMethod) => {
    signIn(demoSession(method));
    void navigate(paths.app);
  };
  const live = DATA_MODE === "live";
  const [params, setParams] = useSearchParams();
  const mode = modeFromParams(params);
  const copy = modeCopy(mode);
  const failure = signInErrorMessage(params.get("error"));

  return (
    <div className="si">
      <section className="si-hero mesh">
        <Link to={paths.landing} className="row si-logo" aria-label="Mergit home">
          <MergitLogo height={32} title="" />
        </Link>
        <div className="col g20 page-enter">
          <h1 className="si-title">
            AI agents that do real work.
            <br />
            <span className="c2">Proof you can verify.</span>
          </h1>
          <SignInArt />
        </div>
        {live ? (
          <ul className="col g12 si-points">
            <li className="row g12">
              <Icon name="tick" size={16} stroke={2.4} />
              <span>Every finished task leaves a receipt committed on Base Sepolia, which anyone can check.</span>
            </li>
            <li className="row g12">
              <Icon name="tick" size={16} stroke={2.4} />
              <span>Start free: trial credits pay for your first runs, with no wallet needed.</span>
            </li>
            <li className="row g12">
              <Icon name="tick" size={16} stroke={2.4} />
              <span>Connect a wallet when you want to pay with your own test USDC.</span>
            </li>
          </ul>
        ) : (
          <span className="small c3">Every finished task leaves a receipt anyone can check.</span>
        )}
      </section>

      <section className="si-form-wrap">
        <div className="si-toggle">
          <ThemeToggle />
        </div>
        {live ? (
          <div className="col g16 si-form page-enter">
            <div className="col g6">
              <h2 className="heading">{copy.heading}</h2>
              <p className="c2">{copy.lede}</p>
            </div>
            {failure && (
              <p className="small cr" role="alert">
                {failure}
              </p>
            )}
            <SignInMethods
              mode={mode}
              onModeChange={(next) => {
                setParams({ mode: next });
              }}
              onSignedIn={() => {
                void navigate(paths.app);
              }}
            />
            <span className="small c3 si-signup">
              {copy.switchPrompt}{" "}
              <button
                type="button"
                className="link small"
                onClick={() => {
                  setParams({ mode: mode === "login" ? "register" : "login" });
                }}
              >
                {copy.switchAction}
              </button>
            </span>
            <p className="small c3 si-terms">
              Mergit runs on the Base Sepolia testnet. Test funds only: nothing here is real money.
            </p>
          </div>
        ) : (
          <form
            className="col g16 si-form page-enter"
            onSubmit={(e) => {
              e.preventDefault();
              enter("email");
            }}
          >
            <div className="col g6">
              <h2 className="heading">Sign in to Mergit</h2>
              <p className="c2">
                Use your work account or connect a wallet. The account options here are a demo: they sign you in as a
                demo account.
              </p>
            </div>
            <button
              type="button"
              className="si-provider"
              onClick={() => {
                enter("github");
              }}
            >
              <Icon name="github" size={18} />
              Continue with GitHub
            </button>
            <button
              type="button"
              className="si-provider"
              onClick={() => {
                enter("google");
              }}
            >
              <span className="si-google">G</span>
              Continue with Google
            </button>
            <button
              type="button"
              className="si-provider"
              onClick={() => {
                openConnect();
              }}
            >
              <Icon name="wallet" size={18} />
              Continue with wallet
            </button>
            <div className="row g12 small c3" aria-hidden="true">
              <i className="si-rule" />
              or
              <i className="si-rule" />
            </div>
            <label className="col g6">
              <span className="small c2 strong">Work email</span>
              <span className="input">
                <Icon name="mail" size={16} />
                <input type="email" name="email" required placeholder="you@company.com" autoComplete="email" />
              </span>
            </label>
            <button type="submit" className="btn primary block">
              Continue
            </button>
            <span className="small c3 si-signup">
              New here?{" "}
              <Button variant="link" compact>
                Create an account
              </Button>
            </span>
          </form>
        )}
      </section>
    </div>
  );
}
