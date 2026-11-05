import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { paths } from "../app/paths";
import { useCredits } from "../chain/useCredits";
import { PlanCards } from "../components/PlanCards";
import { Icon } from "../components/Icon";
import { MergitSymbol } from "../components/MergitLogo";
import { fetchWorldConfig, type IdkitConfig } from "../world/api";
import { TrialVerify } from "../world/TrialVerify";
import { startTrial } from "./accountApi";
import { useAuth } from "./context";
import { useConnectWallet } from "./useConnectWallet";
import { clearReopenRequest, reopenRequested } from "./walletGuide";
import { MergePrompt } from "./MergePrompt";
import { choiceReason, dismissalKey, isDismissed, rememberDismissal } from "./planChoice";
import { WalletPicker } from "./WalletPicker";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Shown over the dashboard to an account that has neither started the free trial nor connected a wallet: a plan
 * choice. Free runs on the treasury's free credits (audited on every task, no reputation earned) and needs no wallet.
 * Pay as you go connects a wallet, which funds each plan from its own USDC and is where proofs settle.
 * "Look around first" (or Escape) leaves the choice for later: it stays closed for this tab and this sign-in, and
 * opens again on the next sign-in, and when a trial account with no wallet has spent its free credits. It is never
 * shown over the Wallet page, where a wallet is connected anyway.
 */
export function FundingChoice() {
  const { account, refreshAccount } = useAuth();
  const wallet = useConnectWallet();
  const onWalletPage = useLocation().pathname === paths.wallet;
  const trialNoWallet = account !== null && account.trialStartedAt !== null && account.wallets.length === 0;
  const { credits } = useCredits(trialNoWallet && account.userId !== null);
  const reason = choiceReason(account, credits?.remaining ?? null);
  const key = reason && account?.userId ? dismissalKey(account.userId, reason) : null;
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const dismissed = key !== null && (dismissedFor === key || isDismissed(key));
  const open = reason !== null && !dismissed && !onWalletPage;
  const dialog = useRef<HTMLDivElement>(null);
  const dismiss = () => {
    if (key === null) return;
    rememberDismissal(key);
    setDismissedFor(key);
  };
  // A layout effect, not a passive one: it runs before the dialog is painted, so Escape works from the first moment
  // the dialog can be seen, even on a slow or busy machine where passive effects are delayed.
  useLayoutEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (key !== null) {
          rememberDismissal(key);
          setDismissedFor(key);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open, key]);
  const [starting, setStarting] = useState(false);
  const [walletOpen, setWalletOpen] = useState(reopenRequested);
  useEffect(() => {
    clearReopenRequest(); // used: a later visit starts with the list closed
  }, []);
  const [trialError, setTrialError] = useState<string | null>(null);
  // Asked once per mount and shared across re-renders, the same cached-promise pattern `fetchProviders` uses
  // for sign-in methods: a reload or a second open of this dialog must not ask `/v0/world/config` again.
  const [idkit, setIdkit] = useState<IdkitConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchWorldConfig().then((config) => {
      if (!cancelled) setIdkit(config?.idkit ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const busy = starting || wallet.busy;
  const error = trialError ?? wallet.error;
  if (!open) return null;
  const exhausted = reason === "exhausted";

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

  // World ID's one-human check is only ever shown once it is both configured and usable: `rp_id` has no
  // source in today's `/v0/world/config` (see `TrialVerify`'s docstring) and, if it is ever absent or
  // malformed, IDKit's own widget refuses to open. Anything short of a real `rp_id` keeps today's plain
  // button -- the bulletproof fallback almost every deployment runs on.
  const worldOn = idkit !== null && idkit.enabled && idkit.rp_id !== null;
  const onWorldVerified = () => {
    void refreshAccount().finally(() => {
      setStarting(false);
    });
  };
  const onWorldCancelled = () => {
    setStarting(false);
  };
  const onWorldError = (msg: string) => {
    setTrialError(msg);
    setStarting(false);
  };

  return (
    <div className="connect-backdrop">
      <div
        ref={dialog}
        tabIndex={-1}
        className="connect-dialog plan-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="choice-title"
        aria-describedby="choice-desc"
      >
        <div className="row g12">
          <MergitSymbol size={34} />
          <h2 id="choice-title" className="connect-title">
            {exhausted ? "Your free credits are used up" : "Choose your plan"}
          </h2>
        </div>
        <p id="choice-desc" className="c2 connect-desc">
          {exhausted
            ? "Connect a wallet and pay as you go to keep running tasks. If someone gave you a redeem code, enter it on the Wallet page."
            : `${account?.name ? `Welcome, ${account.name}. ` : "Welcome. "}Start free with test credits, or connect a wallet and pay as you go. You can switch later.`}
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
            if (plan.id === "free") {
              if (exhausted)
                return (
                  <button type="button" className="btn primary block" disabled>
                    Free credits used
                  </button>
                );
              if (worldOn)
                return (
                  <TrialVerify
                    config={idkit as IdkitConfig & { rp_id: string }}
                    label="Start free"
                    disabled={busy}
                    onStart={() => {
                      setTrialError(null);
                      setStarting(true);
                    }}
                    onCancelled={onWorldCancelled}
                    onVerified={onWorldVerified}
                    onError={onWorldError}
                  />
                );
              return (
                <button type="button" className="btn primary block" disabled={busy} onClick={trial}>
                  {starting ? "Starting…" : "Start free"}
                </button>
              );
            }
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
        <button type="button" className="link small plan-skip" onClick={dismiss}>
          Look around first
        </button>
      </div>
    </div>
  );
}
