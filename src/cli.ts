import { Command } from "commander";
import {
  addAccount,
  listAccounts,
  removeAccount,
  saveConfig,
} from "./config.js";
import { formatHistoryEntry, readHistory } from "./history.js";
import { findDuplicates } from "./identity.js";
import { getNextReset } from "./next-reset.js";
import { setConfigDir } from "./paths.js";
import { runPing } from "./run-ping.js";
import { scanAccounts } from "./scan.js";
import { formatStatusLine, getAccountStatuses } from "./status.js";

declare const __VERSION__: string;

const program = new Command()
  .name("cc-ping")
  .description("Ping Claude Code sessions to trigger quota windows early")
  .version(__VERSION__)
  .option(
    "--config <path>",
    "Path to config directory (default: ~/.config/cc-ping, env: CC_PING_CONFIG)",
  )
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.config) {
      setConfigDir(opts.config);
    }
  });

program
  .command("ping")
  .description("Ping all configured accounts to start quota windows")
  .option("--parallel", "Ping all accounts in parallel", false)
  .option("-q, --quiet", "Suppress all output except errors (for cron)", false)
  .option("--json", "Output results as JSON", false)
  .action(async (opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.error(
        "No accounts configured. Run: cc-ping scan or cc-ping add <handle> <dir>",
      );
      process.exit(1);
    }
    const exitCode = await runPing(accounts, {
      parallel: opts.parallel,
      quiet: opts.quiet,
      json: opts.json,
    });
    process.exit(exitCode);
  });

program
  .command("scan")
  .description("Auto-discover accounts from ~/.claude-accounts/")
  .option("--dry-run", "Show what would be added without saving", false)
  .action((opts) => {
    const found = scanAccounts();
    if (found.length === 0) {
      console.log("No accounts found in ~/.claude-accounts/");
      return;
    }
    console.log(`Found ${found.length} account(s):`);
    for (const a of found) {
      console.log(`  ${a.handle} -> ${a.configDir}`);
    }
    if (!opts.dryRun) {
      saveConfig({ accounts: found });
      console.log("\nSaved to config.");
    }
    const dupes = findDuplicates(found);
    if (dupes.size > 0) {
      console.log(
        "\nWarning: duplicate accounts detected (same underlying identity):",
      );
      for (const group of dupes.values()) {
        console.log(`  ${group.handles.join(", ")} (${group.email})`);
      }
    }
  });

program
  .command("add")
  .description("Add an account manually")
  .argument("<handle>", "Account handle/name")
  .argument("<config-dir>", "Path to the CLAUDE_CONFIG_DIR for this account")
  .action((handle, configDir) => {
    addAccount(handle, configDir);
    console.log(`Added: ${handle} -> ${configDir}`);
  });

program
  .command("remove")
  .description("Remove an account")
  .argument("<handle>", "Account handle to remove")
  .action((handle) => {
    if (removeAccount(handle)) {
      console.log(`Removed: ${handle}`);
    } else {
      console.error(`Account not found: ${handle}`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List configured accounts")
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log(opts.json ? "[]" : "No accounts configured");
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(accounts, null, 2));
      return;
    }
    for (const a of accounts) {
      console.log(`  ${a.handle} -> ${a.configDir}`);
    }
  });

program
  .command("status")
  .description("Show status of all accounts with window information")
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log("No accounts configured");
      return;
    }
    const dupes = findDuplicates(accounts);
    const statuses = getAccountStatuses(accounts, new Date(), dupes);
    if (opts.json) {
      console.log(JSON.stringify(statuses, null, 2));
      return;
    }
    for (const s of statuses) {
      console.log(formatStatusLine(s));
    }
  });

program
  .command("next-reset")
  .description("Show which account has its quota window resetting soonest")
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log("No accounts configured");
      return;
    }
    const result = getNextReset(accounts);
    if (!result) {
      console.log("No active quota windows");
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `${result.handle}: resets in ${result.timeUntilReset} (${result.configDir})`,
    );
  });

program
  .command("history")
  .description("Show recent ping history")
  .option("--limit <n>", "Number of entries to show", "20")
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const limit = Number.parseInt(opts.limit, 10);
    const entries = readHistory(limit);
    if (entries.length === 0) {
      console.log(opts.json ? "[]" : "No ping history");
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    for (const entry of entries) {
      console.log(formatHistoryEntry(entry));
    }
  });

program.parse();
