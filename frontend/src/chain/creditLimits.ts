import { formatUsdc } from "./funding";
import type { Credits } from "./useCredits";

/** The most one plan may ask for. A typo of a few zeros is caught here instead of drafting a plan nobody can fund. */
export const MAX_BUDGET = 1000n * 1_000_000n;

/**
 * Why a plan worth `amount` could not be paid from free credits, or null when it can (or the limits are not known:
 * the gateway still decides). The same rules the API checks before it approves, said before the person gets there.
 */
export function creditProblem(credits: Credits | null, amount: bigint): string | null {
  if (!credits) return null;
  const { planCap, plansPerDay, plansToday, remaining } = credits;
  if (planCap !== null && amount > planCap) {
    return `Free credits cover up to ${formatUsdc(planCap)} USDC per plan; this plan is ${formatUsdc(amount)} USDC. Lower the budget, or fund it from a wallet.`;
  }
  if (plansPerDay !== null && plansToday >= plansPerDay) {
    return `You have used today's ${String(plansPerDay)} free plans. They reset tomorrow.`;
  }
  if (amount > remaining) {
    return `Only ${formatUsdc(remaining)} USDC of free credits left; this plan is ${formatUsdc(amount)} USDC.`;
  }
  return null;
}

/** The budget a free-credit account can start from: the per-plan cap, or what is left if that is less. */
export function creditBudget(credits: Credits | null): bigint | null {
  if (!credits || credits.planCap === null) return null;
  const budget = credits.remaining < credits.planCap ? credits.remaining : credits.planCap;
  return budget > 0n ? budget : null;
}
