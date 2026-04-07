import { getWindowReset } from "./state.js";
import type { AccountConfig } from "./types.js";

export function filterAccounts(
  accounts: AccountConfig[],
  handles: string[],
): AccountConfig[] {
  if (handles.length === 0) return accounts;

  const unknown = handles.filter((h) => !accounts.some((a) => a.handle === h));
  if (unknown.length > 0) {
    throw new Error(`Unknown account(s): ${unknown.join(", ")}`);
  }

  const set = new Set(handles);
  return accounts.filter((a) => set.has(a.handle));
}

export function filterNeedsPing(
  accounts: AccountConfig[],
  now: Date = new Date(),
): AccountConfig[] {
  return accounts.filter((a) => !getWindowReset(a.handle, now));
}

export function filterByGroup(
  accounts: AccountConfig[],
  group: string | undefined,
): AccountConfig[] {
  if (!group) return accounts;

  const filtered = accounts.filter((a) => a.group === group);
  if (filtered.length === 0) {
    throw new Error(`No accounts in group: ${group}`);
  }
  return filtered;
}
