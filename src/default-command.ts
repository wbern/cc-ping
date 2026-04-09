import { listAccounts } from "./config.js";
import { findDuplicates } from "./identity.js";
import { formatStatusLine, getAccountStatuses } from "./status.js";

export function showDefault(
  log: (msg: string) => void = console.log,
  now: Date = new Date(),
  deferredHandles?: Map<string, number>,
): void {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    log("No accounts configured.");
    log("\nGet started:");
    log("  cc-ping scan        Auto-discover accounts");
    log("  cc-ping add ~/.claude  Add an account manually");
    return;
  }

  const dupes = findDuplicates(accounts);
  const statuses = getAccountStatuses(accounts, now, dupes, deferredHandles);
  for (const s of statuses) {
    log(formatStatusLine(s));
  }

  const needsPing = statuses.filter((s) => s.windowStatus !== "active");
  if (needsPing.length > 0) {
    log("");
    log("Suggested next steps:");
    log("  cc-ping ping              Ping accounts that need it");
    log("  cc-ping daemon start      Auto-ping on a schedule");
  }
}
