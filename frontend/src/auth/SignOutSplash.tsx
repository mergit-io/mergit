import { BrandMark } from "../components/Icon";
import { CHAIN_LABEL } from "../mock/data";

/** Full-screen brand card shown while signing out, as at the end of the landing design video. */
export function SignOutSplash({ leaving }: { leaving: boolean }) {
  return (
    <div className={`signout${leaving ? " leaving" : ""}`} role="status" aria-label="Signing out">
      <div className="signout-card">
        <div className="signout-brand">
          <BrandMark size={64} />
          <span>Mergit</span>
        </div>
        <p className="signout-tag">Real work. Verifiable proof.</p>
        <p className="signout-chain">Proof settlement on an {CHAIN_LABEL}</p>
      </div>
    </div>
  );
}
