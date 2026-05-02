import { formatDistance } from "date-fns";
import { blue, green, red, yellow } from "./color.js";
import { listAccounts } from "./config.js";
import { msUntilUtcHour } from "./daemon.js";
import { formatLocalHour, formatTimeAgo } from "./format.js";
import type { DuplicateGroup } from "./identity.js";
import { findDuplicates } from "./identity.js";
import {
  formatTimeRemaining,
  getLastPing,
  getLastPingMeta,
  getWindowReset,
} from "./state.js";
import type { AccountConfig } from "./types.js";

export interface DeferInfo {
  optimalPingHour: number;
  peakStart: number;
  peakEnd: number;
}

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
  peakStartHour?: number;
  peakEndHour?: number;
  deferReason?: string;
}

const STATUS_LABELS: Record<AccountStatus["windowStatus"], string> = {
  active: "window active",
  "needs ping": "needs ping",
  deferred: "deferred",
  unknown: "unknown",
};

function colorizeStatus(windowStatus: AccountStatus["windowStatus"]): string {
  const label = STATUS_LABELS[windowStatus];
  switch (windowStatus) {
    case "active":
      return green(label);
    case "needs ping":
      return red(label);
    case "deferred":
      return blue(label);
    default:
      return yellow(label);
  }
}

export function censorHandle(handle: string): string {
  // For emails: mask local part and domain, keep TLD
  // For domains: mask name, keep TLD
  const atIdx = handle.indexOf("@");
  if (atIdx !== -1) {
    const local = handle.slice(0, atIdx);
    const domain = handle.slice(atIdx + 1);
    return censorPart(local) + "@" + censorDomain(domain);
  }
  return censorDomain(handle);
}

function censorPart(part: string): string {
  if (part.length <= 1) return part;
  return part[0] + "·".repeat(part.length - 1);
}

function censorDomain(domain: string): string {
  const lastDot = domain.lastIndexOf(".");
  if (lastDot === -1) return censorPart(domain);
  const name = domain.slice(0, lastDot);
  const tld = domain.slice(lastDot);
  return censorPart(name) + tld;
}

export { formatLocalHour, formatTimeAgo } from "./format.js";

export function formatStatusLine(
  status: AccountStatus,
  options?: { censor?: boolean; now?: Date; daemonNextPingIn?: string },
): string {
  const lines: string[] = [];
  const handle = options?.censor ? censorHandle(status.handle) : status.handle;
  const dup = status.duplicateOf
    ? `  [duplicate of ${options?.censor ? censorHandle(status.duplicateOf) : status.duplicateOf}]`
    : "";
  lines.push(`  ${handle}: ${colorizeStatus(status.windowStatus)}${dup}`);

  let ping: string;
  if (status.lastPing === null) {
    ping = "never";
  } else if (options?.now) {
    ping = formatTimeAgo(status.lastPing, options.now);
  } else {
    ping = status.lastPing.replace("T", " ").replace(/\.\d+Z$/, "Z");
  }
  lines.push(`    - last ping: ${ping}`);

  if (status.timeUntilReset !== null) {
    lines.push(`    - resets in ${status.timeUntilReset}`);
  }

  if (status.deferReason) {
    lines.push(`    - ${status.deferReason}`);
  }
  if (status.windowStatus === "needs ping") {
    if (options?.daemonNextPingIn !== undefined) {
      lines.push(`    - next ping in ${options.daemonNextPingIn}`);
    }
    lines.push(`    - to ping now: cc-ping ping ${handle} &`);
  }
  if (status.deferUntilUtcHour !== undefined) {
    const { peakStartHour, peakEndHour } = status;
    const hasPeak = peakStartHour !== undefined && peakEndHour !== undefined;
    if (options?.now) {
      const targetTime = new Date(options.now);
      const ms = msUntilUtcHour(status.deferUntilUtcHour, options.now);
      targetTime.setTime(targetTime.getTime() + ms);
      const distance = formatDistance(targetTime, options.now, {
        addSuffix: true,
      });
      const peak = hasPeak
        ? ` (peak: ${formatLocalHour(peakStartHour, options.now)} – ${formatLocalHour(peakEndHour, options.now)})`
        : "";
      lines.push(`    - next ping ${distance}${peak}`);
    } else {
      const peak = hasPeak
        ? ` (peak: ${peakStartHour}-${peakEndHour} UTC)`
        : "";
      lines.push(
        `    - next ping at ${status.deferUntilUtcHour}:00 UTC${peak}`,
      );
    }
  }

  return lines.join("\n");
}

export function getAccountStatuses(
  accounts: AccountConfig[],
  now: Date = new Date(),
  duplicates?: Map<string, DuplicateGroup>,
  deferredHandles?: Map<string, DeferInfo>,
  coveredHandles?: Map<string, DeferInfo | null>,
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
    const deferInfo = deferredHandles?.get(account.handle);
    const isDeferred = !window && deferInfo !== undefined;
    const isCovered =
      !window && !isDeferred && coveredHandles?.has(account.handle);
    const coveredInfo = isCovered
      ? coveredHandles?.get(account.handle)
      : undefined;
    const info = isDeferred ? deferInfo : coveredInfo;
    const deferUntilUtcHour = info?.optimalPingHour;
    const peakStartHour = info?.peakStart;
    const peakEndHour = info?.peakEnd;
    const deferReason = isCovered
      ? "window active from recent Claude Code usage"
      : undefined;
    return {
      handle: account.handle,
      configDir: account.configDir,
      lastPing: lastPing.toISOString(),
      windowStatus: window
        ? ("active" as const)
        : isDeferred || isCovered
          ? ("deferred" as const)
          : ("needs ping" as const),
      timeUntilReset: window ? formatTimeRemaining(window.remainingMs) : null,
      lastCostUsd,
      lastTokens,
      duplicateOf,
      deferUntilUtcHour,
      peakStartHour,
      peakEndHour,
      deferReason,
    };
  });
}

export function printAccountTable(
  log: (msg: string) => void = console.log,
  now: Date = new Date(),
  deferredHandles?: Map<string, DeferInfo>,
  options?: { censor?: boolean; daemonNextPingIn?: string },
  coveredHandles?: Map<string, DeferInfo | null>,
): void {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    log("No accounts configured");
    return;
  }
  const dupes = findDuplicates(accounts);
  const statuses = getAccountStatuses(
    accounts,
    now,
    dupes,
    deferredHandles,
    coveredHandles,
  );
  for (const s of statuses) {
    log(formatStatusLine(s, { ...options, now }));
  }
}
