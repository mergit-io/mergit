import { fundingChoiceNeeded, type Account } from "./account";

/** Why the plan choice is open: the account has not chosen yet, or the free trial has run out of credits. */
export type ChoiceReason = "new" | "exhausted";

/**
 * Whether the account must choose a plan now. A new account has neither a wallet nor a trial. A trial account with
 * no wallet whose free credits are all spent has to connect a wallet to go on; `remaining` is null until the credits
 * are known, and then nothing is shown (a guess would flash the dialog at someone with credits left).
 */
export function choiceReason(account: Account | null, remaining: bigint | null): ChoiceReason | null {
  if (fundingChoiceNeeded(account)) return "new";
  const trialWithoutWallet =
    account !== null && account.userId !== null && account.trialStartedAt !== null && account.wallets.length === 0;
  return trialWithoutWallet && remaining === 0n ? "exhausted" : null;
}

const STORAGE_KEY = "mergit-plan-choice-dismissed";

/**
 * One dismissal per account and reason: running out of credits later asks again. It is keyed on the account, not on
 * the session record, because the record can be rebuilt while the page loads and a changed key would silently
 * un-dismiss the dialog. Signing out or in clears it (`forgetDismissal`), which is what makes the next sign-in ask.
 */
export const dismissalKey = (userId: string, reason: ChoiceReason) => `${userId}:${reason}`;

/** "Look around first" holds for this browser tab until the next sign-in or sign-out, so a reload does not bring the dialog back. */
export function isDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === key;
  } catch {
    return false;
  }
}

export function forgetDismissal(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: nothing was kept.
  }
}

export function rememberDismissal(key: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Private mode: the dismissal lasts until the page reloads.
  }
}
