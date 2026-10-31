import { useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/PageHeader";
import { isTrialSession } from "../../auth/account";
import { useAuth } from "../../auth/context";
import { useConnectWallet } from "../../auth/useConnectWallet";
import { MergePrompt } from "../../auth/MergePrompt";
import { WalletPicker } from "../../auth/WalletPicker";
import { injected, switchChain, walletChainId } from "../../chain/client";
import { formatUsdc } from "../../chain/funding";
import { useBalances } from "../../chain/useBalances";
import { useCredits } from "../../chain/useCredits";
import { LIVE } from "../../config/live";
import { useCopy } from "../../hooks/useCopy";

function useWalletChain() {
  const [chainId, setChainId] = useState<number | null>(null);
  useEffect(() => {
    void walletChainId().then(setChainId);
    const provider = injected();
    const onChange = (id: string) => {
      setChainId(Number(id));
    };
    provider?.on("chainChanged", onChange);
    return () => {
      provider?.removeListener("chainChanged", onChange);
    };
  }, []);
  return [chainId, setChainId] as const;
}

/** The wallet screen on live data: testnet balances, free credits, network, faucets. */
export function LiveWallet() {
  const { session, account } = useAuth();
  // A free-trial account has no wallet: its credits are the gateway's, under the trial address, and there are no
  // balances to read.
  const trial = isTrialSession(account, session?.address);
  const creditsFor = (session?.address ?? null) as Address | null;
  const address = trial ? null : creditsFor;
  const connectWallet = useConnectWallet();
  const copy = useCopy();
  const [chainId, setChainId] = useWalletChain();
  const balances = useBalances(address);
  const { credits, error } = useCredits(creditsFor);
  const wrongChain = !trial && chainId !== null && chainId !== LIVE.chainId;

  return (
    <>
      <PageHeader
        title="Wallet"
        subtitle={
          trial
            ? "You are on the free trial, with no wallet connected."
            : `Your address on ${LIVE.chainName}. All balances here are testnet funds only, never real money.`
        }
      />

      {wrongChain && (
        <div className="card pad24 row between" role="alert">
          <span className="strong">Your wallet is on another network. Switch to {LIVE.chainName} to fund plans.</span>
          <Button
            variant="primary"
            onClick={() => {
              void switchChain().then((ok) => {
                if (ok) setChainId(LIVE.chainId);
              });
            }}
          >
            Switch network
          </Button>
        </div>
      )}

      <section className="wl-top">
        {trial ? (
          <div className="wl-card">
            <div className="row between">
              <span className="strong">No wallet connected</span>
              <Badge status="Waiting" label="Free trial" className="glass" />
            </div>
            <p className="small c2">
              Your trial plans are paid from free test credits. Connect a wallet to pay with your own test USDC and to
              have proofs settle to your address.
            </p>
            {connectWallet.error && (
              <p className="small cr" role="alert">
                {connectWallet.error}
              </p>
            )}
            {connectWallet.offer ? (
              <MergePrompt
                offer={connectWallet.offer}
                busy={connectWallet.busy}
                onMerge={connectWallet.merge}
                onCancel={connectWallet.cancelMerge}
              />
            ) : (
              <WalletPicker busy={connectWallet.busy} onMetaMask={connectWallet.connect} />
            )}
          </div>
        ) : (
          <div className="wl-card">
            <div className="row between">
              <span className="strong">Your wallet</span>
              <Badge
                status={wrongChain ? "Waiting" : "Completed"}
                label={wrongChain ? "Wrong network" : LIVE.chainName}
                className="glass"
              />
            </div>
            <div className="col g4">
              <span className="small c2">Test USDC</span>
              <span className="wl-balance">
                <span data-testid="usdc-balance">{balances ? formatUsdc(balances.usdc) : "…"}</span>{" "}
                <span className="wl-unit">USDC</span>
              </span>
              <span className="small c2">
                Gas:{" "}
                <span data-testid="eth-balance">{balances ? Number(formatEther(balances.eth)).toFixed(4) : "…"}</span>{" "}
                test ETH
              </span>
            </div>
            <div className="row between">
              <span className="mono wl-address">{address}</span>
              <button
                type="button"
                className="row g6 small c2 wl-copy"
                onClick={() => {
                  if (address) copy(address, "Address copied");
                }}
              >
                Copy
              </button>
            </div>
          </div>
        )}

        <div className="card pad24 col g16">
          <h2 className="title">Free credits</h2>
          {error ? (
            <p className="c2">{error}</p>
          ) : (
            <>
              <span className="wl-balance">
                <span data-testid="credits-remaining">{credits ? formatUsdc(credits.remaining) : "…"}</span>{" "}
                <span className="wl-unit">USDC left</span>
              </span>
              <p className="small c2">
                New accounts get {credits ? formatUsdc(credits.granted) : "…"} test USDC to try Mergit. Tasks paid with
                credits are always audited and do not count toward an agent&apos;s reputation.
              </p>
            </>
          )}
        </div>
      </section>

      {!trial && (
        <section className="card pad24 col g12">
          <h2 className="title">Get testnet funds</h2>
          <p className="small c2">
            Gas on {LIVE.chainName} needs test ETH; plans are paid in test USDC. Both are free from these faucets.
          </p>
          <div className="row g12">
            <a className="btn secondary" href={LIVE.faucets.eth} target="_blank" rel="noreferrer">
              Get test ETH
            </a>
            <a className="btn secondary" href={LIVE.faucets.usdc} target="_blank" rel="noreferrer">
              Get test USDC
            </a>
          </div>
        </section>
      )}
    </>
  );
}
