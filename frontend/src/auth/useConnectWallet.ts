import { useCallback, useState } from "react";
import { getAddress } from "viem";
import { connectAndLinkWallet, walletSession } from "../chain/wallet";
import { confirmMerge } from "./accountApi";
import { useAuth } from "./context";
import { WalletTakenError, type WalletTakenOffer } from "./merge";

/**
 * Connects a wallet to the signed-in account: the wallet signs one message, then the session acts as it. If the wallet
 * already has its own account, `offer` is set and the person decides whether to merge it into this one.
 */
export function useConnectWallet() {
  const { signIn, refreshAccount } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<WalletTakenOffer | null>(null);

  const connect = useCallback(() => {
    setError(null);
    setOffer(null);
    setBusy(true);
    connectAndLinkWallet()
      .then((session) => {
        signIn(session);
        return refreshAccount();
      })
      .catch((e: unknown) => {
        if (e instanceof WalletTakenError) setOffer(e.offer);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [signIn, refreshAccount]);

  const merge = useCallback(() => {
    if (!offer) return;
    setError(null);
    setBusy(true);
    confirmMerge(offer.token)
      .then((address) => {
        setOffer(null);
        signIn(walletSession(getAddress(address)));
        return refreshAccount();
      })
      .catch((e: unknown) => {
        setOffer(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [offer, signIn, refreshAccount]);

  const cancelMerge = useCallback(() => {
    setOffer(null);
  }, []);

  return { connect, busy, error, offer, merge, cancelMerge };
}
