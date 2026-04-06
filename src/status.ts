import type { DuplicateGroup } from "./identity.js";
import {
  formatTimeRemaining,
  getLastPing,
  getLastPingMeta,
  getWindowReset,
} from "./state.js";
import type { AccountConfig } from "./types.js";

interface AccountStatus {
  handle: string;
  configDir: string;
  lastPing: string | null;
  windowStatus: "active" | "expired" | "unknown";
  timeUntilReset: string | null;
  lastCostUsd: number | null;
  lastTokens: number | null;
  duplicateOf?: string;
}

export function formatStatusLine(status: AccountStatus): string {
  const ping =
    status.lastPing === null
      ? "never"
      : status.lastPing.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const reset =
    status.timeUntilReset !== null
      ? ` (resets in ${status.timeUntilReset})`
      : "";
  const cost =
    status.lastCostUsd !== null && status.lastTokens !== null
      ? `  $${status.lastCostUsd.toFixed(4)} ${status.lastTokens} tok`
      : "";
  const dup = status.duplicateOf
    ? `  [duplicate of ${status.duplicateOf}]`
    : "";
  return `  ${status.handle}: ${status.windowStatus}  last ping: ${ping}${reset}${cost}${dup}`;
}

export function getAccountStatuses(
  accounts: AccountConfig[],
  now: Date = new Date(),
  duplicates?: Map<string, DuplicateGroup>,
): AccountStatus[] {
  // Build handle -> other handles lookup
  const dupLookup = new Map<string, string>();
  if (duplicates) {
    for (const group of duplicates.values()) {
      for (const handle of group.handles) {
        const others = group.handles.filter((h) => h !== handle).join(", ");
        if (others) dupLookup.set(handle, others);
      }
    }
  }

  return accounts.map((account) => {
    const lastPing = getLastPing(account.handle);
    const meta = getLastPingMeta(account.handle);
    const lastCostUsd = meta?.costUsd ?? null;
    const lastTokens =
      meta !== null ? meta.inputTokens + meta.outputTokens : null;
    const duplicateOf = dupLookup.get(account.handle);

    if (!lastPing) {
      return {
        handle: account.handle,
        configDir: account.configDir,
        lastPing: null,
        windowStatus: "unknown" as const,
        timeUntilReset: null,
        lastCostUsd,
        lastTokens,
        duplicateOf,
      };
    }
    const window = getWindowReset(account.handle, now);
    return {
      handle: account.handle,
      configDir: account.configDir,
      lastPing: lastPing.toISOString(),
      windowStatus: window ? ("active" as const) : ("expired" as const),
      timeUntilReset: window ? formatTimeRemaining(window.remainingMs) : null,
      lastCostUsd,
      lastTokens,
      duplicateOf,
    };
  });
}
