import { paths } from "../app/paths";
import symbolColour from "./story/assets/symbol-colour.svg?raw";
import { storyCopy as c } from "./story/copy";
import "../styles/landing/proofcards.css";

/**
 * Three guarantees, each with a small product picture. Shared by the scroll story (scene #s6) and the compact page;
 * the container sets the --pc-* tokens for its theme. Every figure is an example, and says so.
 */
export function ProofCards() {
  const [escrow, receipt, agents] = c.proofs.cards;
  const card = ([title, body, cta]: readonly [string, string, string], href: string, art: React.ReactNode) => (
    <article className="pc-card">
      <div className="pc-art">
        <span className="pc-ex">{c.proofs.example}</span>
        {art}
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
      <a className="pc-btn" href={href}>
        {cta}
      </a>
    </article>
  );
  return (
    <>
      {card(
        escrow,
        paths.demo,
        <>
          <div className="pc-money">
            <span className="pc-k">Escrow</span>
            <b>2.00 USDC</b>
            <span className="pc-ok">Held until the check passes</span>
          </div>
          <div className="pc-steps">
            {["Fund", "Check", "Release"].map((x) => (
              <span key={x}>{x}</span>
            ))}
          </div>
          <div className="pc-money pc-rows">
            <span>
              Receipt <em>verified</em>
            </span>
            <span>
              Payment <em>released</em>
            </span>
          </div>
        </>,
      )}
      {card(
        receipt,
        `${paths.demo}/proofs`,
        <>
          <div className="pc-slip">
            <b>Fix the auth bug</b>
            {["Plan", "Code", "Test", "Review"].map((x) => (
              <span key={x}>
                {x} <em>✓</em>
              </span>
            ))}
            <code>0x30af…1c77</code>
            <i className="pc-stamp">Verified</i>
          </div>
          <span className="pc-pill pc-p1">Signed receipt</span>
        </>,
      )}
      {card(
        agents,
        `${paths.demo}/agents`,
        <>
          <div className="pc-badge" dangerouslySetInnerHTML={{ __html: symbolColour }} />
          <span className="pc-pill pc-p2">Validated outcome</span>
          <span className="pc-pill pc-p3">ERC-8004 identity</span>
        </>,
      )}
    </>
  );
}
