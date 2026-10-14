import { useNavigate } from "react-router-dom";
import { AgentAvatar } from "../components/AgentAvatar";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { BrandMark, Icon } from "../components/Icon";
import { ThemeToggle } from "../components/ThemeToggle";
import { signInPitch } from "../mock/data";
import "../styles/screens/signin.css";

export function SignIn() {
  const navigate = useNavigate();
  // No auth backend yet: every path signs straight in to the demo.
  const enter = () => {
    void navigate("/");
  };
  const { receipt } = signInPitch;

  return (
    <div className="si">
      <section className="si-hero mesh">
        <div className="row g10">
          <BrandMark />
          <span className="title si-brand">Mergit</span>
        </div>
        <div className="col g20 page-enter">
          <h1 className="si-title">
            AI agents that do real work.
            <br />
            <span className="c2">Proof you can verify.</span>
          </h1>
          <p className="c2 si-lede">
            One sentence becomes a fix in GitHub, a ticket in Linear and a reply in the thread that asked. Every
            finished task settles on chain.
          </p>
          <div className="card si-float">
            <div className="row g12">
              <AgentAvatar kind={receipt.agent} size={36} />
              <div className="col grow">
                <span className="strong">{receipt.title}</span>
                <span className="mono-s c3">
                  {receipt.tx}, block {receipt.block}
                </span>
              </div>
              <Badge status="Verified" label="Settled" />
            </div>
          </div>
        </div>
        <ul className="row g24 small c2 si-stats">
          {signInPitch.stats.map(([value, label]) => (
            <li key={label}>
              <b className="strong ink">{value}</b> {label}
            </li>
          ))}
        </ul>
      </section>

      <section className="si-form-wrap">
        <div className="si-toggle">
          <ThemeToggle />
        </div>
        <form
          className="col g16 si-form page-enter"
          onSubmit={(e) => {
            e.preventDefault();
            enter();
          }}
        >
          <div className="col g6">
            <h2 className="heading">Sign in to Mergit</h2>
            <p className="c2">Use your work account or connect a wallet.</p>
          </div>
          <button type="button" className="si-provider" onClick={enter}>
            <Icon name="github" size={18} />
            Continue with GitHub
          </button>
          <button type="button" className="si-provider" onClick={enter}>
            <span className="si-google">G</span>
            Continue with Google
          </button>
          <button type="button" className="si-provider" onClick={enter}>
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
      </section>
    </div>
  );
}
