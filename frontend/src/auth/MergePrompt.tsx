import { describeOther, type WalletTakenOffer } from "./merge";

/**
 * The wallet already has a Mergit account. If it is the same person's, merging brings the wallet, sign-in methods and
 * runs of that account into this one and closes it. Nothing moves until they press the button.
 */
export function MergePrompt({
  offer,
  busy,
  onMerge,
  onCancel,
}: {
  offer: WalletTakenOffer;
  busy: boolean;
  onMerge: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="col g12 mp" role="group" aria-label="Merge accounts">
      <div className="col g4">
        <h3 className="title">This wallet already has a Mergit account</h3>
        <p className="small c2">{describeOther(offer.other)}</p>
        <p className="small c2">
          If both accounts are yours, merge them: everything moves into the account you are signed in to, and the other
          account is closed. This cannot be undone.
        </p>
      </div>
      <button type="button" className="btn primary block" disabled={busy} onClick={onMerge}>
        {busy ? "Merging…" : "Merge into this account"}
      </button>
      <button type="button" className="link small" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
