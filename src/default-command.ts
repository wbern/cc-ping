import { listAccounts } from "./config.js";
import { findDuplicates } from "./identity.js";
import { formatStatusLine, getAccountStatuses } from "./status.js";

export function showDefault(
  log: (msg: string) => void = console.log,
  now: Date = new Date(),
): void {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    log("No accounts configured.");
    log("\nGet started:");
    log("  cc-ping scan        Auto-discover accounts");
    log("  cc-ping add <h> <d> Add an account manually");
    return;
  }

  const dupes = findDuplicates(accounts);
  const statuses = getAccountStatuses(accounts, now, dupes);
  for (const s of statuses) {
    log(formatStatusLine(s));
  }

  const needsPing = statuses.filter((s) => s.windowStatus !== "active");
  if (needsPing.length > 0) {
    log("");
    log("Suggested next steps:");
    const handles = needsPing.map((s) => s.handle).join(" ");
    if (needsPing.length < statuses.length) {
      log(`  cc-ping ping ${handles}   Ping accounts that need it`);
    } else {
      log("  cc-ping ping              Ping all accounts");
    }
    log("  cc-ping daemon start      Auto-ping on a schedule");
  }
}
