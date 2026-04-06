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
