import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { paths } from "../app/paths";
import { BrandMark, Icon } from "../components/Icon";
import { useAuth } from "./context";
import { connectWallet, DEMO_ADDRESS, randomNonce, short, signInMessage, type WalletKind } from "./session";

const WALLETS: { kind: WalletKind; label: string; detected?: boolean }[] = [
  { kind: "browser", label: "Browser wallet", detected: true },
  { kind: "walletconnect", label: "WalletConnect" },
  { kind: "passkey", label: "Passkey" },
];

type Step = { name: "choose" } | { name: "signing"; nonce: string } | { name: "connected"; nonce: string };

/** How long "Connected" stays up before the dashboard comes into focus. */
const CONNECTED_HOLD_MS = 700;

/** The "Connect to Mergit" window shown over a locked dashboard. */
export function ConnectDialog() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ name: "choose" });
  const dialogRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    void navigate(paths.landing);
  }, [navigate]);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      abortRef.current?.abort();
    };
  }, [cancel]);

  const choose = (wallet: WalletKind) => {
    const nonce = randomNonce();
    setStep({ name: "signing", nonce });
    const controller = new AbortController();
    abortRef.current = controller;
    connectWallet(wallet, controller.signal).then(
      (session) => {
        setStep({ name: "connected", nonce });
        window.setTimeout(() => {
          signIn(session);
        }, CONNECTED_HOLD_MS);
      },
      () => {
        // Cancelled; the dialog is going away.
      },
    );
  };

  return (
    <div className="connect-backdrop">
      <div
        ref={dialogRef}
        className="connect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        aria-describedby="connect-desc"
      >
        <div className="row g12">
          <BrandMark size={34} />
          <h2 id="connect-title" className="connect-title">
            Connect to Mergit
          </h2>
          <span className="grow" />
          <button type="button" className="connect-close" aria-label="Back to the landing page" onClick={cancel}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        <p id="connect-desc" className="c2 connect-desc">
          Sign in with your wallet. Your agents&apos; proofs settle to this address.
        </p>

        {step.name === "choose" ? (
          <ul className="connect-options">
            {WALLETS.map((w, i) => (
              <li key={w.kind} className="rise" style={{ animationDelay: `${String(i * 60)}ms` }}>
                <button
                  type="button"
                  className="connect-option"
                  onClick={() => {
                    choose(w.kind);
                  }}
                >
                  <span className={`wallet-chip wallet-${w.kind}`} aria-hidden="true" />
                  <span className="grow">{w.label}</span>
                  {w.detected && <span className="badge b-ok">Detected</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="col g12 page-enter">
            <pre className="connect-message">{signInMessage(DEMO_ADDRESS, step.nonce)}</pre>
            {step.name === "signing" ? (
              <span className="row g8 small c2" role="status">
                <Icon name="running" size={14} className="spin" color="var(--azure)" />
                Waiting for signature…
              </span>
            ) : (
              <span className="row g6 small cm strong" role="status">
                <Icon name="tick" size={14} stroke={2.4} />
                Connected · {short(DEMO_ADDRESS)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
