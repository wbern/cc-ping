import { blue, green, red, yellow } from "./color.js";
import { listAccounts } from "./config.js";
import type { DuplicateGroup } from "./identity.js";
import { findDuplicates } from "./identity.js";
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
  windowStatus: "active" | "needs ping" | "deferred" | "unknown";
  timeUntilReset: string | null;
  lastCostUsd: number | null;
  lastTokens: number | null;
  duplicateOf?: string;
  deferUntilUtcHour?: number;
}

function colorizeStatus(windowStatus: AccountStatus["windowStatus"]): string {
  switch (windowStatus) {
    case "active":
      return green(windowStatus);
    case "needs ping":
      return red(windowStatus);
    case "deferred":
      return blue(windowStatus);
    default:
      return yellow(windowStatus);
  }
}

export function formatStatusLine(status: AccountStatus): string {
  const lines: string[] = [];
  const dup = status.duplicateOf
    ? `  [duplicate of ${status.duplicateOf}]`
    : "";
  lines.push(
    `  ${status.handle}: ${colorizeStatus(status.windowStatus)}${dup}`,
  );

  const ping =
    status.lastPing === null
      ? "never"
      : status.lastPing.replace("T", " ").replace(/\.\d+Z$/, "Z");
  lines.push(`    - last ping: ${ping}`);

  if (status.timeUntilReset !== null) {
    lines.push(`    - resets in ${status.timeUntilReset}`);
  }

  if (status.deferUntilUtcHour !== undefined) {
    lines.push(`    - scheduled ping at ${status.deferUntilUtcHour}:00 UTC`);
  }

  return lines.join("\n");
}

export function getAccountStatuses(
  accounts: AccountConfig[],
  now: Date = new Date(),
  duplicates?: Map<string, DuplicateGroup>,
  deferredHandles?: Map<string, number>,
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
    const isDeferred = !window && deferredHandles?.has(account.handle);
    const deferUntilUtcHour = isDeferred
      ? deferredHandles?.get(account.handle)
      : undefined;
    return {
      handle: account.handle,
      configDir: account.configDir,
      lastPing: lastPing.toISOString(),
      windowStatus: window
        ? ("active" as const)
        : isDeferred
          ? ("deferred" as const)
          : ("needs ping" as const),
      timeUntilReset: window ? formatTimeRemaining(window.remainingMs) : null,
      lastCostUsd,
      lastTokens,
      duplicateOf,
      deferUntilUtcHour,
    };
  });
}

export function printAccountTable(
  log: (msg: string) => void = console.log,
  now: Date = new Date(),
  deferredHandles?: Map<string, number>,
): void {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    log("No accounts configured");
    return;
  }
  const dupes = findDuplicates(accounts);
  const statuses = getAccountStatuses(accounts, now, dupes, deferredHandles);
  for (const s of statuses) {
    log(formatStatusLine(s));
  }
}
