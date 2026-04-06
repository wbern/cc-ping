import { formatTimeRemaining, getWindowReset } from "./state.js";
import type { AccountConfig } from "./types.js";

interface NextResetResult {
  handle: string;
  configDir: string;
  remainingMs: number;
  resetAt: string;
  timeUntilReset: string;
}

export function getNextReset(
  accounts: AccountConfig[],
  now: Date = new Date(),
): NextResetResult | null {
  let best: NextResetResult | null = null;

  for (const account of accounts) {
    const window = getWindowReset(account.handle, now);
    if (!window) continue;
    if (best === null || window.remainingMs < best.remainingMs) {
      best = {
        handle: account.handle,
        configDir: account.configDir,
        remainingMs: window.remainingMs,
        resetAt: window.resetAt.toISOString(),
        timeUntilReset: formatTimeRemaining(window.remainingMs),
      };
    }
  }

  return best;
}
