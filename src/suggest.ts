import { formatTimeRemaining, getWindowReset } from "./state.js";
import type { AccountConfig } from "./types.js";

interface SuggestResult {
  handle: string;
  configDir: string;
  reason: string;
  timeUntilReset: string | null;
}

export function suggestAccount(
  accounts: AccountConfig[],
  now: Date = new Date(),
): SuggestResult | null {
  if (accounts.length === 0) return null;

  // Prefer accounts with no active window (available immediately)
  for (const account of accounts) {
    const window = getWindowReset(account.handle, now);
    if (!window) {
      return {
        handle: account.handle,
        configDir: account.configDir,
        reason: "no active window",
        timeUntilReset: null,
      };
    }
  }

  // All accounts have active windows — pick the one with most remaining time
  let best: { account: AccountConfig; remainingMs: number } | null = null;
  for (const account of accounts) {
    const window = getWindowReset(account.handle, now);
    if (window && (best === null || window.remainingMs > best.remainingMs)) {
      best = { account, remainingMs: window.remainingMs };
    }
  }

  return {
    handle: best!.account.handle,
    configDir: best!.account.configDir,
    reason: "most remaining window time",
    timeUntilReset: formatTimeRemaining(best!.remainingMs),
  };
}
