import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { paths } from "../app/paths";
import { PlanCards } from "../components/PlanCards";
import { Icon } from "../components/Icon";
import { MergitSymbol } from "../components/MergitLogo";
import { startTrial } from "./accountApi";
import { fundingChoiceNeeded } from "./account";
import { useAuth } from "./context";
import { useConnectWallet } from "./useConnectWallet";
import { clearReopenRequest, reopenRequested } from "./walletGuide";
import { MergePrompt } from "./MergePrompt";
import { WalletPicker } from "./WalletPicker";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Shown over the dashboard to an account that has neither started the free trial nor connected a wallet: a plan
 * choice. Free runs on the treasury's free credits (audited on every task, no reputation earned) and needs no wallet.
 * Pay as you go connects a wallet, which funds each plan from its own USDC and is where proofs settle.
 * "Look around first" leaves the choice for later.
 */
export function FundingChoice() {
  const { account, refreshAccount } = useAuth();
  const wallet = useConnectWallet();
  const [dismissed, setDismissed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [walletOpen, setWalletOpen] = useState(reopenRequested);
  useEffect(() => {
    clearReopenRequest(); // used: a later visit starts with the list closed
  }, []);
  const [trialError, setTrialError] = useState<string | null>(null);
  const busy = starting || wallet.busy;
  const error = trialError ?? wallet.error;
  if (!fundingChoiceNeeded(account) || dismissed) return null;

  const trial = () => {
    setTrialError(null);
    setStarting(true);
    startTrial()
      .then(refreshAccount)
      .catch((e: unknown) => {
        setTrialError(message(e));
      })
      .finally(() => {
        setStarting(false);
      });
  };

  return (
    <div className="connect-backdrop">
      <div
        className="connect-dialog plan-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="choice-title"
        aria-describedby="choice-desc"
      >
        <div className="row g12">
          <MergitSymbol size={34} />
          <h2 id="choice-title" className="connect-title">
            Choose your plan
          </h2>
        </div>
        <p id="choice-desc" className="c2 connect-desc">
          {account?.name ? `Welcome, ${account.name}. ` : "Welcome. "}
          Start free with 5 USDC of test credits, or connect a wallet and pay as you go. Premium credit packs are
          coming. You can switch later.
        </p>
        {error && (
          <p className="small cr" role="alert">
            {error}
          </p>
        )}
        <PlanCards
          action={(plan) => {
            if (plan.soon)
              return (
                <button type="button" className="btn secondary block" disabled>
                  Coming soon
                </button>
              );
            if (plan.id === "free")
              return (
                <button type="button" className="btn primary block" disabled={busy} onClick={trial}>
                  {starting ? "Starting…" : "Start free"}
                </button>
              );
            return (
              <button
                type="button"
                className="btn secondary block"
                aria-expanded={walletOpen}
                disabled={starting}
                onClick={() => {
                  setWalletOpen((open) => !open);
                }}
              >
                <Icon name="wallet" size={16} />
                Connect a wallet
              </button>
            );
          }}
          below={(plan) =>
            plan.id === "payg" && walletOpen ? (
              wallet.offer ? (
                <MergePrompt
                  offer={wallet.offer}
                  busy={wallet.busy}
                  onMerge={wallet.merge}
                  onCancel={wallet.cancelMerge}
                />
              ) : (
                <WalletPicker busy={wallet.busy} onMetaMask={wallet.connect} />
              )
            ) : null
          }
        />
        <Link to={paths.pricing} className="link small plan-compare">
          Compare plans in detail
        </Link>
        <button
          type="button"
          className="link small plan-skip"
          onClick={() => {
            setDismissed(true);
          }}
        >
          Look around first
        </button>
      </div>
    </div>
  );
}
