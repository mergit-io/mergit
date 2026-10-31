import { useId, useState, type SyntheticEvent } from "react";
import { formatUsdc } from "../chain/funding";
import { redeemCode } from "./accountApi";

/**
 * Adds a redeem code's credit to the account. A code works once; the person who was given one pastes it here.
 * `onRedeemed` fires after a success so the balance next to it can be read again.
 */
export function RedeemCode({ onRedeemed }: { onRedeemed: () => void }) {
  const inputId = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    redeemCode(code)
      .then((added) => {
        setCode("");
        setMessage({ ok: true, text: `Added ${formatUsdc(added)} USDC to your credits.` });
        onRedeemed();
      })
      .catch((e: unknown) => {
        setMessage({ ok: false, text: e instanceof Error ? e.message : "Mergit could not check the code." });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form className="col g8" onSubmit={submit}>
      <label className="small strong" htmlFor={inputId}>
        Redeem code
      </label>
      <div className="row g8">
        <div className="input grow">
          <input
            id={inputId}
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
            }}
            placeholder="MRG-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={64}
          />
        </div>
        <button type="submit" className="btn secondary" disabled={busy || code.trim() === ""}>
          {busy ? "Checking…" : "Redeem"}
        </button>
      </div>
      {message && (
        <p className={`small ${message.ok ? "cm" : "cr"}`} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}
    </form>
  );
}
